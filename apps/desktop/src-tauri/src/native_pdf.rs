use sha2::{Digest, Sha256};
use std::path::PathBuf;

const UPLOAD_ID_HEADER: &str = "x-lumora-pdf-upload-id";
const UPLOAD_RESET_HEADER: &str = "x-lumora-pdf-upload-reset";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePdfPageInfo {
    width: f64,
    height: f64,
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
    let pages = parse_pages(&String::from_utf8_lossy(&output.stdout))?;
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
                *page = NativePdfPageInfo { width, height };
                parsed_sizes += 1;
            }
        }
    }
    if parsed_sizes == 0 {
        return Err("Native PDF metadata did not include page dimensions.".to_string());
    }
    Ok(pages)
}

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
}
