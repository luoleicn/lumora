// SQLite library store: connection lifecycle, schema, the JSON-document
// entity table with its local_seq dirty markers, and the shared meta
// key/value helpers the other modules build on.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(30);

static INITIALIZED_LIBRARY_DATABASES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

const LIBRARY_ENTITY_TYPES: [&str; 5] = ["paper", "fileAsset", "collection", "paperCollection", "annotation"];

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntityUpsert {
    entity_type: String,
    id: String,
    /// Full entity JSON, opaque to the storage layer.
    data: String,
    updated_at: String,
    deleted_at: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntityDelete {
    entity_type: String,
    id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadedEntity {
    entity_type: String,
    data: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadedLibrary {
    entities: Vec<LoadedEntity>,
    meta: std::collections::HashMap<String, String>,
}

pub(crate) fn open_library_db<R: Runtime>(app: &AppHandle<R>) -> Result<rusqlite::Connection, String> {
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
        crate::cloud_sync::init_sync_schema(&connection)?;
        crate::search::ensure_search_index(&connection)?;
        initialized.insert(database_path);
    }

    Ok(connection)
}

fn configure_library_connection(connection: &rusqlite::Connection) -> Result<(), String> {
    connection
        .busy_timeout(DATABASE_BUSY_TIMEOUT)
        .map_err(|error| format!("Failed to configure library database: {error}"))
}

pub(crate) fn init_library_schema(connection: &rusqlite::Connection) -> Result<(), String> {
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
pub(crate) async fn db_load_library(app: AppHandle) -> Result<LoadedLibrary, String> {
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
pub(crate) async fn db_upsert_entities(app: AppHandle, changes: Vec<EntityUpsert>, source: String) -> Result<(), String> {
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
        if let Err(error) = crate::search::sync_search_index_for_change(
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
pub(crate) async fn db_delete_entities(app: AppHandle, entities: Vec<EntityDelete>) -> Result<(), String> {
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
            if let Err(error) = crate::search::refresh_paper_notes(&transaction, &paper_id) {
                eprintln!("Search index note refresh failed for paper {paper_id}: {error}");
            }
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn db_get_meta(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let connection = open_library_db(&app)?;
    Ok(get_meta_value(&connection, &key))
}

#[tauri::command]
pub(crate) async fn db_set_meta(app: AppHandle, key: String, value: String) -> Result<(), String> {
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

pub(crate) fn get_meta_value(connection: &rusqlite::Connection, key: &str) -> Option<String> {
    connection
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| row.get(0))
        .ok()
}

pub(crate) fn set_meta_value(connection: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::configure_library_connection;

    #[test]
    fn library_connections_use_extended_busy_timeout() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        configure_library_connection(&connection).unwrap();

        let timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timeout, 30_000);
    }
}
