// On-disk PDF storage: the user-configured folder is the source of truth.
// Raw-body store command, bounded range reads for PDF.js, and rename/move
// with collision-free naming.

use sha2::{Digest, Sha256};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredFileMetadata {
    size: u64,
    modified_ms: u64,
}

/// One materialized copy of a content blob: the name the caller asked for and
/// the (possibly suffixed) name actually written to disk.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredCopy {
    pub(crate) requested: String,
    pub(crate) stored: String,
}

pub(crate) fn file_modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

/// Writes `bytes` once per requested file name (collision-free), in the order
/// given, so callers can zip the result back onto their request list.
pub(crate) fn write_blob_copies(
    dir: &std::path::Path,
    file_names: &[String],
    bytes: &[u8],
) -> Result<Vec<StoredCopy>, String> {
    std::fs::create_dir_all(dir).map_err(|error| format!("Failed to create storage folder: {error}"))?;
    let mut copies = Vec::with_capacity(file_names.len());
    for file_name in file_names {
        let target = resolve_collision_free_path(dir, file_name, None);
        std::fs::write(&target, bytes).map_err(|error| format!("Failed to write PDF: {error}"))?;
        copies.push(StoredCopy {
            requested: file_name.clone(),
            stored: target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(file_name)
                .to_string(),
        });
    }
    Ok(copies)
}

/// Fills missing copies of a content-addressed blob from a local sibling: the
/// source is re-hashed before trusting it, and the bytes never leave Rust.
#[tauri::command]
pub(crate) async fn clone_stored_pdf(
    dir: String,
    source_file_name: String,
    expected_sha256: String,
    target_file_names: Vec<String>,
) -> Result<Vec<StoredCopy>, String> {
    validate_stored_file_name(&source_file_name)?;
    for name in &target_file_names {
        validate_stored_file_name(name)?;
    }
    let expected = expected_sha256.trim().to_ascii_lowercase();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::PathBuf::from(&dir);
        let source_path = dir.join(&source_file_name);
        let bytes = std::fs::read(&source_path)
            .map_err(|error| format!("Failed to read {}: {error}", source_path.display()))?;
        if hex::encode(Sha256::digest(&bytes)) != expected {
            return Err(format!("Local copy {source_file_name} no longer matches its content hash."));
        }
        write_blob_copies(&dir, &target_file_names, &bytes)
    })
    .await
    .map_err(|error| format!("PDF clone task failed: {error}"))?
}

pub(crate) fn resolve_stored_file_path(dir: &str, file_name: &str) -> Result<std::path::PathBuf, String> {
    validate_stored_file_name(file_name)?;
    let path = std::path::Path::new(dir).join(file_name);
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("File not found or unreadable ({}): {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    Ok(path)
}

const STORE_PDF_DIR_HEADER: &str = "x-lumora-dir";
const STORE_PDF_FILE_NAME_HEADER: &str = "x-lumora-file-name";

fn decode_command_header(headers: &tauri::http::HeaderMap, name: &str) -> Result<String, String> {
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

pub(crate) fn validate_stored_file_name(file_name: &str) -> Result<(), String> {
    if file_name.is_empty() || file_name.contains('/') || file_name.contains('\\') || file_name == "." || file_name == ".." {
        return Err(format!("Invalid file name: {file_name}"));
    }
    Ok(())
}

// Walks `name.pdf`, `name-2.pdf`, `name-3.pdf`, ... until a free slot. When the
// occupied candidate is the file being moved itself, reuse it so renaming a file
// to its current name is a no-op instead of drifting to a new suffix.
fn resolve_collision_free_path(dir: &std::path::Path, file_name: &str, current_path: Option<&std::path::Path>) -> std::path::PathBuf {
    let (stem, extension) = file_name
        .rsplit_once('.')
        .map(|(stem, extension)| (stem.to_string(), format!(".{extension}")))
        .unwrap_or_else(|| (file_name.to_string(), String::new()));

    let mut candidate = dir.join(file_name);
    let mut counter = 2;
    while candidate.exists() {
        let is_same_file = current_path.is_some_and(|current| {
            match (std::fs::canonicalize(&candidate), std::fs::canonicalize(current)) {
                (Ok(a), Ok(b)) => a == b,
                _ => false,
            }
        });
        if is_same_file {
            return candidate;
        }

        candidate = dir.join(format!("{stem}-{counter}{extension}"));
        counter += 1;
    }

    candidate
}

// Raw-body command: the PDF bytes come through the invoke body, so the directory
// and file name have to travel as (ASCII-only, hence percent-encoded) headers.
// Async + spawn_blocking: a synchronous command would write the whole PDF on
// the main thread and freeze the UI for large imports.
#[tauri::command]
pub(crate) async fn store_pdf(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(raw) = request.body() else {
        return Err("Expected a binary PDF payload.".to_string());
    };
    let bytes = raw.to_vec();

    let dir = decode_command_header(request.headers(), STORE_PDF_DIR_HEADER)?;
    let file_name = decode_command_header(request.headers(), STORE_PDF_FILE_NAME_HEADER)?;
    validate_stored_file_name(&file_name)?;

    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).map_err(|error| format!("Failed to create storage folder: {error}"))?;
        let target = resolve_collision_free_path(&dir, &file_name, None);
        std::fs::write(&target, &bytes).map_err(|error| format!("Failed to write PDF: {error}"))?;

        Ok(target.file_name().and_then(|name| name.to_str()).unwrap_or(&file_name).to_string())
    })
    .await
    .map_err(|error| format!("PDF store task failed: {error}"))?
}

// Lists the PDF file names currently in the storage folder so the front end can
// reconcile library records against what actually lives on disk (the folder is
// the source of truth for whether a paper has a local PDF). A missing folder is
// not an error: it just means nothing is stored yet.
#[tauri::command]
pub(crate) async fn list_stored_pdfs(dir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&dir);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let entries = std::fs::read_dir(path).map_err(|error| format!("Failed to read storage folder: {error}"))?;
        let mut names = Vec::new();
        for entry in entries.flatten() {
            if !entry.file_type().map(|file_type| file_type.is_file()).unwrap_or(false) {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                if name.to_ascii_lowercase().ends_with(".pdf") {
                    names.push(name.to_string());
                }
            }
        }
        Ok(names)
    })
    .await
    .map_err(|error| format!("Storage listing task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn read_stored_pdf(dir: String, file_name: String) -> Result<tauri::ipc::Response, String> {
    validate_stored_file_name(&file_name)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&dir).join(&file_name);
        std::fs::read(&path).map_err(|error| format!("Failed to read {}: {error}", path.display()))
    })
    .await
    .map_err(|error| format!("PDF read task failed: {error}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

const MAX_STORED_PDF_RANGE_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub(crate) async fn read_stored_pdf_range(
    dir: String,
    file_name: String,
    begin: u64,
    end: u64,
) -> Result<tauri::ipc::Response, String> {
    let path = resolve_stored_file_path(&dir, &file_name)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        read_stored_pdf_range_bytes(&path, begin, end)
    })
    .await
    .map_err(|error| format!("Failed to join PDF range read task: {error}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn read_stored_pdf_range_bytes(
    path: &std::path::Path,
    begin: u64,
    end: u64,
) -> Result<Vec<u8>, String> {
    if end <= begin {
        return Err("Invalid PDF byte range.".to_string());
    }
    if end - begin > MAX_STORED_PDF_RANGE_BYTES {
        return Err(format!(
            "PDF byte range exceeds the {} byte limit.",
            MAX_STORED_PDF_RANGE_BYTES
        ));
    }

    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let file_len = file
        .metadata()
        .map_err(|error| format!("Failed to stat {}: {error}", path.display()))?
        .len();
    if begin >= file_len {
        return Err(format!(
            "PDF byte range starts beyond end of file: {begin} >= {file_len}."
        ));
    }

    let bounded_end = end.min(file_len);
    let byte_count = usize::try_from(bounded_end - begin)
        .map_err(|_| "PDF byte range is too large for this platform.".to_string())?;
    let mut bytes = vec![0; byte_count];
    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(begin))
        .map_err(|error| format!("Failed to seek {}: {error}", path.display()))?;
    std::io::Read::read_exact(&mut file, &mut bytes)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    Ok(bytes)
}

#[tauri::command]
pub(crate) async fn stored_pdf_metadata(dir: String, file_name: String) -> Result<StoredFileMetadata, String> {
    validate_stored_file_name(&file_name)?;
    let path = std::path::Path::new(&dir).join(&file_name);
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("Failed to stat {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    Ok(StoredFileMetadata { size: metadata.len(), modified_ms: file_modified_ms(&metadata) })
}

#[tauri::command]
pub(crate) async fn delete_stored_pdf(dir: String, file_name: String) -> Result<(), String> {
    validate_stored_file_name(&file_name)?;
    let path = std::path::Path::new(&dir).join(&file_name);
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(&path).map_err(|error| format!("Failed to delete {}: {error}", path.display()))
}

// spawn_blocking keeps the retry sleep for cloud-synced folders off the async
// runtime's worker threads.
#[tauri::command]
pub(crate) async fn move_stored_pdf(dir: String, file_name: String, new_dir: String, new_file_name: String) -> Result<String, String> {
    validate_stored_file_name(&file_name)?;
    validate_stored_file_name(&new_file_name)?;

    tauri::async_runtime::spawn_blocking(move || {
        let old_path = std::path::Path::new(&dir).join(&file_name);
        if !old_path.exists() {
            return Err(format!("File not found: {}", old_path.display()));
        }

        let target_dir = std::path::PathBuf::from(&new_dir);
        std::fs::create_dir_all(&target_dir).map_err(|error| format!("Failed to create storage folder: {error}"))?;
        let target = resolve_collision_free_path(&target_dir, &new_file_name, Some(&old_path));

        if target != old_path {
            // Cloud-synced folders (Google Drive etc.) can transiently hold files;
            // retry once before surfacing the failure.
            if std::fs::rename(&old_path, &target).is_err() {
                std::thread::sleep(std::time::Duration::from_millis(300));
                std::fs::rename(&old_path, &target).map_err(|error| format!("Failed to move PDF: {error}"))?;
            }
        }

        Ok(target.file_name().and_then(|name| name.to_str()).unwrap_or(&new_file_name).to_string())
    })
    .await
    .map_err(|error| format!("PDF move task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{read_stored_pdf_range_bytes, resolve_stored_file_path, write_blob_copies, StoredCopy};

    #[test]
    fn writes_blob_copies_in_order_with_collision_free_names() {
        let directory = std::env::temp_dir().join(format!("lumora-blob-copies-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        // An occupied slot forces the suffix walker for the first target.
        std::fs::write(directory.join("paper.pdf"), b"occupied").unwrap();

        let copies = write_blob_copies(
            &directory,
            &["paper.pdf".to_string(), "other.pdf".to_string()],
            b"%PDF-1.4-shared",
        )
        .unwrap();

        assert_eq!(
            copies,
            vec![
                StoredCopy { requested: "paper.pdf".into(), stored: "paper-2.pdf".into() },
                StoredCopy { requested: "other.pdf".into(), stored: "other.pdf".into() },
            ]
        );
        assert_eq!(std::fs::read(directory.join("paper-2.pdf")).unwrap(), b"%PDF-1.4-shared");
        assert_eq!(std::fs::read(directory.join("other.pdf")).unwrap(), b"%PDF-1.4-shared");
        assert_eq!(std::fs::read(directory.join("paper.pdf")).unwrap(), b"occupied");

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn resolves_an_existing_stored_file_and_rejects_path_traversal() {
        let directory = std::env::temp_dir().join(format!(
            "lumora-file-action-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let file_path = directory.join("paper.pdf");
        std::fs::write(&file_path, b"%PDF-1.4").unwrap();

        assert_eq!(
            resolve_stored_file_path(directory.to_str().unwrap(), "paper.pdf").unwrap(),
            file_path
        );
        assert!(resolve_stored_file_path(directory.to_str().unwrap(), "../paper.pdf").is_err());
        assert!(resolve_stored_file_path(directory.to_str().unwrap(), "missing.pdf").is_err());

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reads_bounded_stored_pdf_ranges() {
        let directory = std::env::temp_dir().join(format!(
            "lumora-pdf-range-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let file_path = directory.join("paper.pdf");
        std::fs::write(&file_path, b"%PDF-1.4-range-data").unwrap();

        assert_eq!(
            read_stored_pdf_range_bytes(&file_path, 5, 10).unwrap(),
            b"1.4-r"
        );
        assert_eq!(
            read_stored_pdf_range_bytes(&file_path, 15, 100).unwrap(),
            b"data"
        );
        assert!(read_stored_pdf_range_bytes(&file_path, 4, 4).is_err());
        assert!(read_stored_pdf_range_bytes(&file_path, 100, 101).is_err());

        std::fs::remove_dir_all(directory).unwrap();
    }
}
