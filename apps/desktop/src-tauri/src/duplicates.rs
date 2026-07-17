// Duplicate download cleanup: hash-groups the storage folder, keeps the
// most-referenced copy per group, and re-points library records.

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime};

// --- Duplicate download cleanup -----------------------------------------------

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DuplicateGroupFile {
    file_name: String,
    size: u64,
    kept: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    referenced_by: Vec<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DuplicateGroup {
    sha256: String,
    files: Vec<DuplicateGroupFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_copies: Option<usize>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupDuplicateSummary {
    dir: String,
    total_files_scanned: usize,
    unique_hashes: usize,
    duplicate_groups: Vec<DuplicateGroup>,
    files_removed: usize,
    bytes_freed: u64,
    library_records_updated: usize,
    dry_run: bool,
    errors: Vec<String>,
}

/// Scans the configured file-storage folder for .pdf files with duplicate
/// content (same SHA-256). For each duplicate group, keeps the file that is
/// referenced by the most library records (falling back to the simplest name)
/// and removes the rest. Library `fileAsset` rows that pointed to a removed
/// file are updated to point to the kept file.
#[tauri::command]
pub(crate) async fn cleanup_duplicate_downloads(
    app: AppHandle,
    dir: String,
    dry_run: bool,
) -> Result<CleanupDuplicateSummary, String> {
    let dir_path = std::path::Path::new(&dir);
    if !dir_path.is_dir() {
        return Err(format!("Not a directory or does not exist: {dir}"));
    }

    let mut errors: Vec<String> = Vec::new();

    // 1. Enumerate .pdf files in the folder.
    let entries = match std::fs::read_dir(dir_path) {
        Ok(entries) => entries,
        Err(error) => return Err(format!("Failed to read directory {dir}: {error}")),
    };

    let mut pdfs: Vec<(String, u64)> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(".pdf") {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        pdfs.push((name, size));
    }

    let total_files_scanned = pdfs.len();
    if total_files_scanned <= 1 {
        return Ok(CleanupDuplicateSummary {
            dir: dir.to_string(),
            total_files_scanned,
            unique_hashes: total_files_scanned,
            duplicate_groups: Vec::new(),
            files_removed: 0,
            bytes_freed: 0,
            library_records_updated: 0,
            dry_run,
            errors,
        });
    }

    // 2. Compute SHA-256 for each file (streamed, 64 KiB buffer).
    let mut hash_to_files: std::collections::HashMap<String, Vec<(String, u64)>> =
        std::collections::HashMap::new();

    for (name, size) in &pdfs {
        let path = dir_path.join(name);
        let hash = match compute_file_sha256(&path).await {
            Ok(h) => h,
            Err(error) => {
                errors.push(format!("Skipping {name}: {error}"));
                continue;
            }
        };
        hash_to_files
            .entry(hash)
            .or_default()
            .push((name.clone(), *size));
    }

    let unique_hashes = hash_to_files.len();
    let duplicate_groups_raw: Vec<_> = hash_to_files
        .into_iter()
        .filter(|(_, files)| files.len() > 1)
        .collect();

    if duplicate_groups_raw.is_empty() {
        return Ok(CleanupDuplicateSummary {
            dir: dir.to_string(),
            total_files_scanned,
            unique_hashes,
            duplicate_groups: Vec::new(),
            files_removed: 0,
            bytes_freed: 0,
            library_records_updated: 0,
            dry_run,
            errors,
        });
    }

    // 3. Open the library DB once and build a file_name -> [paper titles] map.
    let file_references = match build_file_reference_map(&app, &dir) {
        Ok(m) => m,
        Err(error) => {
            errors.push(format!("Library lookup failed: {error}"));
            std::collections::HashMap::new()
        }
    };

    // 4. Decide keepers and build the result.
    let mut files_to_remove: Vec<(String, u64)> = Vec::new();
    let mut files_to_keep: Vec<String> = Vec::new();
    let mut library_records_updated: usize = 0;
    let mut duplicate_groups: Vec<DuplicateGroup> = Vec::new();

    for (sha256, mut files) in duplicate_groups_raw {
        let total_copies = files.len();

        // Sort by keeper priority:
        //   (a) most library references first,
        //   (b) then by no collision suffix (`name.pdf` beats `name-2.pdf`),
        //   (c) then by shorter name,
        //   (d) then by name alphabetically.
        files.sort_by(|a, b| {
            let refs_a = file_references.get(&a.0).map_or(0, |v| v.len());
            let refs_b = file_references.get(&b.0).map_or(0, |v| v.len());
            refs_b
                .cmp(&refs_a)
                .then_with(|| is_collision_suffixed(&a.0).cmp(&is_collision_suffixed(&b.0)))
                .then_with(|| a.0.len().cmp(&b.0.len()))
                .then_with(|| a.0.cmp(&b.0))
        });

        let keeper = &files[0];
        files_to_keep.push(keeper.0.clone());
        let group_files: Vec<DuplicateGroupFile> = files
            .iter()
            .map(|(name, size)| {
                let refs = file_references.get(name).cloned().unwrap_or_default();
                DuplicateGroupFile {
                    file_name: name.clone(),
                    size: *size,
                    kept: name == &keeper.0,
                    referenced_by: refs,
                }
            })
            .collect();

        // Track removals.
        for (name, size) in &files[1..] {
            files_to_remove.push((name.clone(), *size));
            // Plan library record updates for references to removed files.
            if let Some(refs) = file_references.get(name) {
                library_records_updated += refs.len();
            }
        }

        duplicate_groups.push(DuplicateGroup {
            sha256,
            files: group_files,
            total_copies: Some(total_copies),
        });
    }

    let bytes_freed: u64 = files_to_remove.iter().map(|(_, size)| size).sum();

    // 5. Execute (unless dry-run).
    if !dry_run {
        // Delete duplicate files from disk.
        for (name, _) in &files_to_remove {
            let path = dir_path.join(name);
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) => errors.push(format!("Failed to delete {name}: {error}")),
            }
        }

        // Update library records: any fileAsset whose localPath/fileName
        // pointed to a removed file now points to the group's keeper.
        if library_records_updated > 0 {
            if let Err(error) = update_library_to_keeper(&app, &dir, &duplicate_groups) {
                errors.push(format!("Library record update failed: {error}"));
            }
        }
    }

    // Sort groups: largest duplication first.
    duplicate_groups.sort_by(|a, b| b.files.len().cmp(&a.files.len()));

    Ok(CleanupDuplicateSummary {
        dir: dir.to_string(),
        total_files_scanned,
        unique_hashes,
        duplicate_groups,
        files_removed: files_to_remove.len(),
        bytes_freed,
        library_records_updated: if dry_run { 0 } else { library_records_updated },
        dry_run,
        errors,
    })
}

/// Streams a file's content through SHA-256, using a 64 KiB buffer.
async fn compute_file_sha256(path: &std::path::Path) -> Result<String, String> {
    let path = path.to_path_buf();
    // Run hashing on a blocking thread so we never starve the async runtime
    // for large PDFs (some papers are 50+ MiB).
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path)
            .map_err(|error| format!("Cannot open {}: {error}", path.display()))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = std::io::Read::read(&mut file, &mut buffer)
                .map_err(|error| format!("Read error on {}: {error}", path.display()))?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Returns true when `name` looks like a collision-suffixed file, e.g.
/// `title-2.pdf`, `paper-12.pdf`.
fn is_collision_suffixed(name: &str) -> bool {
    let stem = name.strip_suffix(".pdf").unwrap_or(name);
    // Must contain "-\d+" at the end of the stem.
    if let Some((_base, suffix)) = stem.rsplit_once('-') {
        suffix.chars().all(|c| c.is_ascii_digit()) && !suffix.is_empty()
    } else {
        false
    }
}

/// Builds a map from on-disk file name -> [paper titles] by reading the SQLite
/// library. Used so the keeper selection prefers files that are actually
/// referenced by library records.
fn build_file_reference_map<R: Runtime>(
    app: &AppHandle<R>,
    _dir: &str,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let connection = crate::db::open_library_db(app)?;
    let mut statement = connection
        .prepare(
            "SELECT file.data, paper.data
             FROM entities AS file
             JOIN entities AS paper
               ON paper.entity_type = 'paper'
              AND paper.id = json_extract(file.data, '$.paperId')
            WHERE file.entity_type = 'fileAsset'
              AND json_extract(file.data, '$.deletedAt') IS NULL
              AND json_extract(paper.data, '$.deletedAt') IS NULL
              AND json_extract(file.data, '$.localPath') IS NOT NULL",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;

    let mut map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for row in rows.flatten() {
        let (file_json, paper_json) = row;
        let local_path = serde_json::from_str::<serde_json::Value>(&file_json)
            .ok()
            .and_then(|v| v.get("localPath")?.as_str().map(String::from))
            .or_else(|| {
                serde_json::from_str::<serde_json::Value>(&file_json)
                    .ok()
                    .and_then(|v| v.get("fileName")?.as_str().map(String::from))
            });
        let title = serde_json::from_str::<serde_json::Value>(&paper_json)
            .ok()
            .and_then(|v| v.get("title")?.as_str().map(String::from))
            .unwrap_or_else(|| "(untitled)".to_string());

        if let Some(name) = local_path {
            map.entry(name).or_default().push(title);
        }
    }

    Ok(map)
}

/// For each duplicate group, re-points `fileAsset` records that referenced a
/// removed file to the group's kept file.
fn update_library_to_keeper<R: Runtime>(
    app: &AppHandle<R>,
    _dir: &str,
    groups: &[DuplicateGroup],
) -> Result<(), String> {
    let mut connection = crate::db::open_library_db(app)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;

    for group in groups {
        let keeper_name = match group.files.iter().find(|f| f.kept) {
            Some(f) => &f.file_name,
            None => continue,
        };
        let removed_names: Vec<&str> = group
            .files
            .iter()
            .filter(|f| !f.kept)
            .map(|f| f.file_name.as_str())
            .collect();
        if removed_names.is_empty() {
            continue;
        }

        for removed in &removed_names {
            // Update localPath and fileName in fileAsset records.
            transaction
                .execute(
                    "UPDATE entities SET
                       data = json_set(
                         json_set(data, '$.localPath', ?2),
                         '$.fileName', ?2
                       ),
                       updated_at = ?3
                     WHERE entity_type = 'fileAsset'
                       AND (
                         json_extract(data, '$.localPath') = ?1
                         OR json_extract(data, '$.fileName') = ?1
                       )
                       AND json_extract(data, '$.deletedAt') IS NULL",
                    rusqlite::params![
                        removed,
                        keeper_name,
                        now_iso()
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

fn now_iso() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}
