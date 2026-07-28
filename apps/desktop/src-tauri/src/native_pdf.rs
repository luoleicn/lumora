#[cfg(target_os = "linux")]
use lopdf::{
    Dictionary as PdfDictionary, Document as PdfDocument, LoadOptions as PdfLoadOptions,
    Object as PdfObject, ObjectId as PdfObjectId,
};
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::collections::HashMap;
use std::path::PathBuf;

const UPLOAD_ID_HEADER: &str = "x-lumora-pdf-upload-id";
const UPLOAD_RESET_HEADER: &str = "x-lumora-pdf-upload-reset";
#[cfg(target_os = "linux")]
const MAX_PDF_LINKS_PER_PAGE: usize = 2_000;
#[cfg(target_os = "linux")]
const MAX_PDF_LINKS_PER_DOCUMENT: usize = 50_000;
#[cfg(target_os = "linux")]
const MAX_PDF_OBJECT_STREAM_BYTES: usize = 16 * 1024 * 1024;
#[cfg(target_os = "linux")]
const MAX_PDF_LINK_PARSE_BYTES: usize = 256 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePdfPageInfo {
    width: f64,
    height: f64,
    links: Vec<NativePdfLink>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePdfDocumentInfo {
    session_id: String,
    pages: Vec<NativePdfPageInfo>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePdfSearchTarget {
    page_index: usize,
    page_match_index: usize,
    key: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePdfLink {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    target: NativePdfLinkTarget,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum NativePdfLinkTarget {
    Internal { page_index: usize },
    External { url: String },
}

// Async + spawn_blocking: opening a document reads, hashes and snapshots the
// whole file — as a synchronous command that all ran on the main thread and
// froze the window for large PDFs.
#[tauri::command]
pub(crate) async fn native_pdf_open_path(
    dir: String,
    file_name: String,
) -> Result<NativePdfDocumentInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_file_name(&file_name)?;
        let path = std::path::Path::new(&dir).join(&file_name);
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("Failed to open native PDF {}: {error}", path.display()))?;
        open_pdf_bytes(&bytes)
    })
    .await
    .map_err(|error| format!("Native PDF open task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn native_pdf_stage_chunk(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(raw) = request.body() else {
        return Err("Expected a binary PDF chunk.".to_string());
    };
    if raw.len() > 2 * 1024 * 1024 {
        return Err("Native PDF upload chunk is too large.".to_string());
    }
    let bytes = raw.to_vec();
    let upload_id = decode_header(request.headers(), UPLOAD_ID_HEADER)?;
    validate_upload_id(&upload_id)?;
    let reset = request
        .headers()
        .get(UPLOAD_RESET_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some("1");
    tauri::async_runtime::spawn_blocking(move || {
        let cache_dir = cache_dir();
        std::fs::create_dir_all(&cache_dir)
            .map_err(|error| format!("Failed to create native PDF cache: {error}"))?;
        let path = cache_dir.join(format!("upload-{upload_id}.tmp"));
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true);
        if reset {
            options.truncate(true);
        } else {
            options.append(true);
        }
        let mut file = options
            .open(&path)
            .map_err(|error| format!("Failed to stage native PDF chunk: {error}"))?;
        std::io::Write::write_all(&mut file, &bytes)
            .map_err(|error| format!("Failed to write native PDF chunk: {error}"))?;
        if file
            .metadata()
            .is_ok_and(|metadata| metadata.len() > 1024 * 1024 * 1024)
        {
            let _ = std::fs::remove_file(path);
            return Err("Native PDF exceeds the 1 GiB safety limit.".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Native PDF staging task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn native_pdf_open_upload(
    upload_id: String,
) -> Result<NativePdfDocumentInfo, String> {
    validate_upload_id(&upload_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = cache_dir().join(format!("upload-{upload_id}.tmp"));
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("Failed to finalize native PDF upload: {error}"))?;
        let result = if bytes.starts_with(b"%PDF-") {
            open_pdf_bytes(&bytes)
        } else {
            Err("Native renderer received invalid PDF data.".to_string())
        };
        let _ = std::fs::remove_file(path);
        result
    })
    .await
    .map_err(|error| format!("Native PDF finalize task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn native_pdf_render_page(
    session_id: String,
    page_number: u32,
    pixel_width: u32,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let pdf_path = session_path(&session_id)?;
        validate_page_number(page_number)?;
        let pixel_width = pixel_width.clamp(256, 8192);
        let page = page_number.to_string();
        let width = pixel_width.to_string();
        let output = std::process::Command::new("pdftocairo")
            .args([
                "-png",
                "-f",
                &page,
                "-l",
                &page,
                "-singlefile",
                "-scale-to-x",
                &width,
                "-scale-to-y",
                "-1",
            ])
            .arg(&pdf_path)
            .arg("-")
            .output()
            .map_err(|error| format!("Native PDF render service is unavailable: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Native PDF page render failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        if !output.stdout.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Native PDF renderer returned invalid image data.".to_string());
        }
        Ok(output.stdout)
    })
    .await
    .map_err(|error| format!("Native PDF render task failed: {error}"))??;

    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub(crate) async fn native_pdf_page_text(
    session_id: String,
    page_number: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pdf_path = session_path(&session_id)?;
        validate_page_number(page_number)?;
        let page = page_number.to_string();
        let output = std::process::Command::new("pdftotext")
            .args(["-f", &page, "-l", &page, "-bbox-layout"])
            .arg(&pdf_path)
            .arg("-")
            .output()
            .map_err(|error| format!("Native PDF text service is unavailable: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Native PDF text extraction failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        String::from_utf8(output.stdout)
            .map_err(|error| format!("Native PDF text is not valid UTF-8: {error}"))
    })
    .await
    .map_err(|error| format!("Native PDF text task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn native_pdf_search(
    session_id: String,
    query: String,
) -> Result<Vec<NativePdfSearchTarget>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pdf_path = session_path(&session_id)?;
        let query = query.trim().to_lowercase();
        if query.is_empty() || query.chars().count() > 256 {
            return Ok(Vec::new());
        }
        let output = std::process::Command::new("pdftotext")
            .arg("-layout")
            .arg(&pdf_path)
            .arg("-")
            .output()
            .map_err(|error| format!("Native PDF search service is unavailable: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Native PDF search failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut targets = Vec::new();
        for (page_index, page_text) in text.split('\x0c').enumerate() {
            let page_text = page_text.to_lowercase();
            let mut search_from = 0;
            let mut page_match_index = 0;
            while search_from < page_text.len() {
                let Some(position) = page_text[search_from..].find(&query) else {
                    break;
                };
                targets.push(NativePdfSearchTarget {
                    page_index,
                    page_match_index,
                    key: format!("native-pdf-search-target-{page_index}-{page_match_index}"),
                });
                page_match_index += 1;
                search_from += position + query.len();
            }
        }
        Ok(targets)
    })
    .await
    .map_err(|error| format!("Native PDF search task failed: {error}"))?
}

fn open_pdf_bytes(bytes: &[u8]) -> Result<NativePdfDocumentInfo, String> {
    let session_id = format!("{:x}", Sha256::digest(bytes));
    let cache_dir = cache_dir();
    std::fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Failed to create native PDF cache: {error}"))?;
    let pdf_path = cache_dir.join(format!("{session_id}.pdf"));
    if !pdf_path.exists() {
        let temporary_path = cache_dir.join(format!("{session_id}.tmp"));
        std::fs::write(&temporary_path, bytes)
            .map_err(|error| format!("Failed to stage native PDF: {error}"))?;
        std::fs::rename(&temporary_path, &pdf_path)
            .map_err(|error| format!("Failed to commit native PDF cache: {error}"))?;
    }

    let output = std::process::Command::new("pdfinfo")
        .args(["-f", "1", "-l", "100000"])
        .arg(&pdf_path)
        .output()
        .map_err(|error| format!("Native PDF metadata service is unavailable: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Native PDF metadata failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mut pages = parse_pages(&String::from_utf8_lossy(&output.stdout))?;
    #[cfg(target_os = "linux")]
    {
        match extract_document_links(bytes, &pages) {
            Ok(page_links) => {
                for (page, links) in pages.iter_mut().zip(page_links) {
                    page.links = links;
                }
            }
            Err(error) => {
                eprintln!("Native PDF link extraction unavailable for {session_id}: {error}");
            }
        }
    }
    Ok(NativePdfDocumentInfo { session_id, pages })
}

fn session_path(session_id: &str) -> Result<PathBuf, String> {
    if session_id.len() != 64 || !session_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid native PDF session.".to_string());
    }
    let path = cache_dir().join(format!("{session_id}.pdf"));
    if !path.is_file() {
        return Err("Native PDF session has expired.".to_string());
    }
    Ok(path)
}

fn parse_pages(output: &str) -> Result<Vec<NativePdfPageInfo>, String> {
    let page_count = output
        .lines()
        .find_map(|line| line.strip_prefix("Pages:")?.trim().parse::<usize>().ok())
        .ok_or_else(|| "Native PDF metadata did not include a page count.".to_string())?;
    if page_count == 0 || page_count > 100_000 {
        return Err("Native PDF page count is outside the supported range.".to_string());
    }

    let size_pattern = regex::Regex::new(
        r"^Page\s+(\d+)\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts",
    )
    .map_err(|error| error.to_string())?;
    let mut pages = (0..page_count)
        .map(|_| NativePdfPageInfo {
            width: 612.0,
            height: 792.0,
            links: Vec::new(),
        })
        .collect::<Vec<_>>();
    let mut parsed_sizes = 0;
    for line in output.lines() {
        let Some(captures) = size_pattern.captures(line) else {
            continue;
        };
        let Some(index) = captures
            .get(1)
            .and_then(|value| value.as_str().parse::<usize>().ok())
            .and_then(|page| page.checked_sub(1))
        else {
            continue;
        };
        let width = captures
            .get(2)
            .and_then(|value| value.as_str().parse::<f64>().ok());
        let height = captures
            .get(3)
            .and_then(|value| value.as_str().parse::<f64>().ok());
        if let (Some(page), Some(width), Some(height)) = (pages.get_mut(index), width, height) {
            if width.is_finite() && width > 0.0 && height.is_finite() && height > 0.0 {
                *page = NativePdfPageInfo {
                    width,
                    height,
                    links: Vec::new(),
                };
                parsed_sizes += 1;
            }
        }
    }
    if parsed_sizes == 0 {
        return Err("Native PDF metadata did not include page dimensions.".to_string());
    }
    Ok(pages)
}

#[cfg(target_os = "linux")]
mod link_extraction {
use super::*;

#[derive(Clone, Copy)]
pub(super) struct PdfPageGeometry {
    pub(super) left: f64,
    pub(super) bottom: f64,
    pub(super) right: f64,
    pub(super) top: f64,
    pub(super) rotation: i64,
}

pub(super) fn extract_document_links(
    bytes: &[u8],
    page_infos: &[NativePdfPageInfo],
) -> Result<Vec<Vec<NativePdfLink>>, String> {
    if bytes.len() > MAX_PDF_LINK_PARSE_BYTES {
        return Err("PDF is too large for safe in-process link extraction.".to_string());
    }
    // Only navigation dictionaries are needed here. Discard page/image stream
    // bodies while loading, but retain object streams because they can contain
    // compressed page and annotation dictionaries.
    let document = PdfDocument::load_mem_with_options(
        bytes,
        PdfLoadOptions {
            filter: Some(strip_irrelevant_pdf_streams),
            max_decompressed_size: Some(MAX_PDF_OBJECT_STREAM_BYTES),
            ..Default::default()
        },
    )
    .map_err(|error| format!("Failed to parse PDF link annotations: {error}"))?;
    Ok(extract_links_from_pdf(&document, page_infos))
}

fn strip_irrelevant_pdf_streams(
    object_id: PdfObjectId,
    object: &mut PdfObject,
) -> Option<(PdfObjectId, PdfObject)> {
    if let PdfObject::Stream(stream) = object {
        let stream_type = stream.dict.get_type().unwrap_or_default();
        if !matches!(stream_type, b"ObjStm" | b"XRef") {
            stream.content.clear();
        }
    }
    Some((object_id, object.clone()))
}

fn extract_links_from_pdf(
    document: &PdfDocument,
    page_infos: &[NativePdfPageInfo],
) -> Vec<Vec<NativePdfLink>> {
    let pages = document.get_pages();
    let page_ids = pages.values().copied().collect::<Vec<_>>();
    let page_indexes = page_ids
        .iter()
        .enumerate()
        .map(|(index, object_id)| (*object_id, index))
        .collect::<HashMap<_, _>>();
    let named_destinations = collect_named_destinations(document);
    let mut result = vec![Vec::new(); page_infos.len()];
    let mut document_link_count = 0;

    for (page_index, page_id) in page_ids.into_iter().enumerate() {
        let Some(page_info) = page_infos.get(page_index) else {
            break;
        };
        let geometry = page_geometry(document, page_id, page_info);
        let mut page_links = Vec::new();
        for annotation in page_annotations(document, page_id) {
            if annotation
                .get_deref(b"Subtype", document)
                .and_then(PdfObject::as_name)
                .ok()
                != Some(b"Link")
            {
                continue;
            }
            let Some(target) = annotation_target(
                document,
                annotation,
                page_index,
                page_infos.len(),
                &page_indexes,
                &named_destinations,
            ) else {
                continue;
            };
            for rect in annotation_rectangles(document, annotation) {
                let Some((x, y, width, height)) = normalize_pdf_rect(rect, geometry) else {
                    continue;
                };
                page_links.push(NativePdfLink {
                    x,
                    y,
                    width,
                    height,
                    target: target.clone(),
                });
                document_link_count += 1;
                if page_links.len() >= MAX_PDF_LINKS_PER_PAGE
                    || document_link_count >= MAX_PDF_LINKS_PER_DOCUMENT
                {
                    break;
                }
            }
            if page_links.len() >= MAX_PDF_LINKS_PER_PAGE
                || document_link_count >= MAX_PDF_LINKS_PER_DOCUMENT
            {
                break;
            }
        }
        result[page_index] = page_links;
        if document_link_count >= MAX_PDF_LINKS_PER_DOCUMENT {
            break;
        }
    }

    result
}

fn page_annotations<'a>(
    document: &'a PdfDocument,
    page_id: PdfObjectId,
) -> Vec<&'a PdfDictionary> {
    let Some(annotations) = document
        .get_dictionary(page_id)
        .ok()
        .and_then(|page| page.get_deref(b"Annots", document).ok())
        .and_then(|object| object.as_array().ok())
    else {
        return Vec::new();
    };

    annotations
        .iter()
        .filter_map(|object| document.dereference(object).ok())
        .filter_map(|(_, object)| object.as_dict().ok())
        .collect()
}

fn annotation_target(
    document: &PdfDocument,
    annotation: &PdfDictionary,
    source_page_index: usize,
    page_count: usize,
    page_indexes: &HashMap<PdfObjectId, usize>,
    named_destinations: &HashMap<Vec<u8>, PdfObject>,
) -> Option<NativePdfLinkTarget> {
    if let Ok(destination) = annotation.get(b"Dest") {
        return resolve_internal_destination(
            document,
            destination,
            page_indexes,
            named_destinations,
            0,
        )
        .map(|page_index| NativePdfLinkTarget::Internal { page_index });
    }

    let action = annotation
        .get_deref(b"A", document)
        .ok()
        .and_then(|object| object.as_dict().ok())?;
    match action
        .get_deref(b"S", document)
        .and_then(PdfObject::as_name)
        .ok()?
    {
        b"URI" => {
            let raw_url = action
                .get_deref(b"URI", document)
                .ok()
                .and_then(pdf_object_bytes)?;
            let candidate = String::from_utf8_lossy(raw_url);
            let url = reqwest::Url::parse(candidate.trim()).ok()?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return None;
            }
            Some(NativePdfLinkTarget::External {
                url: url.to_string(),
            })
        }
        b"GoTo" => resolve_internal_destination(
            document,
            action.get(b"D").ok()?,
            page_indexes,
            named_destinations,
            0,
        )
        .map(|page_index| NativePdfLinkTarget::Internal { page_index }),
        b"Named" => {
            let name = action
                .get_deref(b"N", document)
                .ok()
                .and_then(pdf_object_bytes)?;
            let page_index = match name {
                b"FirstPage" => 0,
                b"LastPage" => page_count.checked_sub(1)?,
                b"NextPage" => (source_page_index + 1).min(page_count.checked_sub(1)?),
                b"PrevPage" => source_page_index.saturating_sub(1),
                _ => return None,
            };
            Some(NativePdfLinkTarget::Internal { page_index })
        }
        _ => None,
    }
}

fn resolve_internal_destination(
    document: &PdfDocument,
    destination: &PdfObject,
    page_indexes: &HashMap<PdfObjectId, usize>,
    named_destinations: &HashMap<Vec<u8>, PdfObject>,
    depth: usize,
) -> Option<usize> {
    if depth >= 16 {
        return None;
    }
    let (_, destination) = document.dereference(destination).ok()?;
    match destination {
        PdfObject::Array(items) => match items.first()? {
            PdfObject::Reference(page_id) => page_indexes.get(page_id).copied(),
            PdfObject::Integer(page_index) if *page_index >= 0 => {
                let page_index = *page_index as usize;
                (page_index < page_indexes.len()).then_some(page_index)
            }
            _ => None,
        },
        PdfObject::Dictionary(dictionary) => resolve_internal_destination(
            document,
            dictionary.get(b"D").ok()?,
            page_indexes,
            named_destinations,
            depth + 1,
        ),
        PdfObject::Name(name) | PdfObject::String(name, _) => resolve_internal_destination(
            document,
            named_destinations.get(name)?,
            page_indexes,
            named_destinations,
            depth + 1,
        ),
        _ => None,
    }
}

fn collect_named_destinations(document: &PdfDocument) -> HashMap<Vec<u8>, PdfObject> {
    let mut destinations = HashMap::new();
    let Ok(catalog) = document.catalog() else {
        return destinations;
    };

    if let Ok(legacy) = catalog
        .get_deref(b"Dests", document)
        .and_then(PdfObject::as_dict)
    {
        for (name, destination) in legacy.iter() {
            destinations.insert(name.clone(), destination.clone());
        }
    }
    if let Ok(names) = catalog
        .get_deref(b"Names", document)
        .and_then(PdfObject::as_dict)
    {
        if let Ok(tree) = names
            .get_deref(b"Dests", document)
            .and_then(PdfObject::as_dict)
        {
            collect_destination_name_tree(document, tree, &mut destinations, 0);
        }
    }

    destinations
}

fn collect_destination_name_tree(
    document: &PdfDocument,
    tree: &PdfDictionary,
    destinations: &mut HashMap<Vec<u8>, PdfObject>,
    depth: usize,
) {
    if depth >= 32 {
        return;
    }
    if let Ok(names) = tree
        .get_deref(b"Names", document)
        .and_then(PdfObject::as_array)
    {
        for pair in names.chunks_exact(2) {
            if let Some(name) = pdf_object_bytes(&pair[0]) {
                destinations.insert(name.to_vec(), pair[1].clone());
            }
        }
    }
    if let Ok(kids) = tree
        .get_deref(b"Kids", document)
        .and_then(PdfObject::as_array)
    {
        for kid in kids {
            if let Ok((_, PdfObject::Dictionary(kid))) = document.dereference(kid) {
                collect_destination_name_tree(document, kid, destinations, depth + 1);
            }
        }
    }
}

fn annotation_rectangles(
    document: &PdfDocument,
    annotation: &PdfDictionary,
) -> Vec<[f64; 4]> {
    if let Ok(points) = annotation
        .get_deref(b"QuadPoints", document)
        .and_then(PdfObject::as_array)
    {
        let rectangles = points
            .chunks_exact(8)
            .filter_map(|quad| {
                let values = quad
                    .iter()
                    .map(pdf_object_number)
                    .collect::<Option<Vec<_>>>()?;
                Some([
                    values.iter().step_by(2).copied().fold(f64::INFINITY, f64::min),
                    values
                        .iter()
                        .skip(1)
                        .step_by(2)
                        .copied()
                        .fold(f64::INFINITY, f64::min),
                    values
                        .iter()
                        .step_by(2)
                        .copied()
                        .fold(f64::NEG_INFINITY, f64::max),
                    values
                        .iter()
                        .skip(1)
                        .step_by(2)
                        .copied()
                        .fold(f64::NEG_INFINITY, f64::max),
                ])
            })
            .collect::<Vec<_>>();
        if !rectangles.is_empty() {
            return rectangles;
        }
    }

    annotation
        .get_deref(b"Rect", document)
        .and_then(PdfObject::as_array)
        .ok()
        .and_then(|rect| {
            (rect.len() >= 4).then(|| {
                Some([
                    pdf_object_number(&rect[0])?,
                    pdf_object_number(&rect[1])?,
                    pdf_object_number(&rect[2])?,
                    pdf_object_number(&rect[3])?,
                ])
            })?
        })
        .into_iter()
        .collect()
}

fn page_geometry(
    document: &PdfDocument,
    page_id: PdfObjectId,
    page_info: &NativePdfPageInfo,
) -> PdfPageGeometry {
    let rotation = inherited_page_object(document, page_id, b"Rotate")
        .and_then(|object| object.as_i64().ok())
        .map(|rotation| rotation.rem_euclid(360))
        .filter(|rotation| rotation % 90 == 0)
        .unwrap_or(0);
    let fallback_width = if matches!(rotation, 90 | 270) {
        page_info.height
    } else {
        page_info.width
    };
    let fallback_height = if matches!(rotation, 90 | 270) {
        page_info.width
    } else {
        page_info.height
    };
    let media_box = inherited_page_object(document, page_id, b"MediaBox")
        .and_then(|object| object.as_array().ok())
        .and_then(|items| {
            (items.len() >= 4).then(|| {
                Some([
                    pdf_object_number(&items[0])?,
                    pdf_object_number(&items[1])?,
                    pdf_object_number(&items[2])?,
                    pdf_object_number(&items[3])?,
                ])
            })?
        })
        .unwrap_or([0.0, 0.0, fallback_width, fallback_height]);
    PdfPageGeometry {
        left: media_box[0].min(media_box[2]),
        bottom: media_box[1].min(media_box[3]),
        right: media_box[0].max(media_box[2]),
        top: media_box[1].max(media_box[3]),
        rotation,
    }
}

fn inherited_page_object<'a>(
    document: &'a PdfDocument,
    page_id: PdfObjectId,
    key: &[u8],
) -> Option<&'a PdfObject> {
    let mut current_id = page_id;
    for _ in 0..32 {
        let dictionary = document.get_dictionary(current_id).ok()?;
        if let Ok(object) = dictionary.get(key) {
            return document.dereference(object).ok().map(|(_, object)| object);
        }
        current_id = dictionary.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

pub(super) fn normalize_pdf_rect(
    rect: [f64; 4],
    geometry: PdfPageGeometry,
) -> Option<(f64, f64, f64, f64)> {
    if !rect.into_iter().all(f64::is_finite) {
        return None;
    }
    let page_width = geometry.right - geometry.left;
    let page_height = geometry.top - geometry.bottom;
    if page_width <= 0.0 || page_height <= 0.0 {
        return None;
    }
    let left = rect[0].min(rect[2]).clamp(geometry.left, geometry.right);
    let right = rect[0].max(rect[2]).clamp(geometry.left, geometry.right);
    let bottom = rect[1]
        .min(rect[3])
        .clamp(geometry.bottom, geometry.top);
    let top = rect[1]
        .max(rect[3])
        .clamp(geometry.bottom, geometry.top);
    if right <= left || top <= bottom {
        return None;
    }

    let normalized = match geometry.rotation {
        90 => (
            (bottom - geometry.bottom) / page_height,
            (left - geometry.left) / page_width,
            (top - bottom) / page_height,
            (right - left) / page_width,
        ),
        180 => (
            (geometry.right - right) / page_width,
            (bottom - geometry.bottom) / page_height,
            (right - left) / page_width,
            (top - bottom) / page_height,
        ),
        270 => (
            (geometry.top - top) / page_height,
            (geometry.right - right) / page_width,
            (top - bottom) / page_height,
            (right - left) / page_width,
        ),
        _ => (
            (left - geometry.left) / page_width,
            (geometry.top - top) / page_height,
            (right - left) / page_width,
            (top - bottom) / page_height,
        ),
    };
    Some(normalized)
}

fn pdf_object_number(object: &PdfObject) -> Option<f64> {
    object.as_float().ok().map(f64::from).filter(|value| value.is_finite())
}

fn pdf_object_bytes(object: &PdfObject) -> Option<&[u8]> {
    object.as_str().or_else(|_| object.as_name()).ok()
}
}

#[cfg(target_os = "linux")]
use link_extraction::extract_document_links;

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("lumora-native-pdf-v1")
}

fn validate_page_number(page_number: u32) -> Result<(), String> {
    if (1..=100_000).contains(&page_number) {
        Ok(())
    } else {
        Err("Invalid native PDF page number.".to_string())
    }
}

fn validate_file_name(file_name: &str) -> Result<(), String> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name == "."
        || file_name == ".."
    {
        return Err(format!("Invalid file name: {file_name}"));
    }
    Ok(())
}

fn validate_upload_id(upload_id: &str) -> Result<(), String> {
    if upload_id.is_empty()
        || upload_id.len() > 64
        || !upload_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid native PDF upload identifier.".to_string());
    }
    Ok(())
}

fn decode_header(headers: &tauri::http::HeaderMap, name: &str) -> Result<String, String> {
    let value = headers
        .get(name)
        .ok_or_else(|| format!("Missing {name} header."))?
        .to_str()
        .map_err(|_| format!("Invalid {name} header."))?;
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .map(|decoded| decoded.to_string())
        .map_err(|_| format!("Invalid {name} header encoding."))
}

#[cfg(test)]
mod tests {
    use super::{parse_pages, validate_upload_id};
    #[cfg(target_os = "linux")]
    use super::{
        extract_document_links, link_extraction::normalize_pdf_rect,
        link_extraction::PdfPageGeometry, NativePdfLinkTarget, NativePdfPageInfo,
    };
    #[cfg(target_os = "linux")]
    use lopdf::{dictionary, Document, Object};

    #[test]
    fn parses_page_dimensions() {
        let pages = parse_pages(
            "Pages:           2\nPage    1 size:  612 x 792 pts (letter)\nPage    2 size:  841.89 x 595.276 pts\n",
        )
        .unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].width, 612.0);
        assert_eq!(pages[0].height, 792.0);
        assert_eq!(pages[1].width, 841.89);
        assert_eq!(pages[1].height, 595.276);
    }

    #[test]
    fn rejects_path_like_upload_identifiers() {
        assert!(validate_upload_id("c6a-test_1").is_ok());
        assert!(validate_upload_id("../escape").is_err());
        assert!(validate_upload_id("").is_err());
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn extracts_exact_rectangles_for_all_supported_link_targets() {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let first_page_id = document.new_object_id();
        let second_page_id = document.new_object_id();
        let external_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "Rect" => vec![60.into(), 700.into(), 300.into(), 730.into()],
            "A" => dictionary! {
                "S" => "URI",
                "URI" => Object::string_literal("https://example.com/paper?section=2"),
            },
        });
        let internal_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "Rect" => vec![60.into(), 650.into(), 200.into(), 680.into()],
            "Dest" => vec![second_page_id.into(), "Fit".into()],
        });
        let blank_region_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "Rect" => vec![320.into(), 600.into(), 500.into(), 640.into()],
            "A" => dictionary! {
                "S" => "URI",
                "URI" => Object::string_literal("https://example.com/image-link"),
            },
        });
        let named_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "Rect" => vec![60.into(), 550.into(), 200.into(), 580.into()],
            "Dest" => Object::Name(b"chapter".to_vec()),
        });
        let unsafe_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "Rect" => vec![60.into(), 500.into(), 200.into(), 530.into()],
            "A" => dictionary! {
                "S" => "URI",
                "URI" => Object::string_literal("javascript:alert(1)"),
            },
        });
        document.objects.insert(
            first_page_id,
            dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
                "Annots" => vec![
                    external_id.into(),
                    internal_id.into(),
                    blank_region_id.into(),
                    named_id.into(),
                    unsafe_id.into(),
                ],
            }
            .into(),
        );
        document.objects.insert(
            second_page_id,
            dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
            }
            .into(),
        );
        document.objects.insert(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![first_page_id.into(), second_page_id.into()],
                "Count" => 2,
            }
            .into(),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
            "Dests" => dictionary! {
                "chapter" => vec![second_page_id.into(), "Fit".into()],
            },
        });
        document.trailer.set("Root", catalog_id);

        let page_infos = vec![
            NativePdfPageInfo {
                width: 600.0,
                height: 800.0,
                links: Vec::new(),
            },
            NativePdfPageInfo {
                width: 600.0,
                height: 800.0,
                links: Vec::new(),
            },
        ];
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        let links = extract_document_links(&bytes, &page_infos).unwrap();

        assert_eq!(links[0].len(), 4);
        assert!(matches!(
            &links[0][0].target,
            NativePdfLinkTarget::External { url }
                if url == "https://example.com/paper?section=2"
        ));
        assert!(matches!(
            links[0][1].target,
            NativePdfLinkTarget::Internal { page_index: 1 }
        ));
        assert!(matches!(
            &links[0][2].target,
            NativePdfLinkTarget::External { url }
                if url == "https://example.com/image-link"
        ));
        assert!(matches!(
            links[0][3].target,
            NativePdfLinkTarget::Internal { page_index: 1 }
        ));
        assert!((links[0][0].x - 0.1).abs() < 1e-9);
        assert!((links[0][0].y - 0.0875).abs() < 1e-9);
        assert!((links[0][2].width - 0.3).abs() < 1e-9);
        assert!(links[1].is_empty());
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn rotates_link_rectangles_into_display_coordinates() {
        let geometry = PdfPageGeometry {
            left: 0.0,
            bottom: 0.0,
            right: 600.0,
            top: 800.0,
            rotation: 90,
        };
        let rect = normalize_pdf_rect([60.0, 600.0, 180.0, 700.0], geometry).unwrap();

        assert_eq!(rect, (0.75, 0.1, 0.125, 0.2));
    }
}
