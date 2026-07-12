use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use qiniu_sdk::{
    credential::Credential,
    objects::ObjectsManager,
    upload::{AutoUploader, AutoUploaderObjectParams, UploadManager, UploadTokenSigner},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    time::Duration,
};
use tauri::{AppHandle, Manager, Runtime};
use sha2::{Digest, Sha256};

const CONFIG_META_KEY: &str = "qiniuSyncConfigV1";
const DEVICE_META_KEY: &str = "qiniuSyncDeviceId";
const NEXT_BATCH_META_KEY: &str = "qiniuSyncNextBatchSeq";
const LAST_SYNC_META_KEY: &str = "qiniuSyncLastSuccessAt";
const SEEDED_TARGET_META_KEY: &str = "qiniuSyncSeededTarget";
const KEYRING_SERVICE: &str = "com.lumora.desktop.qiniu";
const PREFIX: &str = "lumora/v1";
const PROTOCOL_VERSION: u32 = 1;
const MAX_CHANGES_PER_BATCH: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QiniuSyncConfig {
    pub access_key: String,
    pub bucket: String,
    pub region: Option<String>,
    pub private_domain: String,
    #[serde(default = "default_prefix")]
    pub prefix: String,
    #[serde(default)]
    pub configured: bool,
}

fn default_prefix() -> String {
    PREFIX.to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveQiniuConfigRequest {
    pub access_key: String,
    pub secret_key: String,
    pub bucket: String,
    pub region: Option<String>,
    pub private_domain: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudChange {
    operation_id: String,
    entity: String,
    op: String,
    data: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudBatch {
    protocol_version: u32,
    device_id: String,
    batch_seq: u64,
    created_at: String,
    changes: Vec<CloudChange>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceState {
    protocol_version: u32,
    device_id: String,
    latest_batch_seq: u64,
    updated_at: String,
    #[serde(default)]
    seen: HashMap<String, u64>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    uploaded_changes: usize,
    downloaded_changes: usize,
    uploaded_files: usize,
    downloaded_files: usize,
    arxiv_downloads: usize,
    pending_changes: usize,
    last_synced_at: String,
    errors: Vec<String>,
}

#[derive(Debug)]
struct LocalRow {
    entity_type: String,
    id: String,
    data: String,
    local_seq: i64,
}

fn now_iso() -> String {
    // serde-friendly RFC3339 without adding another time crate.
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

fn keyring_entry(access_key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, access_key).map_err(|error| error.to_string())
}

fn init_sync_schema(connection: &rusqlite::Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_cursors (
               device_id TEXT PRIMARY KEY,
               batch_seq INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS entity_versions (
               entity_type TEXT NOT NULL,
               entity_id TEXT NOT NULL,
               put_time INTEGER NOT NULL,
               device_id TEXT NOT NULL,
               batch_seq INTEGER NOT NULL,
               op_index INTEGER NOT NULL,
               PRIMARY KEY(entity_type, entity_id)
             );
             CREATE TABLE IF NOT EXISTS sync_batches (
               device_id TEXT NOT NULL,
               batch_seq INTEGER NOT NULL,
               body BLOB NOT NULL,
               max_local_seq INTEGER NOT NULL,
               uploaded_put_time INTEGER,
               PRIMARY KEY(device_id, batch_seq)
             );
             CREATE TABLE IF NOT EXISTS sync_inbox (
               device_id TEXT NOT NULL,
               batch_seq INTEGER NOT NULL,
               op_index INTEGER NOT NULL,
               put_time INTEGER NOT NULL,
               change_json TEXT NOT NULL,
               PRIMARY KEY(device_id, batch_seq, op_index)
             );
             CREATE TABLE IF NOT EXISTS local_files (
               file_asset_id TEXT PRIMARY KEY,
               local_path TEXT,
               state TEXT NOT NULL DEFAULT 'missing',
               verified_sha256 TEXT,
               last_error TEXT,
               updated_at TEXT NOT NULL
             );",
        )
        .map_err(|error| error.to_string())?;
    // Pin legacy annotations to the PDF fingerprint they were authored on.
    connection
        .execute(
            "UPDATE entities AS annotation
             SET data=json_set(annotation.data,'$.sourceSha256',(
               SELECT json_extract(file.data,'$.sha256') FROM entities AS file
               WHERE file.entity_type='fileAsset'
                 AND file.id=json_extract(annotation.data,'$.fileId')
             ))
             WHERE annotation.entity_type='annotation'
               AND json_extract(annotation.data,'$.sourceSha256') IS NULL",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_config<R: Runtime>(app: &AppHandle<R>) -> Result<QiniuSyncConfig, String> {
    let connection = super::open_library_db(app)?;
    init_sync_schema(&connection)?;
    let raw = super::get_meta_value(&connection, CONFIG_META_KEY)
        .ok_or_else(|| "Qiniu sync is not configured.".to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("Invalid Qiniu configuration: {error}"))
}

fn load_secret(config: &QiniuSyncConfig) -> Result<String, String> {
    keyring_entry(&config.access_key)?
        .get_password()
        .map_err(|error| format!("Failed to read Qiniu Secret Key from the system keychain: {error}"))
}

fn credential(config: &QiniuSyncConfig, secret: &str) -> Credential {
    Credential::new(config.access_key.clone(), secret.to_string())
}

fn gzip_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&json).map_err(|error| error.to_string())?;
    encoder.finish().map_err(|error| error.to_string())
}

fn ungzip_json<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, String> {
    let mut decoder = GzDecoder::new(bytes);
    let mut json = Vec::new();
    decoder.read_to_end(&mut json).map_err(|error| error.to_string())?;
    serde_json::from_slice(&json).map_err(|error| error.to_string())
}

fn upload_temp_path<R: Runtime>(app: &AppHandle<R>, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|error| error.to_string())?.join("qiniu-sync");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(name);
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path)
}

async fn upload_bytes<R: Runtime>(
    app: &AppHandle<R>,
    config: &QiniuSyncConfig,
    secret: &str,
    key: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let path = upload_temp_path(app, &format!("{}.upload", uuid::Uuid::new_v4()), bytes)?;
    let key = key.to_string();
    let upload_path = path.clone();
    let bucket = config.bucket.clone();
    let access_key = config.access_key.clone();
    let secret = secret.to_string();
    let upload_result = tauri::async_runtime::spawn_blocking(move || {
        let manager = UploadManager::builder(UploadTokenSigner::new_credential_provider(
            Credential::new(access_key, secret),
            bucket,
            Duration::from_secs(3600),
        ))
        .build();
        let params = AutoUploaderObjectParams::builder()
            .object_name(key.clone())
            .file_name(key)
            .build();
        let uploader: AutoUploader = manager.auto_uploader();
        uploader.upload_path(&upload_path, params).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    let _ = std::fs::remove_file(path);
    upload_result.map(|_| ())
}

fn private_url(config: &QiniuSyncConfig, secret: &str, key: &str) -> Result<String, String> {
    let domain = config.private_domain.trim().trim_end_matches('/');
    let domain = if domain.starts_with("http://") || domain.starts_with("https://") {
        domain.to_string()
    } else {
        format!("https://{domain}")
    };
    let encoded = key
        .split('/')
        .map(|part| percent_encoding::utf8_percent_encode(part, percent_encoding::NON_ALPHANUMERIC).to_string())
        .collect::<Vec<_>>()
        .join("/");
    let uri: http::Uri = format!("{domain}/{encoded}").parse::<http::Uri>().map_err(|error| error.to_string())?;
    Ok(credential(config, secret)
        .sign_download_url(uri, Duration::from_secs(900))
        .to_string())
}

async fn download_bytes(config: &QiniuSyncConfig, secret: &str, key: &str) -> Result<Vec<u8>, String> {
    let response = reqwest::get(private_url(config, secret, key)?)
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Qiniu download failed for {key}: {}", response.status()));
    }
    response.bytes().await.map(|bytes| bytes.to_vec()).map_err(|error| error.to_string())
}

fn stat_object(config: &QiniuSyncConfig, secret: &str, key: &str) -> Result<(u64, String, u64), String> {
    let manager = ObjectsManager::new(credential(config, secret));
    let response = manager
        .bucket(&config.bucket)
        .stat_object(key)
        .call()
        .map_err(|error| error.to_string())?;
    let object = response.into_body();
    Ok((object.get_put_time_as_u64(), object.get_hash_as_str().to_string(), object.get_size_as_u64()))
}

fn object_exists(config: &QiniuSyncConfig, secret: &str, key: &str) -> bool {
    stat_object(config, secret, key).is_ok()
}

fn device_id(connection: &rusqlite::Connection) -> Result<String, String> {
    if let Some(id) = super::get_meta_value(connection, DEVICE_META_KEY) {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    super::set_meta_value(connection, DEVICE_META_KEY, &id)?;
    Ok(id)
}

fn next_batch_seq(connection: &rusqlite::Connection) -> u64 {
    super::get_meta_value(connection, NEXT_BATCH_META_KEY)
        .and_then(|value| value.parse().ok())
        .unwrap_or(1)
}

fn collect_local_rows(connection: &rusqlite::Connection) -> Result<Vec<LocalRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT entity_type, id, data, local_seq FROM entities
             WHERE local_seq > 0 ORDER BY local_seq, entity_type, id LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([MAX_CHANGES_PER_BATCH as i64], |row| {
            Ok(LocalRow {
                entity_type: row.get(0)?,
                id: row.get(1)?,
                data: row.get(2)?,
                local_seq: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn seal_batch<R: Runtime>(app: &AppHandle<R>, device: &str) -> Result<Option<(u64, Vec<u8>, Vec<LocalRow>)>, String> {
    let connection = super::open_library_db(app)?;
    init_sync_schema(&connection)?;
    let seq = next_batch_seq(&connection);
    let existing_batch: Option<(Vec<u8>, i64)> = connection
        .query_row(
            "SELECT body,max_local_seq FROM sync_batches WHERE device_id = ?1 AND batch_seq = ?2",
            params![device, seq as i64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some((body, max_local_seq)) = existing_batch {
        let batch: CloudBatch = ungzip_json(&body)?;
        let rows = batch
            .changes
            .iter()
            .map(|change| LocalRow {
                entity_type: change.entity.clone(),
                id: change.data.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                data: change.data.to_string(),
                local_seq: max_local_seq,
            })
            .collect();
        return Ok(Some((seq, body, rows)));
    }
    let rows = collect_local_rows(&connection)?;
    if rows.is_empty() {
        return Ok(None);
    }
    let changes = rows
        .iter()
        .map(|row| {
            let mut data: Value = serde_json::from_str(&row.data).map_err(|error| error.to_string())?;
            if row.entity_type == "fileAsset" {
                if let Some(object) = data.as_object_mut() {
                    object.remove("localPath");
                    object.remove("objectKey");
                    object.remove("downloadState");
                }
            }
            Ok(CloudChange {
                operation_id: uuid::Uuid::new_v4().to_string(),
                entity: row.entity_type.clone(),
                op: if data.get("deletedAt").and_then(Value::as_str).is_some() { "delete" } else { "upsert" }.to_string(),
                data,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let batch = CloudBatch {
        protocol_version: PROTOCOL_VERSION,
        device_id: device.to_string(),
        batch_seq: seq,
        created_at: now_iso(),
        changes,
    };
    let body = gzip_json(&batch)?;
    let max_local_seq = rows.iter().map(|row| row.local_seq).max().unwrap_or(0);
    connection
        .execute(
            "INSERT INTO sync_batches(device_id, batch_seq, body, max_local_seq) VALUES (?1, ?2, ?3, ?4)",
            params![device, seq as i64, body, max_local_seq],
        )
        .map_err(|error| error.to_string())?;
    Ok(Some((seq, gzip_json(&batch)?, rows)))
}

fn version_is_newer(
    incoming: (u64, &str, u64, usize),
    existing: Option<(u64, String, u64, usize)>,
) -> bool {
    existing.map_or(true, |current| {
        (incoming.0, incoming.1, incoming.2, incoming.3)
            > (current.0, current.1.as_str(), current.2, current.3)
    })
}

fn apply_change(
    transaction: &rusqlite::Transaction<'_>,
    change: &CloudChange,
    put_time: u64,
    device: &str,
    batch_seq: u64,
    op_index: usize,
) -> Result<bool, String> {
    let id = change
        .data
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Cloud entity has no id".to_string())?;
    let dirty: i64 = transaction
        .query_row(
            "SELECT local_seq FROM entities WHERE entity_type = ?1 AND id = ?2",
            params![change.entity, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(0);
    if dirty > 0 && device != super::get_meta_value(transaction, DEVICE_META_KEY).as_deref().unwrap_or("") {
        transaction
            .execute(
                "INSERT OR REPLACE INTO sync_inbox(device_id,batch_seq,op_index,put_time,change_json)
                 VALUES (?1,?2,?3,?4,?5)",
                params![device, batch_seq as i64, op_index as i64, put_time as i64, serde_json::to_string(change).unwrap()],
            )
            .map_err(|error| error.to_string())?;
        return Ok(false);
    }
    let existing = transaction
        .query_row(
            "SELECT put_time, device_id, batch_seq, op_index FROM entity_versions
             WHERE entity_type = ?1 AND entity_id = ?2",
            params![change.entity, id],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get(1)?, row.get::<_, i64>(2)? as u64, row.get::<_, i64>(3)? as usize)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if !version_is_newer((put_time, device, batch_seq, op_index), existing) {
        return Ok(false);
    }
    let mut merged_data = change.data.clone();
    if change.entity == "fileAsset" {
        let existing_data: Option<String> = transaction
            .query_row(
                "SELECT data FROM entities WHERE entity_type='fileAsset' AND id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let (Some(target), Some(existing)) = (merged_data.as_object_mut(), existing_data) {
            if let Ok(existing) = serde_json::from_str::<Value>(&existing) {
                for field in ["localPath", "downloadState"] {
                    if let Some(value) = existing.get(field) {
                        target.insert(field.to_string(), value.clone());
                    }
                }
            }
        }
    }
    let data = serde_json::to_string(&merged_data).map_err(|error| error.to_string())?;
    let updated_at = change.data.get("updatedAt").and_then(Value::as_str).unwrap_or("");
    let deleted_at = change.data.get("deletedAt").and_then(Value::as_str);
    transaction
        .execute(
            "INSERT INTO entities(entity_type,id,data,updated_at,deleted_at,local_seq)
             VALUES (?1,?2,?3,?4,?5,0)
             ON CONFLICT(entity_type,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,
               deleted_at=excluded.deleted_at,local_seq=0",
            params![change.entity, id, data, updated_at, deleted_at],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO entity_versions(entity_type,entity_id,put_time,device_id,batch_seq,op_index)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(entity_type,entity_id) DO UPDATE SET put_time=excluded.put_time,
               device_id=excluded.device_id,batch_seq=excluded.batch_seq,op_index=excluded.op_index",
            params![change.entity, id, put_time as i64, device, batch_seq as i64, op_index as i64],
        )
        .map_err(|error| error.to_string())?;
    if let Err(error) = super::sync_search_index_for_change(transaction, &change.entity, id, &data, deleted_at) {
        eprintln!("Search index update failed after cloud sync: {error}");
    }
    Ok(true)
}

fn confirm_local_batch<R: Runtime>(
    app: &AppHandle<R>,
    device: &str,
    seq: u64,
    put_time: u64,
    rows: &[LocalRow],
) -> Result<(), String> {
    let mut connection = super::open_library_db(app)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let batch: CloudBatch = transaction
        .query_row(
            "SELECT body FROM sync_batches WHERE device_id=?1 AND batch_seq=?2",
            params![device, seq as i64],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .map_err(|error| error.to_string())
        .and_then(|bytes| ungzip_json(&bytes))?;
    for (index, change) in batch.changes.iter().enumerate() {
        let id = change.data.get("id").and_then(Value::as_str).ok_or_else(|| "Cloud entity has no id".to_string())?;
        transaction
            .execute(
                "INSERT INTO entity_versions(entity_type,entity_id,put_time,device_id,batch_seq,op_index)
                 VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(entity_type,entity_id) DO UPDATE SET put_time=excluded.put_time,
                   device_id=excluded.device_id,batch_seq=excluded.batch_seq,op_index=excluded.op_index",
                params![change.entity, id, put_time as i64, device, seq as i64, index as i64],
            )
            .map_err(|error| error.to_string())?;
    }
    for row in rows {
        transaction
            .execute(
                "UPDATE entities SET local_seq=0 WHERE entity_type=?1 AND id=?2 AND local_seq<=?3",
                params![row.entity_type, row.id, row.local_seq],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "UPDATE sync_batches SET uploaded_put_time=?3 WHERE device_id=?1 AND batch_seq=?2",
            params![device, seq as i64, put_time as i64],
        )
        .map_err(|error| error.to_string())?;
    super::set_meta_value(&transaction, NEXT_BATCH_META_KEY, &(seq + 1).to_string())?;
    transaction
        .execute(
            "INSERT INTO sync_cursors(device_id,batch_seq) VALUES (?1,?2)
             ON CONFLICT(device_id) DO UPDATE SET batch_seq=MAX(batch_seq,excluded.batch_seq)",
            params![device, seq as i64],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn apply_deferred_inbox<R: Runtime>(app: &AppHandle<R>) -> Result<usize, String> {
    let mut connection = super::open_library_db(app)?;
    let pending = {
        let mut statement = connection
            .prepare("SELECT device_id,batch_seq,op_index,put_time,change_json FROM sync_inbox ORDER BY put_time,device_id,batch_seq,op_index")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)? as u64,
                    row.get::<_, i64>(2)? as usize,
                    row.get::<_, i64>(3)? as u64,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let mut applied = 0;
    for (device, seq, op_index, put_time, json) in pending {
        let change: CloudChange = serde_json::from_str(&json).map_err(|error| error.to_string())?;
        let id = change.data.get("id").and_then(Value::as_str).unwrap_or_default();
        let dirty = transaction
            .query_row(
                "SELECT local_seq FROM entities WHERE entity_type=?1 AND id=?2",
                params![change.entity, id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or(0);
        if dirty == 0 {
            if apply_change(&transaction, &change, put_time, &device, seq, op_index)? {
                applied += 1;
            }
            transaction
                .execute(
                    "DELETE FROM sync_inbox WHERE device_id=?1 AND batch_seq=?2 AND op_index=?3",
                    params![device, seq as i64, op_index as i64],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(applied)
}

async fn upload_device_state<R: Runtime>(
    app: &AppHandle<R>,
    config: &QiniuSyncConfig,
    secret: &str,
    device: &str,
    latest: u64,
) -> Result<(), String> {
    let seen = {
        let connection = super::open_library_db(app)?;
        let mut seen = HashMap::new();
        let mut statement = connection.prepare("SELECT device_id,batch_seq FROM sync_cursors").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, seq) = row.map_err(|e| e.to_string())?;
            seen.insert(id, seq);
        }
        seen
    };
    let state = DeviceState {
        protocol_version: PROTOCOL_VERSION,
        device_id: device.to_string(),
        latest_batch_seq: latest,
        updated_at: now_iso(),
        seen,
    };
    upload_bytes(app, config, secret, &format!("{PREFIX}/devices/{device}.json"), &serde_json::to_vec(&state).unwrap()).await
}

fn list_device_keys(config: &QiniuSyncConfig, secret: &str) -> Result<Vec<String>, String> {
    let manager = ObjectsManager::new(credential(config, secret));
    let bucket = manager.bucket(&config.bucket);
    let mut keys = Vec::new();
    for entry in bucket.list().iter() {
        let entry = entry.map_err(|error| error.to_string())?;
        let key = entry.get_key_as_str();
        if key.starts_with(&format!("{PREFIX}/devices/")) && key.ends_with(".json") {
            keys.push(key.to_string());
        }
    }
    Ok(keys)
}

async fn pull_remote<R: Runtime>(
    app: &AppHandle<R>,
    config: &QiniuSyncConfig,
    secret: &str,
) -> Result<usize, String> {
    let keys = list_device_keys(config, secret)?;
    let mut applied = 0;
    for key in keys {
        let state: DeviceState = serde_json::from_slice(&download_bytes(config, secret, &key).await?)
            .map_err(|error| error.to_string())?;
        if state.protocol_version != PROTOCOL_VERSION {
            return Err(format!("Unsupported cloud protocol version {}", state.protocol_version));
        }
        let current = {
            let connection = super::open_library_db(app)?;
            connection
                .query_row("SELECT batch_seq FROM sync_cursors WHERE device_id=?1", [&state.device_id], |row| row.get::<_, i64>(0))
                .optional()
                .map_err(|error| error.to_string())?
                .unwrap_or(0) as u64
        };
        for seq in (current + 1)..=state.latest_batch_seq {
            let batch_key = format!("{PREFIX}/changes/{}/{seq:020}.json.gz", state.device_id);
            let (put_time, _, _) = stat_object(config, secret, &batch_key)?;
            let batch: CloudBatch = ungzip_json(&download_bytes(config, secret, &batch_key).await?)?;
            if batch.protocol_version != PROTOCOL_VERSION || batch.device_id != state.device_id || batch.batch_seq != seq {
                return Err(format!("Invalid cloud batch {batch_key}"));
            }
            let mut connection = super::open_library_db(app)?;
            let transaction = connection.transaction().map_err(|error| error.to_string())?;
            for (index, change) in batch.changes.iter().enumerate() {
                if apply_change(&transaction, change, put_time, &state.device_id, seq, index)? {
                    applied += 1;
                }
            }
            transaction
                .execute(
                    "INSERT INTO sync_cursors(device_id,batch_seq) VALUES (?1,?2)
                     ON CONFLICT(device_id) DO UPDATE SET batch_seq=excluded.batch_seq",
                    params![state.device_id, seq as i64],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
        }
    }
    Ok(applied)
}

#[tauri::command]
pub async fn qiniu_sync_config<R: Runtime>(app: AppHandle<R>) -> Result<Option<QiniuSyncConfig>, String> {
    let connection = super::open_library_db(&app)?;
    init_sync_schema(&connection)?;
    super::get_meta_value(&connection, CONFIG_META_KEY)
        .map(|raw| serde_json::from_str(&raw).map_err(|error| error.to_string()))
        .transpose()
}

#[tauri::command]
pub async fn qiniu_save_sync_config<R: Runtime>(
    app: AppHandle<R>,
    request: SaveQiniuConfigRequest,
) -> Result<QiniuSyncConfig, String> {
    if request.access_key.trim().is_empty()
        || request.secret_key.is_empty()
        || request.bucket.trim().is_empty()
        || request.private_domain.trim().is_empty()
    {
        return Err("Access Key, Secret Key, Bucket, and private domain are required.".to_string());
    }
    keyring_entry(request.access_key.trim())?
        .set_password(&request.secret_key)
        .map_err(|error| format!("Failed to store Qiniu Secret Key in the system keychain: {error}"))?;
    let config = QiniuSyncConfig {
        access_key: request.access_key.trim().to_string(),
        bucket: request.bucket.trim().to_string(),
        region: request.region.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
        private_domain: request.private_domain.trim().to_string(),
        prefix: PREFIX.to_string(),
        configured: true,
    };
    let mut connection = super::open_library_db(&app)?;
    init_sync_schema(&connection)?;
    let target = format!("{}:{}", config.access_key, config.bucket);
    if super::get_meta_value(&connection, SEEDED_TARGET_META_KEY).as_deref() != Some(&target) {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        let max_seq: i64 = transaction
            .query_row("SELECT COALESCE(MAX(local_seq),0) FROM entities", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        transaction.execute("UPDATE entities SET local_seq=?1", [max_seq + 1]).map_err(|e| e.to_string())?;
        super::set_meta_value(&transaction, SEEDED_TARGET_META_KEY, &target)?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    super::set_meta_value(&connection, CONFIG_META_KEY, &serde_json::to_string(&config).unwrap())?;
    Ok(config)
}

#[tauri::command]
pub async fn qiniu_test_sync_connection<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let key = format!("{PREFIX}/connection-test-{}.json", uuid::Uuid::new_v4());
    upload_bytes(&app, &config, &secret, &key, br#"{"ok":true}"#).await?;
    stat_object(&config, &secret, &key)?;
    ObjectsManager::new(credential(&config, &secret))
        .bucket(&config.bucket)
        .delete_object(&key)
        .call()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn qiniu_disconnect_sync<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let connection = super::open_library_db(&app)?;
    if let Some(raw) = super::get_meta_value(&connection, CONFIG_META_KEY) {
        if let Ok(config) = serde_json::from_str::<QiniuSyncConfig>(&raw) {
            let _ = keyring_entry(&config.access_key).and_then(|entry| entry.delete_credential().map_err(|e| e.to_string()));
        }
    }
    connection.execute("DELETE FROM meta WHERE key=?1", [CONFIG_META_KEY]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn qiniu_upload_blob<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(raw) = request.body() else {
        return Err("Expected a binary file payload.".to_string());
    };
    let bytes = raw.to_vec();
    let expected = request
        .headers()
        .get("x-lumora-sha256")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Missing x-lumora-sha256 header.".to_string())?
        .to_ascii_lowercase();
    let actual = hex::encode(Sha256::digest(&bytes));
    if actual != expected {
        return Err("Local file SHA-256 does not match its FileAsset metadata.".to_string());
    }
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let key = format!("{PREFIX}/blobs/sha256/{expected}");
    if !object_exists(&config, &secret, &key) {
        upload_bytes(&app, &config, &secret, &key, &bytes).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn qiniu_download_blob<R: Runtime>(
    app: AppHandle<R>,
    sha256: String,
) -> Result<tauri::ipc::Response, String> {
    let expected = sha256.trim().to_ascii_lowercase();
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let key = format!("{PREFIX}/blobs/sha256/{expected}");
    let bytes = download_bytes(&config, &secret, &key).await?;
    if hex::encode(Sha256::digest(&bytes)) != expected {
        return Err("Downloaded Qiniu object failed SHA-256 verification.".to_string());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn qiniu_delete_blob<R: Runtime>(app: AppHandle<R>, sha256: String) -> Result<(), String> {
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let key = format!("{PREFIX}/blobs/sha256/{}", sha256.trim().to_ascii_lowercase());
    if !object_exists(&config, &secret, &key) {
        return Ok(());
    }
    ObjectsManager::new(credential(&config, &secret))
        .bucket(&config.bucket)
        .delete_object(&key)
        .call()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn qiniu_sync_library<R: Runtime>(app: AppHandle<R>) -> Result<SyncSummary, String> {
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let device = {
        let connection = super::open_library_db(&app)?;
        init_sync_schema(&connection)?;
        device_id(&connection)?
    };
    // A fixed, identical protocol object makes concurrent first-device setup idempotent.
    let protocol_key = format!("{PREFIX}/protocol.json");
    if !object_exists(&config, &secret, &protocol_key) {
        upload_bytes(&app, &config, &secret, &protocol_key, br#"{"protocolVersion":1}"#).await?;
    }
    let mut summary = SyncSummary::default();
    while let Some((seq, body, rows)) = seal_batch(&app, &device)? {
        let key = format!("{PREFIX}/changes/{device}/{seq:020}.json.gz");
        if !object_exists(&config, &secret, &key) {
            upload_bytes(&app, &config, &secret, &key, &body).await?;
        }
        let (put_time, _, _) = stat_object(&config, &secret, &key)?;
        upload_device_state(&app, &config, &secret, &device, seq).await?;
        confirm_local_batch(&app, &device, seq, put_time, &rows)?;
        summary.uploaded_changes += rows.len();
    }
    summary.downloaded_changes += apply_deferred_inbox(&app)?;
    // Ensure an empty/new device is discoverable too.
    let latest = next_batch_seq(&super::open_library_db(&app)?).saturating_sub(1);
    upload_device_state(&app, &config, &secret, &device, latest).await?;
    summary.downloaded_changes += pull_remote(&app, &config, &secret).await?;
    summary.downloaded_changes += apply_deferred_inbox(&app)?;
    let last_synced_at = now_iso();
    let connection = super::open_library_db(&app)?;
    super::set_meta_value(&connection, LAST_SYNC_META_KEY, &last_synced_at)?;
    summary.pending_changes = connection
        .query_row("SELECT COUNT(*) FROM entities WHERE local_seq>0", [], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())? as usize;
    summary.last_synced_at = last_synced_at;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_version_has_deterministic_tie_breakers() {
        assert!(version_is_newer((10, "b", 1, 0), Some((10, "a".into(), 9, 9))));
        assert!(!version_is_newer((9, "z", 99, 99), Some((10, "a".into(), 1, 0))));
    }

    #[test]
    fn batch_round_trips_through_gzip() {
        let batch = CloudBatch {
            protocol_version: 1,
            device_id: "device-a".into(),
            batch_seq: 4,
            created_at: "now".into(),
            changes: vec![],
        };
        let decoded: CloudBatch = ungzip_json(&gzip_json(&batch).unwrap()).unwrap();
        assert_eq!(decoded.batch_seq, 4);
        assert_eq!(decoded.device_id, "device-a");
    }
}
