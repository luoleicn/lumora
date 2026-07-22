// SQLite library store: connection lifecycle (a small in-process pool),
// schema, the JSON-document entity table with its local_seq dirty markers,
// and the shared meta key/value helpers the other modules build on.

use std::{collections::HashSet, path::{Path, PathBuf}};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

const DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(30);

// Idle connections kept warm for reuse (page cache, prepared statements).
// WAL lets several connections work concurrently, so when the pool is empty a
// caller opens an extra connection instead of waiting on the pool.
const MAX_IDLE_CONNECTIONS: usize = 4;

const LIBRARY_ENTITY_TYPES: [&str; 6] = [
    "paper",
    "fileAsset",
    "collection",
    "paperCollection",
    "paperCollectionReset",
    "annotation",
];

struct LibraryPool {
    /// Set once the schema is initialized; the pool only recycles connections
    /// for an initialized database.
    database_path: Option<PathBuf>,
    idle: Vec<rusqlite::Connection>,
}

static LIBRARY_POOL: Mutex<LibraryPool> = Mutex::new(LibraryPool {
    database_path: None,
    idle: Vec::new(),
});

/// A pooled SQLite connection: derefs to `rusqlite::Connection` and returns
/// the connection to the pool on drop.
pub(crate) struct PooledConnection {
    connection: Option<rusqlite::Connection>,
}

impl std::ops::Deref for PooledConnection {
    type Target = rusqlite::Connection;

    fn deref(&self) -> &rusqlite::Connection {
        self.connection.as_ref().expect("pooled connection present until drop")
    }
}

impl std::ops::DerefMut for PooledConnection {
    fn deref_mut(&mut self) -> &mut rusqlite::Connection {
        self.connection.as_mut().expect("pooled connection present until drop")
    }
}

impl Drop for PooledConnection {
    fn drop(&mut self) {
        let Some(connection) = self.connection.take() else {
            return;
        };
        if let Ok(mut pool) = LIBRARY_POOL.lock() {
            if pool.database_path.is_some() && pool.idle.len() < MAX_IDLE_CONNECTIONS {
                pool.idle.push(connection);
            }
        }
    }
}

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

fn lock_library_pool() -> Result<std::sync::MutexGuard<'static, LibraryPool>, String> {
    LIBRARY_POOL
        .lock()
        .map_err(|_| "Library connection pool lock is poisoned.".to_string())
}

fn new_library_connection(database_path: &Path) -> Result<rusqlite::Connection, String> {
    let connection = rusqlite::Connection::open(database_path)
        .map_err(|error| format!("Failed to open library database: {error}"))?;
    configure_library_connection(&connection)?;
    Ok(connection)
}

pub(crate) fn open_library_db<R: Runtime>(app: &AppHandle<R>) -> Result<PooledConnection, String> {
    let initialized_path = {
        let mut pool = lock_library_pool()?;
        match pool.database_path.clone() {
            Some(path) => {
                if let Some(connection) = pool.idle.pop() {
                    return Ok(PooledConnection { connection: Some(connection) });
                }
                Some(path)
            }
            None => None,
        }
    };
    if let Some(path) = initialized_path {
        return Ok(PooledConnection { connection: Some(new_library_connection(&path)?) });
    }

    // First open in this process: resolve the path and initialize the schema.
    // A racing second caller repeats the initialization; every step is
    // idempotent and serialized by SQLite's own locking.
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("Failed to create app data dir: {error}"))?;
    let database_path = dir.join("lumora.db");
    let connection = new_library_connection(&database_path)?;
    init_library_schema(&connection)?;
    crate::cloud_sync::init_sync_schema(&connection)?;
    crate::search::ensure_search_index(&connection)?;
    lock_library_pool()?.database_path = Some(database_path);
    Ok(PooledConnection { connection: Some(connection) })
}

fn configure_library_connection(connection: &rusqlite::Connection) -> Result<(), String> {
    connection
        .busy_timeout(DATABASE_BUSY_TIMEOUT)
        .map_err(|error| format!("Failed to configure library database: {error}"))?;
    // journal_mode is persistent but harmless to reassert; synchronous is
    // per-connection. NORMAL is the recommended level under WAL: commits skip
    // the per-transaction fsync while WAL keeps the database corruption-safe.
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
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
             CREATE INDEX IF NOT EXISTS idx_entities_annotation_paper
               ON entities(json_extract(data, '$.paperId'))
               WHERE entity_type = 'annotation';
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .map_err(|error| format!("Failed to initialize library database: {error}"))
}

#[tauri::command]
pub(crate) async fn db_load_library(app: AppHandle) -> Result<LoadedLibrary, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|error| format!("Library load task failed: {error}"))?
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

    tauri::async_runtime::spawn_blocking(move || {
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

        {
            let mut affected_membership_papers = HashSet::new();
            let mut upsert = transaction
                .prepare_cached(
                    "INSERT INTO entities (entity_type, id, data, updated_at, deleted_at, local_seq)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(entity_type, id) DO UPDATE SET
                       data = excluded.data,
                       updated_at = excluded.updated_at,
                       deleted_at = excluded.deleted_at,
                       local_seq = excluded.local_seq",
                )
                .map_err(|error| error.to_string())?;

            for change in &changes {
                if !LIBRARY_ENTITY_TYPES.contains(&change.entity_type.as_str()) {
                    return Err(format!("Unknown entity type: {}", change.entity_type));
                }

                let (id, data, updated_at, deleted_at) = if change.entity_type == "paperCollection"
                    || change.entity_type == "paperCollectionReset"
                {
                    let value: serde_json::Value = serde_json::from_str(&change.data).map_err(|error| error.to_string())?;
                    let (id, normalized) = crate::cloud_sync::normalize_membership_entity(&change.entity_type, &value)?;
                    if let Some(paper_id) = normalized.get("paperId").and_then(serde_json::Value::as_str) {
                        affected_membership_papers.insert(paper_id.to_string());
                    }
                    let updated_at = normalized.get("updatedAt").and_then(serde_json::Value::as_str)
                        .unwrap_or(&change.updated_at).to_string();
                    let deleted_at = normalized.get("deletedAt").and_then(serde_json::Value::as_str).map(str::to_string);
                    (id, serde_json::to_string(&normalized).map_err(|error| error.to_string())?, updated_at, deleted_at)
                } else {
                    (change.id.clone(), change.data.clone(), change.updated_at.clone(), change.deleted_at.clone())
                };

                upsert
                    .execute(rusqlite::params![
                        change.entity_type,
                        id,
                        data,
                        updated_at,
                        deleted_at,
                        next_seq
                    ])
                    .map_err(|error| error.to_string())?;

                // Index maintenance must never fail the user's save: log and move on.
                if let Err(error) = crate::search::sync_search_index_for_change(
                    &transaction,
                    &change.entity_type,
                    &id,
                    &data,
                    deleted_at.as_deref(),
                ) {
                    eprintln!(
                        "Search index update failed for {} {}: {error}",
                        change.entity_type, id
                    );
                }
            }
            drop(upsert);
            for paper_id in affected_membership_papers {
                crate::cloud_sync::reconcile_paper_memberships(&transaction, &paper_id)?;
            }
        }

        transaction.commit().map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Library write task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn db_delete_entities(app: AppHandle, entities: Vec<EntityDelete>) -> Result<(), String> {
    if entities.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
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
                transaction
                    .execute("DELETE FROM search_body WHERE paper_id = ?1", [&entity.id])
                    .map_err(|error| error.to_string())?;
            } else if let Some(paper_id) = annotation_paper_id {
                if let Err(error) = crate::search::refresh_paper_notes(&transaction, &paper_id) {
                    eprintln!("Search index note refresh failed for paper {paper_id}: {error}");
                }
            }
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Library delete task failed: {error}"))?
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
    use super::{configure_library_connection, init_library_schema};

    #[test]
    fn library_connections_use_extended_busy_timeout_and_normal_synchronous() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        configure_library_connection(&connection).unwrap();

        let timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timeout, 30_000);

        let synchronous: i64 = connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(synchronous, 1, "WAL pairs with synchronous=NORMAL");
    }

    #[test]
    fn annotation_paper_lookups_use_the_expression_index() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        init_library_schema(&connection).unwrap();

        let plan: String = connection
            .query_row(
                "EXPLAIN QUERY PLAN SELECT data FROM entities
                 WHERE entity_type = 'annotation' AND json_extract(data, '$.paperId') = 'p1'",
                [],
                |row| row.get(3),
            )
            .unwrap();
        assert!(
            plan.contains("idx_entities_annotation_paper"),
            "annotation lookups should hit the expression index, got plan: {plan}"
        );
    }
}
