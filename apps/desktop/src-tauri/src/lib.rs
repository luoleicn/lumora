use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Manager, Runtime};

mod cloud_sync;
mod native_pdf;

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ArxivDownloadEvent {
    Started { total_bytes: Option<u64> },
    Progress { downloaded_bytes: u64, total_bytes: Option<u64> },
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredFileMetadata {
    size: u64,
    modified_ms: u64,
}

const PDF_VIEW_EVENT: &str = "lumora-pdf-view-command";
const PDF_VIEW_FIT_WIDTH: &str = "pdf-view-fit-width";
const PDF_VIEW_GO_TO_PAGE: &str = "pdf-view-go-to-page";
const PDF_VIEW_ZOOM_PREFIX: &str = "pdf-view-zoom-";
const WORKSPACE_EVENT: &str = "lumora-workspace-command";
const WORKSPACE_CLOSE_ACTIVE_TAB: &str = "workspace-close-active-tab";
const HELP_KEYBOARD_SHORTCUTS: &str = "help-keyboard-shortcuts";
const HELP_CHECK_FOR_UPDATES: &str = "help-check-for-updates";
const APP_ABOUT: &str = "app-about";
const APP_FILE_STORAGE_SETTINGS: &str = "app-file-storage-settings";
const APP_MENDELEY_SYNC: &str = "app-mendeley-sync";
const APP_PROXY_SETTINGS: &str = "app-proxy-settings";
const APP_SYNC_SETTINGS: &str = "app-sync-settings";
const APP_DUPLICATE_DOCUMENTS: &str = "app-duplicate-documents";
const FILES_REFRESH_LIBRARY: &str = "files-refresh-library";
const FILES_DOWNLOAD_ARXIV_FILES: &str = "files-download-arxiv-files";
const PROXY_SETTINGS_META_KEY: &str = "networkProxySettings";
const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(30);

static INITIALIZED_LIBRARY_DATABASES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

#[tauri::command]
fn ping() -> &'static str {
    "lumora-ready"
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LinuxGraphicsCapability {
    tier: &'static str,
}


/// Detect Linux graphics hardware outside WebKit. Creating a WebGL context just
/// to probe the renderer can itself trigger WebKitGTK driver bugs, so the
/// frontend receives a conservative capability tier derived from DRM/sysfs.
#[tauri::command]
fn linux_graphics_capability() -> LinuxGraphicsCapability {
    #[cfg(target_os = "linux")]
    {
        let software_requested = [
            "LIBGL_ALWAYS_SOFTWARE",
            "GALLIUM_DRIVER",
            "MESA_LOADER_DRIVER_OVERRIDE",
        ]
        .iter()
        .any(|name| {
            std::env::var(name).is_ok_and(|value| {
                let value = value.to_ascii_lowercase();
                value == "1"
                    || value == "true"
                    || value.contains("llvmpipe")
                    || value.contains("softpipe")
                    || value.contains("swrast")
            })
        });
        let has_render_node = std::fs::read_dir("/dev/dri").is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("renderD")
            })
        });
        let mut vendors = Vec::new();
        let mut has_large_dedicated_vram = false;
        if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("card") || name.contains('-') {
                    continue;
                }
                let device = entry.path().join("device");
                if let Ok(vendor) = std::fs::read_to_string(device.join("vendor")) {
                    vendors.push(vendor.trim().to_ascii_lowercase());
                }
                if let Ok(vram) = std::fs::read_to_string(device.join("mem_info_vram_total")) {
                    has_large_dedicated_vram |= vram
                        .trim()
                        .parse::<u64>()
                        .is_ok_and(|bytes| bytes >= 2 * 1024 * 1024 * 1024);
                }
            }
        }

        return LinuxGraphicsCapability {
            tier: classify_linux_graphics_capability(
                &vendors,
                has_render_node,
                has_large_dedicated_vram,
                software_requested,
            ),
        };
    }

    #[cfg(not(target_os = "linux"))]
    LinuxGraphicsCapability { tier: "unknown" }
}

fn classify_linux_graphics_capability(
    vendors: &[String],
    has_render_node: bool,
    has_large_dedicated_vram: bool,
    software_requested: bool,
) -> &'static str {
    if software_requested || !has_render_node || vendors.is_empty() {
        return "software";
    }
    if vendors.iter().any(|vendor| vendor == "0x10de")
        || (vendors.iter().any(|vendor| vendor == "0x1002") && has_large_dedicated_vram)
    {
        return "discrete";
    }
    "hardware"
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArxivAuthor {
    full_name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArxivMetadata {
    arxiv_id: String,
    title: String,
    authors: Vec<ArxivAuthor>,
    year: Option<i32>,
    #[serde(rename = "abstract")]
    abstract_: String,
    doi: Option<String>,
    url: String,
    published_at: Option<String>,
    updated_at: Option<String>,
    venue: String,
    categories: Vec<String>,
    score: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct YoudaoTranslation {
    query: String,
    phonetic: Option<String>,
    explains: Vec<String>,
    page_url: String,
}

const EXTERNAL_URL_HOSTS: [&str; 3] = ["dict.youdao.com", "dev.mendeley.com", "scholar.google.com"];

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| format!("Invalid URL: {error}"))?;
    let host_allowed = parsed.host_str().is_some_and(|host| EXTERNAL_URL_HOSTS.contains(&host));
    if parsed.scheme() != "https" || !host_allowed {
        return Err("URL host is not allowed.".to_string());
    }

    open_url_with_system(&url)
}

#[cfg(target_os = "macos")]
fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(())
}

#[tauri::command]
fn open_file_with_system(dir: String, file_name: String) -> Result<(), String> {
    let path = resolve_stored_file_path(&dir, &file_name)?;
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))
}

#[tauri::command]
fn reveal_file_in_folder(dir: String, file_name: String) -> Result<(), String> {
    let path = resolve_stored_file_path(&dir, &file_name)?;
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|error| format!("Failed to reveal {}: {error}", path.display()))
}

fn resolve_stored_file_path(dir: &str, file_name: &str) -> Result<std::path::PathBuf, String> {
    validate_stored_file_name(file_name)?;
    let path = std::path::Path::new(dir).join(file_name);
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("File not found or unreadable ({}): {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    Ok(path)
}

#[tauri::command]
async fn translate_with_youdao(query: String) -> Result<YoudaoTranslation, String> {
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if query.is_empty() {
        return Err("No text selected.".to_string());
    }

    let query = query.chars().take(200).collect::<String>();
    let mut url = reqwest::Url::parse("https://dict.youdao.com/suggest")
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("num", "5")
        .append_pair("ver", "3.0")
        .append_pair("doctype", "json")
        .append_pair("cache", "false")
        .append_pair("le", "en")
        .append_pair("q", &query);

    let response = reqwest::Client::new()
        .get(url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Youdao request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Youdao lookup failed: {}", response.status()));
    }

    let text = response
        .text()
        .await
        .map_err(|error| format!("Failed to read Youdao response: {error}"))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("Failed to parse Youdao response: {error}"))?;

    Ok(parse_youdao_translation(&value, query))
}

#[tauri::command]
async fn search_arxiv_by_title(app: AppHandle, title: String) -> Result<Vec<ArxivMetadata>, String> {
    let query = title.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let mut url = reqwest::Url::parse("https://export.arxiv.org/api/query")
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("search_query", &format!("ti:\"{}\"", query.replace('"', "")))
        .append_pair("start", "0")
        .append_pair("max_results", "3")
        .append_pair("sortBy", "relevance")
        .append_pair("sortOrder", "descending");

    let response = network_client(&app)?
        .get(url)
        .header("accept", "application/atom+xml")
        .send()
        .await
        .map_err(|error| format!("arXiv request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("arXiv lookup failed: {}", response.status()));
    }

    let xml = response
        .text()
        .await
        .map_err(|error| format!("Failed to read arXiv response: {error}"))?;

    let mut results = parse_arxiv_feed(&xml, query);
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(results)
}

const LIBRARY_ENTITY_TYPES: [&str; 5] = ["paper", "fileAsset", "collection", "paperCollection", "annotation"];

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityUpsert {
    entity_type: String,
    id: String,
    /// Full entity JSON, opaque to the storage layer.
    data: String,
    updated_at: String,
    deleted_at: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityDelete {
    entity_type: String,
    id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedEntity {
    entity_type: String,
    data: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedLibrary {
    entities: Vec<LoadedEntity>,
    meta: std::collections::HashMap<String, String>,
}

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxySettings {
    enabled: bool,
    url: String,
    username: String,
    password: String,
}

fn validate_proxy_settings(settings: &ProxySettings) -> Result<(), String> {
    if !settings.enabled {
        return Ok(());
    }
    let url = reqwest::Url::parse(settings.url.trim())
        .map_err(|error| format!("Invalid proxy URL: {error}"))?;
    match url.scheme() {
        "http" | "https" | "socks5" | "socks5h" => Ok(()),
        scheme => Err(format!("Unsupported proxy protocol: {scheme}")),
    }
}

fn load_proxy_settings<R: Runtime>(app: &AppHandle<R>) -> Result<ProxySettings, String> {
    let connection = open_library_db(app)?;
    let Some(raw) = get_meta_value(&connection, PROXY_SETTINGS_META_KEY) else {
        return Ok(ProxySettings::default());
    };
    serde_json::from_str(&raw).map_err(|error| format!("Failed to read proxy settings: {error}"))
}

fn network_client<R: Runtime>(app: &AppHandle<R>) -> Result<reqwest::Client, String> {
    let settings = load_proxy_settings(app)?;
    validate_proxy_settings(&settings)?;
    let mut builder = reqwest::Client::builder();
    if settings.enabled {
        let mut proxy = reqwest::Proxy::all(settings.url.trim())
            .map_err(|error| format!("Invalid proxy URL: {error}"))?;
        if !settings.username.is_empty() {
            proxy = proxy.basic_auth(&settings.username, &settings.password);
        }
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|error| format!("Failed to configure network client: {error}"))
}

#[tauri::command]
async fn proxy_settings(app: AppHandle) -> Result<ProxySettings, String> {
    load_proxy_settings(&app)
}

#[tauri::command]
async fn set_proxy_settings(app: AppHandle, settings: ProxySettings) -> Result<(), String> {
    validate_proxy_settings(&settings)?;
    let connection = open_library_db(&app)?;
    let value = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    set_meta_value(&connection, PROXY_SETTINGS_META_KEY, &value)
}

fn open_library_db<R: Runtime>(app: &AppHandle<R>) -> Result<rusqlite::Connection, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("Failed to create app data dir: {error}"))?;

    let database_path = dir.join("lumora.db");
    let connection = rusqlite::Connection::open(&database_path)
        .map_err(|error| format!("Failed to open library database: {error}"))?;
    configure_library_connection(&connection)?;

    // Schema setup performs writes and used to run for every command, causing
    // avoidable lock contention between background sync and UI persistence.
    let initialized = INITIALIZED_LIBRARY_DATABASES.get_or_init(|| Mutex::new(HashSet::new()));
    let mut initialized = initialized
        .lock()
        .map_err(|_| "Library database initialization lock is poisoned.".to_string())?;
    if !initialized.contains(&database_path) {
        init_library_schema(&connection)?;
        cloud_sync::init_sync_schema(&connection)?;
        ensure_search_index(&connection)?;
        initialized.insert(database_path);
    }

    Ok(connection)
}

fn configure_library_connection(connection: &rusqlite::Connection) -> Result<(), String> {
    connection
        .busy_timeout(DATABASE_BUSY_TIMEOUT)
        .map_err(|error| format!("Failed to configure library database: {error}"))
}

fn init_library_schema(connection: &rusqlite::Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS entities (
               entity_type TEXT NOT NULL,
               id TEXT NOT NULL,
               data TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               deleted_at TEXT,
               local_seq INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (entity_type, id)
             );
             CREATE INDEX IF NOT EXISTS idx_entities_local_seq ON entities(local_seq);
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .map_err(|error| format!("Failed to initialize library database: {error}"))
}

#[tauri::command]
async fn db_load_library(app: AppHandle) -> Result<LoadedLibrary, String> {
    let connection = open_library_db(&app)?;

    let mut statement = connection
        .prepare("SELECT entity_type, data FROM entities")
        .map_err(|error| error.to_string())?;
    let entities = statement
        .query_map([], |row| {
            Ok(LoadedEntity {
                entity_type: row.get(0)?,
                data: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut meta_statement = connection
        .prepare("SELECT key, value FROM meta")
        .map_err(|error| error.to_string())?;
    let meta = meta_statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<std::collections::HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(LoadedLibrary { entities, meta })
}

// Incremental-sync groundwork: local writes stamp a monotonically increasing
// `local_seq` so a future sync engine can push `WHERE local_seq > last_pushed`;
// applying remote changes uses source = "remote", which resets the marker so
// pulled rows are never echoed back to the server.
#[tauri::command]
async fn db_upsert_entities(app: AppHandle, changes: Vec<EntityUpsert>, source: String) -> Result<(), String> {
    if changes.is_empty() {
        return Ok(());
    }
    if source != "local" && source != "remote" {
        return Err(format!("Unknown write source: {source}"));
    }

    let mut connection = open_library_db(&app)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;

    let next_seq: i64 = if source == "local" {
        let max_seq: i64 = transaction
            .query_row("SELECT COALESCE(MAX(local_seq), 0) FROM entities", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        max_seq + 1
    } else {
        0
    };

    for change in &changes {
        if !LIBRARY_ENTITY_TYPES.contains(&change.entity_type.as_str()) {
            return Err(format!("Unknown entity type: {}", change.entity_type));
        }

        transaction
            .execute(
                "INSERT INTO entities (entity_type, id, data, updated_at, deleted_at, local_seq)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(entity_type, id) DO UPDATE SET
                   data = excluded.data,
                   updated_at = excluded.updated_at,
                   deleted_at = excluded.deleted_at,
                   local_seq = excluded.local_seq",
                rusqlite::params![
                    change.entity_type,
                    change.id,
                    change.data,
                    change.updated_at,
                    change.deleted_at,
                    next_seq
                ],
            )
            .map_err(|error| error.to_string())?;

        // Index maintenance must never fail the user's save: log and move on.
        if let Err(error) = sync_search_index_for_change(
            &transaction,
            &change.entity_type,
            &change.id,
            &change.data,
            change.deleted_at.as_deref(),
        ) {
            eprintln!(
                "Search index update failed for {} {}: {error}",
                change.entity_type, change.id
            );
        }
    }

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn db_delete_entities(app: AppHandle, entities: Vec<EntityDelete>) -> Result<(), String> {
    if entities.is_empty() {
        return Ok(());
    }
    let mut connection = open_library_db(&app)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for entity in entities {
        if !LIBRARY_ENTITY_TYPES.contains(&entity.entity_type.as_str()) {
            return Err(format!("Unknown entity type: {}", entity.entity_type));
        }

        // The annotation row is gone after the DELETE, so capture its paperId
        // first to re-aggregate that paper's note text afterwards.
        let annotation_paper_id: Option<String> = if entity.entity_type == "annotation" {
            use rusqlite::OptionalExtension;
            transaction
                .query_row(
                    "SELECT json_extract(data, '$.paperId') FROM entities WHERE entity_type = 'annotation' AND id = ?1",
                    [&entity.id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .ok()
                .flatten()
                .flatten()
        } else {
            None
        };

        transaction
            .execute(
                "DELETE FROM entities WHERE entity_type = ?1 AND id = ?2",
                rusqlite::params![entity.entity_type, entity.id],
            )
            .map_err(|error| error.to_string())?;

        if entity.entity_type == "paper" {
            transaction
                .execute("DELETE FROM search_index WHERE paper_id = ?1", [&entity.id])
                .map_err(|error| error.to_string())?;
        } else if let Some(paper_id) = annotation_paper_id {
            if let Err(error) = refresh_paper_notes(&transaction, &paper_id) {
                eprintln!("Search index note refresh failed for paper {paper_id}: {error}");
            }
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn db_get_meta(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let connection = open_library_db(&app)?;
    Ok(get_meta_value(&connection, &key))
}

#[tauri::command]
async fn db_set_meta(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let connection = open_library_db(&app)?;
    connection
        .execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

// --- Library full-text search ------------------------------------------------
// A content-storing FTS5 table holds one row per paper. Title, authors and note
// text are maintained synchronously on every entity write; the PDF body column
// is filled in asynchronously by the frontend extraction backfill and keyed by
// the file's sha256 so re-extraction only happens when the PDF changes. CJK text
// is segmented into single-character tokens (spaces injected around each CJK
// codepoint) at both index and query time, which gives substring semantics for
// CJK phrases while leaving latin tokenization untouched. Soft-deleted papers
// keep their row (flagged `deleted`) so a trashed paper's expensive body column
// survives a restore.

const SEARCH_INDEX_VERSION: &str = "1";
const SEARCH_INDEX_VERSION_META_KEY: &str = "searchIndexVersion";
const SEARCH_RESULT_LIMIT: u32 = 200;
const SEARCH_BODY_MAX_CHARS: usize = 1_000_000;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchHit {
    paper_id: String,
    tier: u8,
    score: f64,
    matched_fields: Vec<String>,
    snippet: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BodyIndexStatus {
    paper_id: String,
    body_sha: String,
}

fn ensure_search_index(connection: &rusqlite::Connection) -> Result<(), String> {
    if get_meta_value(connection, SEARCH_INDEX_VERSION_META_KEY).as_deref() == Some(SEARCH_INDEX_VERSION) {
        return Ok(());
    }

    let transaction = connection.unchecked_transaction().map_err(|error| error.to_string())?;
    transaction
        .execute_batch(
            "DROP TABLE IF EXISTS search_index;
             CREATE VIRTUAL TABLE search_index USING fts5(
               paper_id UNINDEXED,
               title,
               authors,
               body,
               notes,
               body_sha UNINDEXED,
               deleted UNINDEXED,
               tokenize = \"unicode61 remove_diacritics 2\"
             );",
        )
        .map_err(|error| format!("Failed to create search index: {error}"))?;
    rebuild_search_index_rows(&transaction)?;
    set_meta_value(&transaction, SEARCH_INDEX_VERSION_META_KEY, SEARCH_INDEX_VERSION)?;
    transaction.commit().map_err(|error| error.to_string())
}

fn rebuild_search_index_rows(connection: &rusqlite::Connection) -> Result<(), String> {
    let notes_by_paper = collect_notes_by_paper(connection)?;

    let mut statement = connection
        .prepare("SELECT id, data, deleted_at FROM entities WHERE entity_type = 'paper'")
        .map_err(|error| error.to_string())?;
    let papers = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    for (id, data, deleted_at) in papers {
        let Some(fields) = parse_paper_index_fields(&data) else {
            continue;
        };
        let notes = notes_by_paper
            .get(&id)
            .map(|parts| cjk_segment(&parts.join("\n")))
            .unwrap_or_default();
        connection
            .execute(
                "INSERT INTO search_index (paper_id, title, authors, body, notes, body_sha, deleted)
                 VALUES (?1, ?2, ?3, '', ?4, '', ?5)",
                rusqlite::params![id, fields.title, fields.authors, notes, i64::from(deleted_at.is_some())],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn collect_notes_by_paper(
    connection: &rusqlite::Connection,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let mut statement = connection
        .prepare("SELECT data FROM entities WHERE entity_type = 'annotation' AND deleted_at IS NULL")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;

    let mut notes: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for data in rows {
        let data = data.map_err(|error| error.to_string())?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        let Some(paper_id) = value.get("paperId").and_then(|item| item.as_str()) else {
            continue;
        };
        push_annotation_note_parts(&value, notes.entry(paper_id.to_string()).or_default());
    }
    Ok(notes)
}

fn push_annotation_note_parts(value: &serde_json::Value, parts: &mut Vec<String>) {
    for key in ["quote", "comment"] {
        if let Some(text) = value.get(key).and_then(|item| item.as_str()) {
            let text = text.trim();
            if !text.is_empty() {
                parts.push(text.to_string());
            }
        }
    }
}

struct PaperIndexFields {
    title: String,
    authors: String,
}

fn parse_paper_index_fields(data: &str) -> Option<PaperIndexFields> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let title = value.get("title").and_then(|item| item.as_str()).unwrap_or("");
    let authors = value
        .get("authors")
        .and_then(|item| item.as_array())
        .map(|authors| {
            authors
                .iter()
                .filter_map(|author| author.get("fullName").and_then(|name| name.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    Some(PaperIndexFields {
        title: cjk_segment(title),
        authors: cjk_segment(&authors),
    })
}

fn aggregate_notes(connection: &rusqlite::Connection, paper_id: &str) -> Result<String, String> {
    let mut statement = connection
        .prepare(
            "SELECT data FROM entities
             WHERE entity_type = 'annotation' AND deleted_at IS NULL AND json_extract(data, '$.paperId') = ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([paper_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;

    let mut parts = Vec::new();
    for data in rows {
        let data = data.map_err(|error| error.to_string())?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) {
            push_annotation_note_parts(&value, &mut parts);
        }
    }
    Ok(cjk_segment(&parts.join("\n")))
}

fn is_cjk_char(ch: char) -> bool {
    matches!(
        u32::from(ch),
        0x3040..=0x30FF   // Hiragana + Katakana
        | 0x3400..=0x4DBF // CJK extension A
        | 0x4E00..=0x9FFF // CJK unified ideographs
        | 0xAC00..=0xD7AF // Hangul syllables
        | 0xF900..=0xFAFF // CJK compatibility ideographs
    )
}

fn cjk_segment(text: &str) -> String {
    let mut segmented = String::with_capacity(text.len() + text.len() / 2);
    for ch in text.chars() {
        if is_cjk_char(ch) {
            segmented.push(' ');
            segmented.push(ch);
            segmented.push(' ');
        } else {
            segmented.push(ch);
        }
    }
    segmented.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn build_fts_match_terms(user_query: &str) -> Option<String> {
    let mut phrases: Vec<String> = user_query
        .split_whitespace()
        .filter_map(|term| {
            let segmented = cjk_segment(&term.replace('"', ""));
            (segmented.chars().any(char::is_alphanumeric)).then(|| format!("\"{segmented}\""))
        })
        .collect();

    let last = phrases.last_mut()?;
    let prefixable = last
        .trim_end_matches('"')
        .chars()
        .last()
        .is_some_and(|ch| ch.is_ascii_alphanumeric());
    if prefixable {
        last.push('*');
    }
    Some(phrases.join(" "))
}

fn build_fts_column_query(user_query: &str, column: &str) -> Option<String> {
    build_fts_match_terms(user_query).map(|terms| format!("{{{column}}} : ({terms})"))
}

fn decode_matched_mask(mask: i64) -> Vec<String> {
    [(1, "title"), (2, "body"), (3, "authors"), (4, "notes")]
        .into_iter()
        .filter(|(tier, _)| mask & (1_i64 << tier) != 0)
        .map(|(_, name)| name.to_string())
        .collect()
}

fn search_library_rows(connection: &rusqlite::Connection, query: &str, limit: u32) -> Result<Vec<SearchHit>, String> {
    let (Some(q_title), Some(q_body), Some(q_authors), Some(q_notes)) = (
        build_fts_column_query(query, "title"),
        build_fts_column_query(query, "body"),
        build_fts_column_query(query, "authors"),
        build_fts_column_query(query, "notes"),
    ) else {
        return Ok(Vec::new());
    };

    // Strict tiering: a paper's tier is its highest-priority matching column
    // (title > body > authors > notes); bm25 only orders within a tier. The
    // bare `score`/`snip` columns follow the MIN(tier) row per SQLite's
    // documented bare-column-with-MIN semantics, so the snippet always comes
    // from the best-tier column. Snippet segments are delimited by \u{1}/\u{2}
    // control chars (char(1)/char(2)) that the frontend splits on.
    let sql = "WITH hits(paper_id, tier, score, snip) AS (
         SELECT paper_id, 1, bm25(search_index), snippet(search_index, 1, char(1), char(2), '…', 14)
           FROM search_index WHERE search_index MATCH :q_title AND deleted = 0
         UNION ALL
         SELECT paper_id, 2, bm25(search_index), snippet(search_index, 3, char(1), char(2), '…', 14)
           FROM search_index WHERE search_index MATCH :q_body AND deleted = 0
         UNION ALL
         SELECT paper_id, 3, bm25(search_index), snippet(search_index, 2, char(1), char(2), '…', 14)
           FROM search_index WHERE search_index MATCH :q_authors AND deleted = 0
         UNION ALL
         SELECT paper_id, 4, bm25(search_index), snippet(search_index, 4, char(1), char(2), '…', 14)
           FROM search_index WHERE search_index MATCH :q_notes AND deleted = 0
       )
       SELECT paper_id, MIN(tier) AS tier, score, snip, SUM(1 << tier) AS matched_mask
       FROM hits
       GROUP BY paper_id
       ORDER BY tier ASC, score ASC
       LIMIT :limit";

    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let hits = statement
        .query_map(
            rusqlite::named_params! {
                ":q_title": q_title,
                ":q_body": q_body,
                ":q_authors": q_authors,
                ":q_notes": q_notes,
                ":limit": limit,
            },
            |row| {
                Ok(SearchHit {
                    paper_id: row.get(0)?,
                    tier: row.get::<_, i64>(1)? as u8,
                    score: row.get(2)?,
                    matched_fields: decode_matched_mask(row.get::<_, i64>(4)?),
                    snippet: row.get(3)?,
                })
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(hits)
}

fn sync_search_index_for_change(
    connection: &rusqlite::Connection,
    entity_type: &str,
    id: &str,
    data: &str,
    deleted_at: Option<&str>,
) -> Result<(), String> {
    match entity_type {
        "paper" => {
            let Some(fields) = parse_paper_index_fields(data) else {
                return Ok(());
            };
            let deleted = i64::from(deleted_at.is_some());
            let updated = connection
                .execute(
                    "UPDATE search_index SET title = ?2, authors = ?3, deleted = ?4 WHERE paper_id = ?1",
                    rusqlite::params![id, fields.title, fields.authors, deleted],
                )
                .map_err(|error| error.to_string())?;
            if updated == 0 {
                let notes = aggregate_notes(connection, id)?;
                connection
                    .execute(
                        "INSERT INTO search_index (paper_id, title, authors, body, notes, body_sha, deleted)
                         VALUES (?1, ?2, ?3, '', ?4, '', ?5)",
                        rusqlite::params![id, fields.title, fields.authors, notes, deleted],
                    )
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        "annotation" => {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                return Ok(());
            };
            let Some(paper_id) = value.get("paperId").and_then(|item| item.as_str()) else {
                return Ok(());
            };
            refresh_paper_notes(connection, paper_id)
        }
        _ => Ok(()),
    }
}

fn refresh_paper_notes(connection: &rusqlite::Connection, paper_id: &str) -> Result<(), String> {
    use rusqlite::OptionalExtension;

    let notes = aggregate_notes(connection, paper_id)?;
    let updated = connection
        .execute(
            "UPDATE search_index SET notes = ?2 WHERE paper_id = ?1",
            rusqlite::params![paper_id, notes],
        )
        .map_err(|error| error.to_string())?;
    if updated > 0 {
        return Ok(());
    }

    // Annotations can arrive before their paper's search row exists (sync ordering).
    let paper_row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT data, deleted_at FROM entities WHERE entity_type = 'paper' AND id = ?1",
            [paper_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((data, deleted_at)) = paper_row else {
        return Ok(());
    };
    let Some(fields) = parse_paper_index_fields(&data) else {
        return Ok(());
    };
    connection
        .execute(
            "INSERT INTO search_index (paper_id, title, authors, body, notes, body_sha, deleted)
             VALUES (?1, ?2, ?3, '', ?4, '', ?5)",
            rusqlite::params![paper_id, fields.title, fields.authors, notes, i64::from(deleted_at.is_some())],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn index_paper_body(connection: &rusqlite::Connection, paper_id: &str, sha256: &str, text: &str) -> Result<(), String> {
    use rusqlite::OptionalExtension;

    let capped: String = text.chars().take(SEARCH_BODY_MAX_CHARS).collect();
    let body = cjk_segment(&capped);
    let updated = connection
        .execute(
            "UPDATE search_index SET body = ?2, body_sha = ?3 WHERE paper_id = ?1",
            rusqlite::params![paper_id, body, sha256],
        )
        .map_err(|error| error.to_string())?;
    if updated > 0 {
        return Ok(());
    }

    let paper_row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT data, deleted_at FROM entities WHERE entity_type = 'paper' AND id = ?1",
            [paper_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((data, deleted_at)) = paper_row else {
        return Ok(());
    };
    let Some(fields) = parse_paper_index_fields(&data) else {
        return Ok(());
    };
    let notes = aggregate_notes(connection, paper_id)?;
    connection
        .execute(
            "INSERT INTO search_index (paper_id, title, authors, body, notes, body_sha, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![paper_id, fields.title, fields.authors, body, notes, sha256, i64::from(deleted_at.is_some())],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn db_search_library(app: AppHandle, query: String, limit: Option<u32>) -> Result<Vec<SearchHit>, String> {
    let connection = open_library_db(&app)?;
    search_library_rows(&connection, &query, limit.unwrap_or(SEARCH_RESULT_LIMIT))
}

#[tauri::command]
async fn db_index_paper_body(app: AppHandle, paper_id: String, sha256: String, text: String) -> Result<(), String> {
    let connection = open_library_db(&app)?;
    index_paper_body(&connection, &paper_id, &sha256, &text)
}

#[tauri::command]
async fn db_search_index_status(app: AppHandle) -> Result<Vec<BodyIndexStatus>, String> {
    let connection = open_library_db(&app)?;
    let mut statement = connection
        .prepare("SELECT paper_id, body_sha FROM search_index WHERE deleted = 0")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(BodyIndexStatus {
                paper_id: row.get(0)?,
                body_sha: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

// --- Mendeley direct integration -------------------------------------------
// The desktop app talks to api.mendeley.com itself: OAuth authorization-code
// flow with a fixed loopback redirect (the URI registered at dev.mendeley.com
// must match exactly, so the port is fixed), tokens stored in the library
// database's meta table, and an authenticated request proxy that refreshes the
// access token transparently.

const MENDELEY_REDIRECT_PORT: u16 = 53682;
const MENDELEY_REDIRECT_PATH: &str = "/mendeley/callback";
const MENDELEY_META_ACCESS_TOKEN: &str = "mendeleyAccessToken";
const MENDELEY_META_REFRESH_TOKEN: &str = "mendeleyRefreshToken";
const MENDELEY_META_EXPIRES_AT: &str = "mendeleyTokenExpiresAt";
const MENDELEY_META_DISPLAY_NAME: &str = "mendeleyDisplayName";
const MENDELEY_META_CLIENT_ID: &str = "mendeleyClientId";
const MENDELEY_META_CLIENT_SECRET: &str = "mendeleyClientSecret";

#[derive(serde::Deserialize)]
struct MendeleyTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MendeleyStatus {
    connected: bool,
    display_name: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MendeleyResponse {
    status: u16,
    body: String,
    link_next: Option<String>,
}

fn mendeley_redirect_uri() -> String {
    format!("http://localhost:{MENDELEY_REDIRECT_PORT}{MENDELEY_REDIRECT_PATH}")
}

fn get_meta_value(connection: &rusqlite::Connection, key: &str) -> Option<String> {
    connection
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| row.get(0))
        .ok()
}

fn set_meta_value(connection: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn clear_mendeley_tokens(connection: &rusqlite::Connection) {
    for key in [
        MENDELEY_META_ACCESS_TOKEN,
        MENDELEY_META_REFRESH_TOKEN,
        MENDELEY_META_EXPIRES_AT,
        MENDELEY_META_DISPLAY_NAME,
        MENDELEY_META_CLIENT_ID,
        MENDELEY_META_CLIENT_SECRET,
    ] {
        let _ = connection.execute("DELETE FROM meta WHERE key = ?1", [key]);
    }
}

fn store_mendeley_tokens<R: Runtime>(app: &AppHandle<R>, tokens: &MendeleyTokenResponse) -> Result<(), String> {
    let connection = open_library_db(app)?;
    set_meta_value(&connection, MENDELEY_META_ACCESS_TOKEN, &tokens.access_token)?;
    if let Some(refresh_token) = &tokens.refresh_token {
        set_meta_value(&connection, MENDELEY_META_REFRESH_TOKEN, refresh_token)?;
    }
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64 + tokens.expires_in.unwrap_or(3600))
        .unwrap_or(0);
    set_meta_value(&connection, MENDELEY_META_EXPIRES_AT, &expires_at.to_string())?;
    Ok(())
}

// Waits for the OAuth redirect on the loopback listener and extracts the
// `code`/`state` query parameters from the request line.
fn await_oauth_callback(listener: std::net::TcpListener) -> Result<(String, String), String> {
    use std::io::{BufRead, BufReader, Write};

    listener
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
    for stream in listener.incoming() {
        if std::time::Instant::now() > deadline {
            return Err("Timed out waiting for the Mendeley authorization redirect.".to_string());
        }

        let mut stream = stream.map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).map_err(|error| error.to_string())?;

        let path = request_line.split_whitespace().nth(1).unwrap_or_default().to_string();
        let responded_ok = path.starts_with(MENDELEY_REDIRECT_PATH);
        let body = if responded_ok {
            "<html><body><h2>lumora</h2><p>Mendeley authorization complete. You can close this window.</p></body></html>"
        } else {
            "<html><body><p>Unexpected request.</p></body></html>"
        };
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );

        if !responded_ok {
            continue;
        }

        let query = path.split_once('?').map(|(_, query)| query).unwrap_or_default();
        let mut code = None;
        let mut state = None;
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("code", value)) => code = Some(value.to_string()),
                Some(("state", value)) => state = Some(value.to_string()),
                _ => {}
            }
        }

        return match (code, state) {
            (Some(code), Some(state)) => Ok((code, state)),
            _ => Err("Mendeley redirect did not include an authorization code.".to_string()),
        };
    }

    Err("Authorization listener closed unexpectedly.".to_string())
}

#[tauri::command]
async fn mendeley_connect(app: AppHandle, client_id: String, client_secret: String) -> Result<MendeleyStatus, String> {
    let client_id = client_id.trim().to_string();
    let client_secret = client_secret.trim().to_string();
    if client_id.is_empty() {
        return Err("Enter the Mendeley client ID first.".to_string());
    }

    let listener = std::net::TcpListener::bind(("127.0.0.1", MENDELEY_REDIRECT_PORT))
        .map_err(|error| format!("Port {MENDELEY_REDIRECT_PORT} is unavailable for the OAuth callback: {error}"))?;

    let state = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );

    let mut authorize_url = reqwest::Url::parse("https://api.mendeley.com/oauth/authorize")
        .map_err(|error| error.to_string())?;
    authorize_url
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &mendeley_redirect_uri())
        .append_pair("response_type", "code")
        .append_pair("scope", "all")
        .append_pair("state", &state);
    open_url_with_system(authorize_url.as_str())?;

    let (code, returned_state) = tauri::async_runtime::spawn_blocking(move || await_oauth_callback(listener))
        .await
        .map_err(|error| error.to_string())??;
    if returned_state != state {
        return Err("OAuth state mismatch; aborting for safety.".to_string());
    }

    let client = network_client(&app)?;
    let token_response = client
        .post("https://api.mendeley.com/oauth/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", &mendeley_redirect_uri()),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
        ])
        .send()
        .await
        .map_err(|error| format!("Token exchange failed: {error}"))?;

    if !token_response.status().is_success() {
        let status = token_response.status();
        let body = token_response.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed ({status}): {body}"));
    }

    let tokens: MendeleyTokenResponse = token_response
        .json()
        .await
        .map_err(|error| format!("Failed to parse token response: {error}"))?;
    store_mendeley_tokens(&app, &tokens)?;

    // Confirm the connection and capture the profile name for display.
    let profile_response = client
        .get("https://api.mendeley.com/profiles/me")
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let display_name = if profile_response.status().is_success() {
        let profile: serde_json::Value = profile_response.json().await.unwrap_or_default();
        profile
            .get("display_name")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string)
            .or_else(|| profile.get("email").and_then(serde_json::Value::as_str).map(ToString::to_string))
    } else {
        None
    };

    let connection = open_library_db(&app)?;
    set_meta_value(&connection, MENDELEY_META_DISPLAY_NAME, display_name.as_deref().unwrap_or(""))?;
    set_meta_value(&connection, MENDELEY_META_CLIENT_ID, &client_id)?;
    set_meta_value(&connection, MENDELEY_META_CLIENT_SECRET, &client_secret)?;

    Ok(MendeleyStatus { connected: true, display_name })
}

#[tauri::command]
async fn mendeley_status(app: AppHandle) -> Result<MendeleyStatus, String> {
    let (has_refresh_token, display_name, token_fresh, client_id, client_secret) = {
        let connection = open_library_db(&app)?;
        let has_refresh_token = get_meta_value(&connection, MENDELEY_META_REFRESH_TOKEN).is_some();
        let display_name = get_meta_value(&connection, MENDELEY_META_DISPLAY_NAME)
            .filter(|name| !name.is_empty());
        let expires_at = get_meta_value(&connection, MENDELEY_META_EXPIRES_AT)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        let token_fresh = expires_at - now > 60;
        let client_id = get_meta_value(&connection, MENDELEY_META_CLIENT_ID).unwrap_or_default();
        let client_secret = get_meta_value(&connection, MENDELEY_META_CLIENT_SECRET).unwrap_or_default();
        (has_refresh_token, display_name, token_fresh, client_id, client_secret)
    };

    if !has_refresh_token {
        return Ok(MendeleyStatus { connected: false, display_name: None });
    }

    // Fast path: access token is still valid — no network call needed.
    if token_fresh {
        return Ok(MendeleyStatus { connected: true, display_name });
    }

    // Token is near or past expiry. Try refreshing to verify the refresh token
    // is still good. If client credentials were never stored (pre-migration DB),
    // err on the side of showing "connected" rather than forcing re-auth.
    if client_id.is_empty() {
        return Ok(MendeleyStatus { connected: true, display_name });
    }

    match refresh_mendeley_token(&app, &client_id, &client_secret).await {
        Ok(_) => {
            let connection = open_library_db(&app)?;
            let display_name = get_meta_value(&connection, MENDELEY_META_DISPLAY_NAME)
                .filter(|name| !name.is_empty());
            Ok(MendeleyStatus { connected: true, display_name })
        }
        Err(_) => {
            // refresh_mendeley_token clears tokens on authentication failures
            // (4xx), so re-reading the DB gives the correct post-clear state.
            // Network errors leave tokens intact — connected stays true.
            let connection = open_library_db(&app)?;
            let still_connected = get_meta_value(&connection, MENDELEY_META_REFRESH_TOKEN).is_some();
            let display_name = get_meta_value(&connection, MENDELEY_META_DISPLAY_NAME)
                .filter(|name| !name.is_empty());
            Ok(MendeleyStatus { connected: still_connected, display_name })
        }
    }
}

#[tauri::command]
async fn mendeley_disconnect(app: AppHandle) -> Result<(), String> {
    let connection = open_library_db(&app)?;
    clear_mendeley_tokens(&connection);
    Ok(())
}

async fn refresh_mendeley_token<R: Runtime>(
    app: &AppHandle<R>,
    client_id: &str,
    client_secret: &str,
) -> Result<String, String> {
    let refresh_token = {
        let connection = open_library_db(app)?;
        get_meta_value(&connection, MENDELEY_META_REFRESH_TOKEN)
            .ok_or_else(|| "Not connected to Mendeley.".to_string())?
    };

    let response = network_client(app)?
        .post("https://api.mendeley.com/oauth/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", client_id),
            ("client_secret", client_secret),
        ])
        .send()
        .await
        .map_err(|error| format!("Token refresh failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        // When the refresh token itself is invalid or expired, clear all stored
        // tokens so the app reports "disconnected" without manual intervention.
        if status == reqwest::StatusCode::BAD_REQUEST || status == reqwest::StatusCode::UNAUTHORIZED {
            if let Ok(connection) = open_library_db(app) {
                clear_mendeley_tokens(&connection);
            }
        }
        return Err(format!("Token refresh failed ({}). Reconnect Mendeley.", status));
    }

    let tokens: MendeleyTokenResponse = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse refresh response: {error}"))?;
    store_mendeley_tokens(app, &tokens)?;
    Ok(tokens.access_token)
}

// Authenticated proxy to api.mendeley.com so the frontend never handles tokens
// or CORS. Refreshes the access token once on 401.
#[tauri::command]
async fn mendeley_request(
    app: AppHandle,
    client_id: String,
    client_secret: String,
    method: String,
    path: String,
    body: Option<String>,
    content_type: Option<String>,
) -> Result<MendeleyResponse, String> {
    if !path.starts_with('/') {
        return Err("Mendeley API path must start with '/'.".to_string());
    }

    let mut access_token = {
        let connection = open_library_db(&app)?;
        let expires_at = get_meta_value(&connection, MENDELEY_META_EXPIRES_AT)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        let token = get_meta_value(&connection, MENDELEY_META_ACCESS_TOKEN);
        if expires_at - now < 60 { None } else { token }
    };

    if access_token.is_none() {
        access_token = Some(refresh_mendeley_token(&app, &client_id, &client_secret).await?);
    }

    let url = format!("https://api.mendeley.com{path}");
    let client = network_client(&app)?;

    for attempt in 0..2 {
        let mut request = match method.as_str() {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            "PATCH" => client.patch(&url),
            "DELETE" => client.delete(&url),
            _ => return Err(format!("Unsupported method: {method}")),
        }
        .bearer_auth(access_token.as_deref().unwrap_or_default());

        if let Some(content_type) = &content_type {
            request = request.header("content-type", content_type).header("accept", content_type);
        }
        if let Some(body) = &body {
            request = request.body(body.clone());
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("Mendeley request failed: {error}"))?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            access_token = Some(refresh_mendeley_token(&app, &client_id, &client_secret).await?);
            continue;
        }

        let status = response.status().as_u16();
        let link_next = response
            .headers()
            .get("link")
            .and_then(|value| value.to_str().ok())
            .and_then(parse_next_link);
        let response_body = response.text().await.unwrap_or_default();
        return Ok(MendeleyResponse { status, body: response_body, link_next });
    }

    Err("Mendeley request failed after token refresh.".to_string())
}

// Downloads the attachment bytes after Mendeley's short-lived 303 redirect.
// Keeping this in Rust means OAuth tokens and signed URLs never enter WebView JS.
#[tauri::command]
async fn mendeley_download_file(
    app: AppHandle,
    client_id: String,
    client_secret: String,
    file_id: String,
) -> Result<tauri::ipc::Response, String> {
    let token = {
        let connection = open_library_db(&app)?;
        let expires_at = get_meta_value(&connection, MENDELEY_META_EXPIRES_AT)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        if expires_at - now >= 60 {
            get_meta_value(&connection, MENDELEY_META_ACCESS_TOKEN)
        } else {
            None
        }
    };
    let mut access_token = match token {
        Some(token) => token,
        None => refresh_mendeley_token(&app, &client_id, &client_secret).await?,
    };
    for attempt in 0..2 {
        let response = network_client(&app)?
            .get(format!("https://api.mendeley.com/files/{file_id}"))
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|error| format!("Mendeley file download failed: {error}"))?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            access_token = refresh_mendeley_token(&app, &client_id, &client_secret).await?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("Mendeley file download failed ({})", response.status()));
        }
        let bytes = response.bytes().await
            .map_err(|error| format!("Failed to read Mendeley file: {error}"))?;
        return Ok(tauri::ipc::Response::new(bytes.to_vec()));
    }
    Err("Mendeley file download failed after token refresh.".to_string())
}

#[tauri::command]
async fn download_arxiv_pdf(
    app: AppHandle,
    arxiv_id: String,
    on_progress: tauri::ipc::Channel<ArxivDownloadEvent>,
) -> Result<tauri::ipc::Response, String> {
    download_arxiv_pdf_impl(app, arxiv_id, Some(&on_progress)).await
}

#[tauri::command]
async fn download_arxiv_pdf_silent(
    app: AppHandle,
    arxiv_id: String,
) -> Result<tauri::ipc::Response, String> {
    download_arxiv_pdf_impl(app, arxiv_id, None).await
}

async fn download_arxiv_pdf_impl(
    app: AppHandle,
    arxiv_id: String,
    on_progress: Option<&tauri::ipc::Channel<ArxivDownloadEvent>>,
) -> Result<tauri::ipc::Response, String> {
    let arxiv_id = arxiv_id.trim();
    let modern = regex::Regex::new(r"^\d{4}\.\d{4,5}(v\d+)?$").map_err(|error| error.to_string())?;
    let legacy = regex::Regex::new(r"^[A-Za-z-]+(?:\.[A-Za-z-]+)?/\d{7}(v\d+)?$")
        .map_err(|error| error.to_string())?;
    if !modern.is_match(arxiv_id) && !legacy.is_match(arxiv_id) {
        return Err(format!("Invalid arXiv identifier: {arxiv_id}"));
    }

    let url = format!("https://arxiv.org/pdf/{arxiv_id}");
    let mut response = network_client(&app)?
        .get(&url)
        .header(reqwest::header::USER_AGENT, "lumora/0.1 desktop research library")
        .header(reqwest::header::ACCEPT, "application/pdf")
        .send()
        .await
        .map_err(|error| format!("Failed to download arXiv:{arxiv_id}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("arXiv PDF download failed for {arxiv_id} ({})", response.status()));
    }
    let total_bytes = response.content_length();
    if let Some(channel) = on_progress {
        let _ = channel.send(ArxivDownloadEvent::Started { total_bytes });
    }
    let mut bytes = Vec::with_capacity(total_bytes.unwrap_or(0).min(usize::MAX as u64) as usize);
    while let Some(chunk) = response.chunk().await
        .map_err(|error| format!("Failed to read arXiv PDF {arxiv_id}: {error}"))? {
        bytes.extend_from_slice(&chunk);
        if let Some(channel) = on_progress {
            let _ = channel.send(ArxivDownloadEvent::Progress {
                downloaded_bytes: bytes.len() as u64,
                total_bytes,
            });
        }
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(format!("arXiv returned non-PDF content for {arxiv_id}"));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

// Extracts the rel="next" URL from an RFC 5988 Link header and returns it as a
// path+query relative to api.mendeley.com.
fn parse_next_link(header: &str) -> Option<String> {
    for part in header.split(',') {
        let (url_part, params) = part.split_once(';')?;
        if params.contains("rel=\"next\"") {
            let url = url_part.trim().trim_start_matches('<').trim_end_matches('>');
            return url.strip_prefix("https://api.mendeley.com").map(ToString::to_string);
        }
    }
    None
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

fn validate_stored_file_name(file_name: &str) -> Result<(), String> {
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
#[tauri::command]
fn store_pdf(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a binary PDF payload.".to_string());
    };

    let dir = decode_command_header(request.headers(), STORE_PDF_DIR_HEADER)?;
    let file_name = decode_command_header(request.headers(), STORE_PDF_FILE_NAME_HEADER)?;
    validate_stored_file_name(&file_name)?;

    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).map_err(|error| format!("Failed to create storage folder: {error}"))?;
    let target = resolve_collision_free_path(&dir, &file_name, None);
    std::fs::write(&target, bytes).map_err(|error| format!("Failed to write PDF: {error}"))?;

    Ok(target.file_name().and_then(|name| name.to_str()).unwrap_or(&file_name).to_string())
}

// Lists the PDF file names currently in the storage folder so the front end can
// reconcile library records against what actually lives on disk (the folder is
// the source of truth for whether a paper has a local PDF). A missing folder is
// not an error: it just means nothing is stored yet.
#[tauri::command]
async fn list_stored_pdfs(dir: String) -> Result<Vec<String>, String> {
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
}

#[tauri::command]
async fn read_stored_pdf(dir: String, file_name: String) -> Result<tauri::ipc::Response, String> {
    validate_stored_file_name(&file_name)?;
    let path = std::path::Path::new(&dir).join(&file_name);
    let bytes = std::fs::read(&path).map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

const MAX_STORED_PDF_RANGE_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
async fn read_stored_pdf_range(
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
async fn stored_pdf_metadata(dir: String, file_name: String) -> Result<StoredFileMetadata, String> {
    validate_stored_file_name(&file_name)?;
    let path = std::path::Path::new(&dir).join(&file_name);
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("Failed to stat {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default();
    Ok(StoredFileMetadata { size: metadata.len(), modified_ms })
}

#[tauri::command]
async fn delete_stored_pdf(dir: String, file_name: String) -> Result<(), String> {
    validate_stored_file_name(&file_name)?;
    let path = std::path::Path::new(&dir).join(&file_name);
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(&path).map_err(|error| format!("Failed to delete {}: {error}", path.display()))
}

#[tauri::command]
async fn move_stored_pdf(dir: String, file_name: String, new_dir: String, new_file_name: String) -> Result<String, String> {
    validate_stored_file_name(&file_name)?;
    validate_stored_file_name(&new_file_name)?;

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
}

// --- Duplicate download cleanup -----------------------------------------------

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateGroupFile {
    file_name: String,
    size: u64,
    kept: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    referenced_by: Vec<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateGroup {
    sha256: String,
    files: Vec<DuplicateGroupFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_copies: Option<usize>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupDuplicateSummary {
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
async fn cleanup_duplicate_downloads(
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
    let connection = open_library_db(app)?;
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
    let mut connection = open_library_db(app)?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                enable_trackpad_pinch_zoom(app);
                install_key_shortcut_monitor(app.handle().clone());
            }
            // macOS uses `app` above; other platforms have no native setup yet.
            #[cfg(not(target_os = "macos"))]
            let _ = app;
            Ok(())
        })
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == FILES_REFRESH_LIBRARY {
                let _ = app.emit(WORKSPACE_EVENT, "refresh-library");
            } else if id == PDF_VIEW_FIT_WIDTH {
                #[cfg(target_os = "macos")]
                reset_native_magnification(app);
                let _ = app.emit(PDF_VIEW_EVENT, "fit-width");
            } else if id == PDF_VIEW_GO_TO_PAGE {
                let _ = app.emit(PDF_VIEW_EVENT, "go-to-page");
            } else if id == WORKSPACE_CLOSE_ACTIVE_TAB {
                let _ = app.emit(WORKSPACE_EVENT, "close-active-tab");
            } else if id == HELP_KEYBOARD_SHORTCUTS {
                let _ = app.emit(WORKSPACE_EVENT, "show-shortcuts-help");
            } else if id == HELP_CHECK_FOR_UPDATES {
                let _ = app.emit(WORKSPACE_EVENT, "check-for-updates");
            } else if id == APP_ABOUT {
                let _ = app.emit(WORKSPACE_EVENT, "show-about");
            } else if id == APP_FILE_STORAGE_SETTINGS {
                let _ = app.emit(WORKSPACE_EVENT, "show-file-storage-settings");
            } else if id == APP_MENDELEY_SYNC {
                let _ = app.emit(WORKSPACE_EVENT, "show-mendeley-sync");
            } else if id == APP_PROXY_SETTINGS {
                let _ = app.emit(WORKSPACE_EVENT, "show-proxy-settings");
            } else if id == APP_SYNC_SETTINGS {
                let _ = app.emit(WORKSPACE_EVENT, "show-sync-settings");
            } else if id == APP_DUPLICATE_DOCUMENTS {
                let _ = app.emit(WORKSPACE_EVENT, "show-duplicate-documents");
            } else if id == FILES_DOWNLOAD_ARXIV_FILES {
                let _ = app.emit(WORKSPACE_EVENT, "download-arxiv-files");
            } else if let Some(zoom) = id.strip_prefix(PDF_VIEW_ZOOM_PREFIX) {
                let _ = app.emit(PDF_VIEW_EVENT, format!("zoom:{zoom}"));
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            ping,
            linux_graphics_capability,
            native_pdf::native_pdf_open_path,
            native_pdf::native_pdf_stage_chunk,
            native_pdf::native_pdf_open_upload,
            native_pdf::native_pdf_render_page,
            native_pdf::native_pdf_page_text,
            native_pdf::native_pdf_search,
            open_external_url,
            open_file_with_system,
            reveal_file_in_folder,
            translate_with_youdao,
            search_arxiv_by_title,
            store_pdf,
            list_stored_pdfs,
            read_stored_pdf,
            read_stored_pdf_range,
            stored_pdf_metadata,
            delete_stored_pdf,
            move_stored_pdf,
            db_load_library,
            db_upsert_entities,
            db_delete_entities,
            db_get_meta,
            db_set_meta,
            db_search_library,
            db_index_paper_body,
            db_search_index_status,
            proxy_settings,
            set_proxy_settings,
            mendeley_connect,
            mendeley_status,
            mendeley_disconnect,
            mendeley_request,
            mendeley_download_file,
            download_arxiv_pdf,
            download_arxiv_pdf_silent,
            cloud_sync::qiniu_sync_config,
            cloud_sync::qiniu_save_sync_config,
            cloud_sync::qiniu_test_sync_connection,
            cloud_sync::qiniu_disconnect_sync,
            cloud_sync::qiniu_upload_blob,
            cloud_sync::qiniu_object_exists,
            cloud_sync::qiniu_list_blobs,
            cloud_sync::qiniu_download_blob,
            cloud_sync::qiniu_delete_blob,
            cloud_sync::qiniu_sync_library,
            cleanup_duplicate_downloads
        ])
        .run(tauri::generate_context!())
        .expect("error while running lumora");
}

// WKWebView disables trackpad pinch-to-zoom by default (`allowsMagnification` is false).
// Enabling it lets WebKit dispatch `gesturestart`/`gesturechange` DOM events for the pinch
// gesture, which PdfReader listens for; it also calls `preventDefault()` on those events so
// WebKit's own whole-page magnification never kicks in.
#[cfg(target_os = "macos")]
fn enable_trackpad_pinch_zoom<R: Runtime>(app: &tauri::App<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.with_webview(|webview| unsafe {
        let view = &*(webview.inner() as *const objc2_web_kit::WKWebView);
        view.setAllowsMagnification(true);
    });
}

// WKWebView claims macOS text-editing key equivalents (Cmd+Z is Undo, Cmd+; is
// spell-check's "Check Document Now", Cmd+F is Find) inside its own
// performKeyEquivalent: pass, which macOS runs before both the menu-bar
// accelerators and DOM keydown listeners — so neither layer ever sees those
// chords. An NSApplication-level local event monitor is the one hook that runs
// ahead of the responder chain, so shortcuts are intercepted here and forwarded
// as Tauri events. Returning null consumes the NSEvent, preventing WebKit's
// built-in actions from firing.
#[cfg(target_os = "macos")]
fn install_key_shortcut_monitor(app_handle: AppHandle) {
    use core::ptr::NonNull;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};

    // kVK_ANSI_Semicolon: match the physical key, not the produced character —
    // under a CJK input source charactersIgnoringModifiers can yield the
    // full-width "；", which would break a string comparison against ";".
    const SEMICOLON_KEY_CODE: u16 = 41;
    const F_KEY_CODE: u16 = 3;

    let handler: block2::RcBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent> =
        block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            let key_event = unsafe { event.as_ref() };
            let flags = key_event.modifierFlags();
            let is_cmd_only = flags.contains(NSEventModifierFlags::Command)
                && !flags.intersects(
                    NSEventModifierFlags::Shift | NSEventModifierFlags::Control | NSEventModifierFlags::Option,
                );

            // Cmd+; → Fit Width
            if is_cmd_only {
                let is_semicolon_key = key_event.keyCode() == SEMICOLON_KEY_CODE
                    || key_event
                        .charactersIgnoringModifiers()
                        .is_some_and(|characters| matches!(characters.to_string().as_str(), ";" | "；"));
                if is_semicolon_key {
                    reset_native_magnification(&app_handle);
                    let _ = app_handle.emit(PDF_VIEW_EVENT, "fit-width");
                    return core::ptr::null_mut();
                }

                // Cmd+F → focus the toolbar search / find bar. Use both
                // keyCode and character detection for robustness, then
                // evaluate JS directly in the webview — this avoids the
                // Tauri event round-trip and works even when the event
                // listener hasn't been set up yet. The search input is located
                // by its semantic `data-search-input` marker (kept in sync with
                // focusToolbarSearch on the JS side), not a presentational
                // tag/type that can silently drift.
                let is_f_key = key_event.keyCode() == F_KEY_CODE
                    || key_event
                        .charactersIgnoringModifiers()
                        .is_some_and(|c| matches!(c.to_string().to_lowercase().as_str(), "f"));
                if is_f_key {
                    let js = "const el=document.querySelector('.app-toolbar input[data-search-input]');if(el){el.focus();el.select();}";
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.eval(js);
                    }
                    let _ = app_handle.emit(WORKSPACE_EVENT, "focus-toolbar-search");
                    return core::ptr::null_mut();
                }
            }

            event.as_ptr()
        });

    unsafe {
        if let Some(monitor) = NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler) {
            // The monitor must stay registered for the app's whole lifetime.
            std::mem::forget(monitor);
        }
    }
}

// With allowsMagnification enabled, a trackpad pinch may zoom via WKWebView's
// native whole-view magnification (in addition to, or instead of, the JS-side
// page zoom, depending on whether WebKit honors preventDefault on the gesture
// events). Fit Width must therefore reset both layers: this handles the native
// one, and the "fit-width" event handles the JS one.
#[cfg(target_os = "macos")]
fn reset_native_magnification<R: Runtime>(app_handle: &AppHandle<R>) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };

    let _ = window.with_webview(|webview| unsafe {
        let view = &*(webview.inner() as *const objc2_web_kit::WKWebView);
        view.setMagnification(1.0);
    });
}

#[cfg(desktop)]
fn build_menu<R: Runtime>(app_handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app_handle.package_info();

    // The application ("apple") submenu. `services` and `hide_others` are
    // macOS-only conventions (they render as dead/no-op entries elsewhere), so
    // they are included only on macOS. The macOS item sequence is kept
    // byte-for-byte identical to preserve the existing, verified menu.
    let about_item = MenuItem::with_id(app_handle, APP_ABOUT, format!("About {}", pkg_info.name), true, None::<&str>)?;
    let about_sep = PredefinedMenuItem::separator(app_handle)?;
    let mendeley_item = MenuItem::with_id(app_handle, APP_MENDELEY_SYNC, "Mendeley Sync...", true, None::<&str>)?;
    let sync_item = MenuItem::with_id(app_handle, APP_SYNC_SETTINGS, "Sync Settings...", true, None::<&str>)?;
    let proxy_item = MenuItem::with_id(app_handle, APP_PROXY_SETTINGS, "Proxy...", true, None::<&str>)?;
    let settings_sep = PredefinedMenuItem::separator(app_handle)?;
    #[cfg(target_os = "macos")]
    let services_item = PredefinedMenuItem::services(app_handle, None)?;
    #[cfg(target_os = "macos")]
    let services_sep = PredefinedMenuItem::separator(app_handle)?;
    let hide_item = PredefinedMenuItem::hide(app_handle, None)?;
    #[cfg(target_os = "macos")]
    let hide_others_item = PredefinedMenuItem::hide_others(app_handle, None)?;
    let quit_sep = PredefinedMenuItem::separator(app_handle)?;
    let quit_item = PredefinedMenuItem::quit(app_handle, None)?;

    let mut app_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![
        &about_item,
        &about_sep,
        &mendeley_item,
        &sync_item,
        &proxy_item,
        &settings_sep,
    ];
    #[cfg(target_os = "macos")]
    {
        app_items.push(&services_item);
        app_items.push(&services_sep);
    }
    app_items.push(&hide_item);
    #[cfg(target_os = "macos")]
    app_items.push(&hide_others_item);
    app_items.push(&quit_sep);
    app_items.push(&quit_item);

    let app_menu = Submenu::with_items(app_handle, pkg_info.name.clone(), true, &app_items)?;

    let files_menu = Submenu::with_items(
        app_handle,
        "Files",
        true,
        &[
            &MenuItem::with_id(app_handle, FILES_REFRESH_LIBRARY, "Refresh Library", true, Some("CmdOrCtrl+R"))?,
            &PredefinedMenuItem::separator(app_handle)?,
            &MenuItem::with_id(app_handle, APP_FILE_STORAGE_SETTINGS, "File Storage Settings...", true, None::<&str>)?,
            &MenuItem::with_id(app_handle, FILES_DOWNLOAD_ARXIV_FILES, "Download arXiv Files", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &MenuItem::with_id(app_handle, APP_DUPLICATE_DOCUMENTS, "Duplicate Documents...", true, None::<&str>)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app_handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app_handle, None)?,
            &PredefinedMenuItem::redo(app_handle, None)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &PredefinedMenuItem::cut(app_handle, None)?,
            &PredefinedMenuItem::copy(app_handle, None)?,
            &PredefinedMenuItem::paste(app_handle, None)?,
            &PredefinedMenuItem::select_all(app_handle, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app_handle,
        "View",
        true,
        &[
            &MenuItem::with_id(app_handle, PDF_VIEW_FIT_WIDTH, "Fit Width", true, Some("CmdOrCtrl+;"))?,
            &zoom_menu(app_handle)?,
            &MenuItem::with_id(app_handle, PDF_VIEW_GO_TO_PAGE, "Go to Page...", true, Some("CmdOrCtrl+G"))?,
            &PredefinedMenuItem::separator(app_handle)?,
            &PredefinedMenuItem::fullscreen(app_handle, None)?,
        ],
    )?;

    let window_menu = Submenu::with_id_and_items(
        app_handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app_handle, None)?,
            &PredefinedMenuItem::maximize(app_handle, None)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &MenuItem::with_id(app_handle, WORKSPACE_CLOSE_ACTIVE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app_handle,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            &MenuItem::with_id(app_handle, HELP_CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &MenuItem::with_id(app_handle, HELP_KEYBOARD_SHORTCUTS, "Keyboard Shortcuts", true, None::<&str>)?,
        ],
    )?;

    Menu::with_items(app_handle, &[&app_menu, &files_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
}

#[cfg(desktop)]
fn zoom_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Submenu<R>> {
    Submenu::with_items(
        manager,
        "Zoom",
        true,
        &[
            &MenuItem::with_id(manager, "pdf-view-zoom-0.75", "75%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-0.9", "90%", true, None::<&str>)?,
            // No accelerator: Cmd+1..9 switch workspace tabs (handled in App.tsx).
            &MenuItem::with_id(manager, "pdf-view-zoom-1", "100%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-1.1", "110%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-1.25", "125%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-1.5", "150%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-1.75", "175%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-2", "200%", true, None::<&str>)?,
        ],
    )
}

fn parse_arxiv_feed(xml: &str, query_title: &str) -> Vec<ArxivMetadata> {
    let mut results = Vec::new();
    let mut rest = xml;

    while let Some(start) = rest.find("<entry>") {
        let after_start = &rest[start + "<entry>".len()..];
        let Some(end) = after_start.find("</entry>") else {
            break;
        };
        let entry = &after_start[..end];
        rest = &after_start[end + "</entry>".len()..];

        let id_url = clean_text(&read_tag(entry, "id"));
        let arxiv_id = normalize_arxiv_id(&id_url);
        let title = clean_text(&read_tag(entry, "title"));
        if arxiv_id.is_empty() || title.is_empty() {
            continue;
        }

        let abstract_ = clean_text(&read_tag(entry, "summary"));
        let published_at = optional_clean_text(read_tag(entry, "published"));
        let updated_at = optional_clean_text(read_tag(entry, "updated"));
        let doi = optional_clean_text(read_tag(entry, "arxiv:doi"));
        let journal_ref = optional_clean_text(read_tag(entry, "arxiv:journal_ref"));
        let authors = read_authors(entry);
        let categories = read_categories(entry);
        let year = published_at
            .as_ref()
            .and_then(|value| value.get(0..4))
            .and_then(|value| value.parse::<i32>().ok());
        let score = score_title_match(query_title, &title);

        results.push(ArxivMetadata {
            url: format!("https://arxiv.org/abs/{arxiv_id}"),
            arxiv_id,
            title,
            authors,
            year,
            abstract_,
            doi,
            published_at,
            updated_at,
            venue: journal_ref.unwrap_or_else(|| "arXiv".to_string()),
            categories,
            score,
        });
    }

    results
}

fn read_authors(entry: &str) -> Vec<ArxivAuthor> {
    let mut authors = Vec::new();
    let mut rest = entry;

    while let Some(start) = rest.find("<author>") {
        let after_start = &rest[start + "<author>".len()..];
        let Some(end) = after_start.find("</author>") else {
            break;
        };
        let author = &after_start[..end];
        let full_name = clean_text(&read_tag(author, "name"));
        if !full_name.is_empty() {
            authors.push(ArxivAuthor { full_name });
        }
        rest = &after_start[end + "</author>".len()..];
    }

    authors
}

fn read_categories(entry: &str) -> Vec<String> {
    entry
        .split("<category")
        .skip(1)
        .filter_map(|chunk| {
            let term_start = chunk.find("term=\"")? + "term=\"".len();
            let term_rest = &chunk[term_start..];
            let term_end = term_rest.find('"')?;
            Some(term_rest[..term_end].to_string())
        })
        .collect()
}

fn parse_youdao_translation(value: &serde_json::Value, fallback_query: String) -> YoudaoTranslation {
    let query = value
        .pointer("/data/query")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.pointer("/query").and_then(serde_json::Value::as_str))
        .unwrap_or(&fallback_query)
        .to_string();
    let phonetic = value
        .pointer("/data/phonetic")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.pointer("/basic/phonetic").and_then(serde_json::Value::as_str))
        .map(ToString::to_string);
    let mut explains = Vec::new();

    if let Some(entries) = value.pointer("/data/entries").and_then(serde_json::Value::as_array) {
        for entry in entries {
            if let Some(explain) = entry.get("explain").and_then(serde_json::Value::as_str) {
                push_unique_explain(&mut explains, explain);
            }
        }
    }

    if let Some(basic_explains) = value.pointer("/basic/explains").and_then(serde_json::Value::as_array) {
        for explain in basic_explains {
            if let Some(explain) = explain.as_str() {
                push_unique_explain(&mut explains, explain);
            }
        }
    }

    YoudaoTranslation {
        page_url: build_youdao_page_url(&query),
        query,
        phonetic,
        explains,
    }
}

fn build_youdao_page_url(query: &str) -> String {
    let mut url = reqwest::Url::parse("https://dict.youdao.com/result").expect("static Youdao URL is valid");
    url.query_pairs_mut()
        .append_pair("word", query)
        .append_pair("lang", "en");
    url.to_string()
}

fn push_unique_explain(explains: &mut Vec<String>, value: &str) {
    let explain = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if !explain.is_empty() && !explains.iter().any(|item| item == &explain) {
        explains.push(explain);
    }
}

fn read_tag(xml: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let Some(start) = xml.find(&open) else {
        return String::new();
    };
    let Some(open_end) = xml[start..].find('>') else {
        return String::new();
    };
    let content_start = start + open_end + 1;
    let close = format!("</{tag}>");
    let Some(content_end) = xml[content_start..].find(&close) else {
        return String::new();
    };
    xml[content_start..content_start + content_end].to_string()
}

fn optional_clean_text(value: String) -> Option<String> {
    let cleaned = clean_text(&value);
    (!cleaned.is_empty()).then_some(cleaned)
}

fn clean_text(value: &str) -> String {
    decode_xml_entities(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

// Keeps the version suffix (2301.12345v2): the versioned id links to the exact
// revision the metadata describes, and the PDF-extraction path keeps it too.
fn normalize_arxiv_id(value: &str) -> String {
    value
        .split("arxiv.org/abs/")
        .nth(1)
        .unwrap_or(value)
        .split(['?', '#', ' '])
        .next()
        .unwrap_or(value)
        .trim_start_matches("arXiv:")
        .to_string()
}

fn score_title_match(query_title: &str, candidate_title: &str) -> f64 {
    let query_tokens = tokenize(query_title);
    let candidate_tokens = tokenize(candidate_title);
    if query_tokens.is_empty() || candidate_tokens.is_empty() {
        return 0.0;
    }

    let hits = query_tokens
        .iter()
        .filter(|token| candidate_tokens.contains(token))
        .count();
    let coverage = hits as f64 / query_tokens.len() as f64;
    let length_penalty = query_tokens.len().abs_diff(candidate_tokens.len()) as f64
        / query_tokens.len().max(candidate_tokens.len()) as f64;
    (coverage - length_penalty * 0.15).max(0.0)
}

fn tokenize(value: &str) -> Vec<String> {
    value
        .to_lowercase()
        .split(|char: char| !char.is_alphanumeric())
        .filter(|token| token.len() > 2)
        .map(ToString::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        build_fts_column_query, cjk_segment, classify_linux_graphics_capability,
        configure_library_connection, ensure_search_index, index_paper_body, init_library_schema,
        normalize_arxiv_id, read_stored_pdf_range_bytes, resolve_stored_file_path,
        search_library_rows, sync_search_index_for_change, validate_proxy_settings, ProxySettings,
        SEARCH_RESULT_LIMIT,
    };

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

    #[test]
    fn classifies_linux_graphics_without_initializing_webgl() {
        assert_eq!(
            classify_linux_graphics_capability(&["0x10de".into()], true, false, false),
            "discrete"
        );
        assert_eq!(
            classify_linux_graphics_capability(&["0x1002".into()], true, true, false),
            "discrete"
        );
        assert_eq!(
            classify_linux_graphics_capability(&["0x8086".into()], true, false, false),
            "hardware"
        );
        assert_eq!(
            classify_linux_graphics_capability(&["0x8086".into()], true, false, true),
            "software"
        );
        assert_eq!(
            classify_linux_graphics_capability(&[], false, false, false),
            "software"
        );
    }

    fn test_connection() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        init_library_schema(&connection).unwrap();
        ensure_search_index(&connection).unwrap();
        connection
    }

    #[test]
    fn library_connections_use_extended_busy_timeout() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        configure_library_connection(&connection).unwrap();

        let timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timeout, 30_000);
    }

    fn upsert_entity(
        connection: &rusqlite::Connection,
        entity_type: &str,
        id: &str,
        data: &str,
        deleted_at: Option<&str>,
    ) {
        connection
            .execute(
                "INSERT INTO entities (entity_type, id, data, updated_at, deleted_at, local_seq)
                 VALUES (?1, ?2, ?3, '2026-01-01T00:00:00Z', ?4, 0)
                 ON CONFLICT(entity_type, id) DO UPDATE SET data = excluded.data, deleted_at = excluded.deleted_at",
                rusqlite::params![entity_type, id, data, deleted_at],
            )
            .unwrap();
        sync_search_index_for_change(connection, entity_type, id, data, deleted_at).unwrap();
    }

    fn paper_json(id: &str, title: &str, authors: &[&str]) -> String {
        let authors = authors
            .iter()
            .map(|name| format!(r#"{{"fullName":"{name}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        format!(r#"{{"id":"{id}","title":"{title}","authors":[{authors}]}}"#)
    }

    fn annotation_json(id: &str, paper_id: &str, quote: &str, comment: &str) -> String {
        format!(r#"{{"id":"{id}","paperId":"{paper_id}","quote":"{quote}","comment":"{comment}"}}"#)
    }

    fn search_ids(connection: &rusqlite::Connection, query: &str) -> Vec<String> {
        search_library_rows(connection, query, SEARCH_RESULT_LIMIT)
            .unwrap()
            .into_iter()
            .map(|hit| hit.paper_id)
            .collect()
    }

    #[test]
    fn fts5_is_available() {
        // Guards the assumption that rusqlite's bundled SQLite ships FTS5.
        let connection = test_connection();
        connection
            .execute(
                "INSERT INTO search_index (paper_id, title, authors, body, notes, body_sha, deleted)
                 VALUES ('p1', 'hello world', '', '', '', '', 0)",
                [],
            )
            .unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM search_index WHERE search_index MATCH '{title} : (\"hello\")'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn segments_cjk_into_single_char_tokens() {
        assert_eq!(cjk_segment("机器学习"), "机 器 学 习");
        assert_eq!(cjk_segment("GPT模型"), "GPT 模 型");
        assert_eq!(cjk_segment("plain latin text"), "plain latin text");
        assert_eq!(cjk_segment("  spaced   out  "), "spaced out");
    }

    #[test]
    fn builds_sanitized_column_queries() {
        assert_eq!(
            build_fts_column_query("attention vaswani", "title"),
            Some(r#"{title} : ("attention" "vaswani"*)"#.to_string())
        );
        // FTS5 operators are neutralized by phrase quoting; embedded quotes stripped.
        assert_eq!(
            build_fts_column_query(r#"a OR b"c"#, "body"),
            Some(r#"{body} : ("a" "OR" "bc"*)"#.to_string())
        );
        // CJK terms become single-char phrases with no prefix star.
        assert_eq!(
            build_fts_column_query("机器学习", "notes"),
            Some(r#"{notes} : ("机 器 学 习")"#.to_string())
        );
        // Operator-only input yields no query at all.
        assert_eq!(build_fts_column_query("- * ( )", "title"), None);
        assert_eq!(build_fts_column_query("   ", "title"), None);
    }

    #[test]
    fn ranks_title_over_body_over_authors_over_notes() {
        let connection = test_connection();
        upsert_entity(&connection, "paper", "p-title", &paper_json("p-title", "Quantum computing survey", &["Alice"]), None);
        upsert_entity(&connection, "paper", "p-body", &paper_json("p-body", "Fast inference", &["Bob"]), None);
        upsert_entity(&connection, "paper", "p-author", &paper_json("p-author", "Graph networks", &["John Quantum"]), None);
        upsert_entity(&connection, "paper", "p-note", &paper_json("p-note", "Sparse attention", &["Carol"]), None);
        index_paper_body(&connection, "p-body", "sha-b", "we study quantum entanglement at scale").unwrap();
        upsert_entity(
            &connection,
            "annotation",
            "a1",
            &annotation_json("a1", "p-note", "quantum supremacy claim", "check this"),
            None,
        );

        let hits = search_library_rows(&connection, "quantum", SEARCH_RESULT_LIMIT).unwrap();
        let ids: Vec<&str> = hits.iter().map(|hit| hit.paper_id.as_str()).collect();
        assert_eq!(ids, ["p-title", "p-body", "p-author", "p-note"]);
        assert_eq!(hits[0].tier, 1);
        assert_eq!(hits[0].matched_fields, ["title"]);
        assert_eq!(hits[1].matched_fields, ["body"]);
        assert_eq!(hits[2].matched_fields, ["authors"]);
        assert_eq!(hits[3].matched_fields, ["notes"]);
        assert!(hits[1].snippet.contains('\u{1}'), "snippet should carry highlight markers");
    }

    #[test]
    fn reports_all_matched_fields_at_best_tier() {
        let connection = test_connection();
        upsert_entity(&connection, "paper", "p1", &paper_json("p1", "Diffusion models", &["Dana"]), None);
        index_paper_body(&connection, "p1", "sha", "diffusion in pixel space").unwrap();

        let hits = search_library_rows(&connection, "diffusion", SEARCH_RESULT_LIMIT).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].tier, 1);
        assert_eq!(hits[0].matched_fields, ["title", "body"]);
    }

    #[test]
    fn matches_cjk_substrings_in_notes() {
        let connection = test_connection();
        upsert_entity(&connection, "paper", "p1", &paper_json("p1", "Attention is all you need", &["Vaswani"]), None);
        upsert_entity(
            &connection,
            "annotation",
            "a1",
            &annotation_json("a1", "p1", "", "注意力机制的核心思想"),
            None,
        );

        assert_eq!(search_ids(&connection, "注意力"), ["p1"]);
        assert_eq!(search_ids(&connection, "机制"), ["p1"]);
        assert!(search_ids(&connection, "力注").is_empty(), "non-consecutive CJK chars must not match");
    }

    #[test]
    fn soft_delete_hides_paper_and_restore_keeps_body() {
        let connection = test_connection();
        let data = paper_json("p1", "Neural tangent kernels", &["Eve"]);
        upsert_entity(&connection, "paper", "p1", &data, None);
        index_paper_body(&connection, "p1", "sha", "tangent kernel dynamics").unwrap();
        assert_eq!(search_ids(&connection, "tangent"), ["p1"]);

        upsert_entity(&connection, "paper", "p1", &data, Some("2026-01-02T00:00:00Z"));
        assert!(search_ids(&connection, "tangent").is_empty());

        upsert_entity(&connection, "paper", "p1", &data, None);
        // Body survives the trash/restore round trip without re-extraction.
        assert_eq!(search_ids(&connection, "kernel dynamics"), ["p1"]);
    }

    #[test]
    fn annotation_soft_delete_reaggregates_notes() {
        let connection = test_connection();
        upsert_entity(&connection, "paper", "p1", &paper_json("p1", "Some title", &[]), None);
        let annotation = annotation_json("a1", "p1", "wavelet transform trick", "");
        upsert_entity(&connection, "annotation", "a1", &annotation, None);
        assert_eq!(search_ids(&connection, "wavelet"), ["p1"]);

        upsert_entity(&connection, "annotation", "a1", &annotation, Some("2026-01-02T00:00:00Z"));
        assert!(search_ids(&connection, "wavelet").is_empty());
    }

    #[test]
    fn rebuilds_index_from_existing_entities() {
        // Simulates upgrading an existing library: entities exist, index does not.
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        init_library_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO entities (entity_type, id, data, updated_at, deleted_at, local_seq)
                 VALUES ('paper', 'p1', ?1, '2026-01-01T00:00:00Z', NULL, 0)",
                [paper_json("p1", "Legacy 论文 title", &["Frank"])],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO entities (entity_type, id, data, updated_at, deleted_at, local_seq)
                 VALUES ('annotation', 'a1', ?1, '2026-01-01T00:00:00Z', NULL, 0)",
                [annotation_json("a1", "p1", "老笔记", "legacy note")],
            )
            .unwrap();

        ensure_search_index(&connection).unwrap();
        assert_eq!(search_ids(&connection, "论文"), ["p1"]);
        assert_eq!(search_ids(&connection, "legacy"), ["p1"]);
        assert_eq!(search_ids(&connection, "老笔记"), ["p1"]);
    }

    #[test]
    fn keeps_version_suffix_on_modern_ids() {
        assert_eq!(normalize_arxiv_id("http://arxiv.org/abs/2301.12345v2"), "2301.12345v2");
        assert_eq!(normalize_arxiv_id("arXiv:2301.12345v1"), "2301.12345v1");
    }

    #[test]
    fn keeps_version_suffix_on_legacy_ids() {
        assert_eq!(normalize_arxiv_id("http://arxiv.org/abs/cs/0112017v3"), "cs/0112017v3");
    }

    #[test]
    fn handles_unversioned_ids_and_url_noise() {
        assert_eq!(normalize_arxiv_id("http://arxiv.org/abs/2301.12345"), "2301.12345");
        assert_eq!(normalize_arxiv_id("https://arxiv.org/abs/2301.12345v2?context=cs"), "2301.12345v2");
    }

    #[test]
    fn accepts_http_and_socks_proxy_urls() {
        for url in ["http://127.0.0.1:8080", "https://proxy.example:8443", "socks5://127.0.0.1:1080", "socks5h://localhost:1080"] {
            assert!(validate_proxy_settings(&ProxySettings {
                enabled: true,
                url: url.to_string(),
                username: String::new(),
                password: String::new(),
            }).is_ok());
        }
    }

    #[test]
    fn rejects_unsupported_proxy_protocols() {
        assert!(validate_proxy_settings(&ProxySettings {
            enabled: true,
            url: "ftp://localhost:21".to_string(),
            username: String::new(),
            password: String::new(),
        }).is_err());
    }
}
