use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use hmac::{Hmac, Mac};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Runtime};
use sha2::{Digest, Sha256};

const CONFIG_META_KEY: &str = "qiniuSyncConfigV1";
const DEVICE_META_KEY: &str = "qiniuSyncDeviceId";
const NEXT_BATCH_META_KEY: &str = "qiniuSyncNextBatchSeq";
const LAST_SYNC_META_KEY: &str = "qiniuSyncLastSuccessAt";
const SEEDED_TARGET_META_KEY: &str = "qiniuSyncSeededTarget";
const PROTOCOL_VERIFIED_TARGET_META_KEY: &str = "qiniuSyncProtocolVerifiedTarget";
const PUBLISHED_DEVICE_STATE_META_KEY: &str = "qiniuSyncPublishedDeviceState";
const KEYRING_SERVICE: &str = "com.lumora.desktop.qiniu";
const PREFIX: &str = "lumora/v1";
const PROTOCOL_VERSION: u32 = 1;
const MAX_CHANGES_PER_BATCH: usize = 500;
const DEVICE_STATE_REPUBLISH_INTERVAL_MS: u64 = 24 * 60 * 60 * 1_000;

// A single shared reqwest client. A server that accepts a connection and never
// responds must fail fast rather than hang the whole sync forever, which would
// leave the UI stuck and block manual re-syncs.
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Hashes confirmed to exist in the bucket during one frontend sync run:
/// seeded by the preflight LIST (`seeded` then also proves absence) and
/// extended by HEAD/PUT confirmations, so no existence request is repeated
/// within a run. A different run id starts fresh, so knowledge never leaks
/// across runs — mirroring the per-sync caches the frontend used to keep.
struct KnownCloudRun {
    run_id: String,
    seeded: bool,
    hashes: HashSet<String>,
}

static KNOWN_CLOUD_RUN: Mutex<Option<KnownCloudRun>> = Mutex::new(None);

fn known_cloud_run_apply<T>(run_id: &str, action: impl FnOnce(&mut KnownCloudRun) -> T) -> Option<T> {
    let mut guard = KNOWN_CLOUD_RUN.lock().ok()?;
    let matches_run = matches!(guard.as_ref(), Some(run) if run.run_id == run_id);
    if !matches_run {
        *guard = Some(KnownCloudRun {
            run_id: run_id.to_string(),
            seeded: false,
            hashes: HashSet::new(),
        });
    }
    guard.as_mut().map(action)
}

#[derive(Debug, Default)]
struct NetworkCounters {
    request_count: AtomicU64,
    put_requests: AtomicU64,
    get_requests: AtomicU64,
    head_requests: AtomicU64,
    delete_requests: AtomicU64,
    uploaded_bytes: AtomicU64,
    downloaded_bytes: AtomicU64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStats {
    request_count: u64,
    put_requests: u64,
    get_requests: u64,
    head_requests: u64,
    delete_requests: u64,
    uploaded_bytes: u64,
    downloaded_bytes: u64,
}

impl NetworkCounters {
    fn record_request(&self, method: &reqwest::Method, payload_bytes: usize) {
        self.request_count.fetch_add(1, Ordering::Relaxed);
        match *method {
            reqwest::Method::PUT => {
                self.put_requests.fetch_add(1, Ordering::Relaxed);
                self.uploaded_bytes.fetch_add(payload_bytes as u64, Ordering::Relaxed);
            }
            reqwest::Method::GET => {
                self.get_requests.fetch_add(1, Ordering::Relaxed);
            }
            reqwest::Method::HEAD => {
                self.head_requests.fetch_add(1, Ordering::Relaxed);
            }
            reqwest::Method::DELETE => {
                self.delete_requests.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }

    fn record_download(&self, bytes: usize) {
        self.downloaded_bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn snapshot(&self) -> NetworkStats {
        NetworkStats {
            request_count: self.request_count.load(Ordering::Relaxed),
            put_requests: self.put_requests.load(Ordering::Relaxed),
            get_requests: self.get_requests.load(Ordering::Relaxed),
            head_requests: self.head_requests.load(Ordering::Relaxed),
            delete_requests: self.delete_requests.load(Ordering::Relaxed),
            uploaded_bytes: self.uploaded_bytes.load(Ordering::Relaxed),
            downloaded_bytes: self.downloaded_bytes.load(Ordering::Relaxed),
        }
    }
}

fn http_client() -> reqwest::Client {
    HTTP_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(120))
                .build()
                .expect("failed to build reqwest client")
        })
        .clone()
}

type HmacSha256 = Hmac<Sha256>;

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Percent-encodes per RFC 3986 the way AWS SigV4 canonicalisation requires:
/// everything except the unreserved set is escaped, and `/` is kept only inside
/// object-key paths (`encode_slash = false`).
fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(byte as char),
            b'/' if !encode_slash => out.push('/'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Breaks a Unix timestamp into the two forms SigV4 needs: the full
/// `YYYYMMDDTHHMMSSZ` amz-date and the `YYYYMMDD` datestamp, in UTC.
/// Uses Howard Hinnant's civil-from-days algorithm so we avoid a date crate.
fn amz_timestamps(secs: u64) -> (String, String) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    (
        format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z"),
        format!("{year:04}{month:02}{day:02}"),
    )
}

/// How the bucket is addressed. Path-style keeps the bucket in the request path
/// (`s3.<region>.qiniucs.com/<bucket>/<key>`); virtual-hosted bakes it into the
/// host (`<bucket>.s3.<region>.qiniucs.com/<key>`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AddressingStyle {
    Path,
    VirtualHosted,
}

/// A resolved Qiniu S3-compatible endpoint. `base` is `scheme://host[:port]`,
/// `host_header` is exactly what goes into the (signed) `Host` header, `region`
/// scopes the SigV4 credential, and `style` decides where the bucket goes.
struct S3Target {
    base: String,
    host_header: String,
    region: String,
    style: AddressingStyle,
}

/// Extracts `(region, addressing_style)` from a Qiniu S3 host. Handles path-style
/// `s3.<region>.qiniucs.com`, virtual-hosted `<bucket>.s3.<region>.qiniucs.com`,
/// and the older dash form `s3-<region>.qiniucs.com`. Returns None for custom
/// domains, where the region must be set explicitly in Settings → Cloud Sync.
fn parse_host(host: &str) -> Option<(String, AddressingStyle)> {
    let lower = host.to_ascii_lowercase();
    let core = lower.strip_suffix(".qiniucs.com")?;
    // Path-style: the whole host is the S3 endpoint.
    if let Some(region) = core.strip_prefix("s3.").or_else(|| core.strip_prefix("s3-")) {
        return (!region.is_empty()).then(|| (region.to_string(), AddressingStyle::Path));
    }
    // Virtual-hosted: the bucket is the label(s) before `.s3.`/`.s3-`.
    let region = core
        .find(".s3.")
        .or_else(|| core.find(".s3-"))
        .map(|index| &core[index + 4..])?;
    (!region.is_empty()).then(|| (region.to_string(), AddressingStyle::VirtualHosted))
}

fn resolve_target(config: &QiniuSyncConfig) -> Result<S3Target, String> {
    let raw = config.private_domain.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err("The S3 endpoint (private domain) is not configured.".to_string());
    }
    let with_scheme = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let uri: http::Uri = with_scheme.parse().map_err(|error| format!("Invalid S3 endpoint '{raw}': {error}"))?;
    let scheme = uri.scheme_str().unwrap_or("https").to_string();
    let host = uri
        .host()
        .ok_or_else(|| format!("S3 endpoint '{raw}' has no host."))?
        .to_string();
    let default_port = if scheme == "http" { 80 } else { 443 };
    let (base, host_header) = match uri.port_u16() {
        Some(port) if port != default_port => (format!("{scheme}://{host}:{port}"), format!("{host}:{port}")),
        _ => (format!("{scheme}://{host}"), host.clone()),
    };
    // Custom domains that don't match a Qiniu host default to path-style, and
    // require the region to be supplied explicitly.
    let parsed = parse_host(&host);
    let style = parsed.as_ref().map_or(AddressingStyle::Path, |(_, style)| *style);
    let region = config
        .region
        .as_deref()
        .map(str::trim)
        .filter(|region| !region.is_empty())
        .map(String::from)
        .or_else(|| parsed.map(|(region, _)| region))
        .ok_or_else(|| {
            format!(
                "Cannot determine the S3 region from the endpoint '{host}'. \
                 Expected a host like 's3.<region>.qiniucs.com' or '<bucket>.s3.<region>.qiniucs.com', \
                 or set the Region field in Settings → Cloud Sync."
            )
        })?;
    Ok(S3Target { base, host_header, region, style })
}

/// Canonical request URI for an object under this target's addressing style.
/// Path-style prepends the bucket; virtual-hosted keys off the root.
fn object_uri(target: &S3Target, config: &QiniuSyncConfig, key: &str) -> String {
    match target.style {
        AddressingStyle::Path => format!("/{}/{}", uri_encode(&config.bucket, true), uri_encode(key, false)),
        AddressingStyle::VirtualHosted => format!("/{}", uri_encode(key, false)),
    }
}

/// Canonical request URI for a bucket-level operation (e.g. ListObjectsV2).
fn bucket_uri(target: &S3Target, config: &QiniuSyncConfig) -> String {
    match target.style {
        AddressingStyle::Path => format!("/{}", uri_encode(&config.bucket, true)),
        AddressingStyle::VirtualHosted => "/".to_string(),
    }
}

/// The resource a request targets: a single object by key, or the bucket itself
/// (for listing). The canonical URI is derived from this plus the addressing style.
enum S3Resource<'a> {
    Object(&'a str),
    Bucket,
}

/// Signs and sends one S3 request with SigV4 header authentication. `query` holds
/// raw (unencoded) key/value pairs.
async fn s3_send(
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
    method: reqwest::Method,
    resource: S3Resource<'_>,
    query: &[(&str, &str)],
    body: Option<Vec<u8>>,
) -> Result<reqwest::Response, String> {
    let target = resolve_target(config)?;
    let canonical_uri = match resource {
        S3Resource::Object(key) => object_uri(&target, config, key),
        S3Resource::Bucket => bucket_uri(&target, config),
    };
    let payload = body.as_deref().unwrap_or(&[]);
    let payload_hash = sha256_hex(payload);

    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs();
    let (amz_date, datestamp) = amz_timestamps(now);

    // Canonical query string: sorted by encoded key, both key and value encoded.
    let mut encoded: Vec<(String, String)> = query
        .iter()
        .map(|(key, value)| (uri_encode(key, true), uri_encode(value, true)))
        .collect();
    encoded.sort();
    let canonical_query = encoded
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_headers =
        format!("host:{}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n", target.host_header);
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );

    let scope = format!("{datestamp}/{}/s3/aws4_request", target.region);
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", sha256_hex(canonical_request.as_bytes()));

    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), datestamp.as_bytes());
    let k_region = hmac_sha256(&k_date, target.region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        config.access_key
    );

    let url = if canonical_query.is_empty() {
        format!("{}{canonical_uri}", target.base)
    } else {
        format!("{}{canonical_uri}?{canonical_query}", target.base)
    };

    counters.record_request(&method, payload.len());
    let mut builder = http_client()
        .request(method, &url)
        .header("x-amz-date", &amz_date)
        .header("x-amz-content-sha256", &payload_hash)
        .header("Authorization", &authorization);
    if let Some(body) = body {
        builder = builder.body(body);
    }
    builder.send().await.map_err(|error| error.to_string())
}

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QiniuObjectStat {
    pub exists: bool,
    pub size: Option<u64>,
    pub stats: NetworkStats,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobUploadResult {
    pub uploaded: bool,
    pub stats: NetworkStats,
    pub error: Option<BlobUploadIssue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobUploadIssue {
    pub kind: BlobUploadIssueKind,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BlobUploadIssueKind {
    File,
    Fatal,
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishedDeviceState {
    target: String,
    device_id: String,
    latest_batch_seq: u64,
    seen: HashMap<String, u64>,
    published_at_ms: u64,
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
    request_count: u64,
    put_requests: u64,
    get_requests: u64,
    head_requests: u64,
    delete_requests: u64,
    uploaded_bytes: u64,
    downloaded_bytes: u64,
}

impl SyncSummary {
    fn set_network_stats(&mut self, stats: NetworkStats) {
        self.request_count = stats.request_count;
        self.put_requests = stats.put_requests;
        self.get_requests = stats.get_requests;
        self.head_requests = stats.head_requests;
        self.delete_requests = stats.delete_requests;
        self.uploaded_bytes = stats.uploaded_bytes;
        self.downloaded_bytes = stats.downloaded_bytes;
    }
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

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn sync_target_id(config: &QiniuSyncConfig) -> String {
    serde_json::to_string(&(
        &config.access_key,
        &config.bucket,
        config.region.as_deref().unwrap_or_default(),
        &config.private_domain,
        &config.prefix,
    ))
    .expect("Qiniu target identity is always serializable")
}

fn keyring_entry(access_key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, access_key).map_err(|error| error.to_string())
}

pub(crate) fn init_sync_schema(connection: &rusqlite::Connection) -> Result<(), String> {
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
             CREATE TABLE IF NOT EXISTS sync_device_heads (
               target TEXT NOT NULL,
               device_id TEXT NOT NULL,
               etag TEXT NOT NULL,
               latest_batch_seq INTEGER NOT NULL,
               PRIMARY KEY(target, device_id)
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
    let connection = crate::db::open_library_db(app)?;
    let raw = crate::db::get_meta_value(&connection, CONFIG_META_KEY)
        .ok_or_else(|| "Qiniu sync is not configured.".to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("Invalid Qiniu configuration: {error}"))
}

fn load_secret(config: &QiniuSyncConfig) -> Result<String, String> {
    keyring_entry(&config.access_key)?
        .get_password()
        .map_err(|error| format!("Failed to read Qiniu Secret Key from the system keychain: {error}"))
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

#[derive(Debug)]
struct UploadError {
    kind: BlobUploadIssueKind,
    message: String,
}

impl UploadError {
    fn fatal(message: impl Into<String>) -> Self {
        Self { kind: BlobUploadIssueKind::Fatal, message: message.into() }
    }

    fn file(message: impl Into<String>) -> Self {
        Self { kind: BlobUploadIssueKind::File, message: message.into() }
    }
}

fn upload_issue_kind(status: reqwest::StatusCode, body: &str) -> BlobUploadIssueKind {
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE
        || body.contains("EntityTooLarge")
        || body.contains("RequestEntityTooLarge")
    {
        BlobUploadIssueKind::File
    } else {
        BlobUploadIssueKind::Fatal
    }
}

impl std::fmt::Display for UploadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

async fn upload_bytes(
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
    key: &str,
    bytes: &[u8],
) -> Result<u64, UploadError> {
    let response = s3_send(config, secret, counters, reqwest::Method::PUT, S3Resource::Object(key), &[], Some(bytes.to_vec()))
        .await
        .map_err(|error| UploadError::fatal(format!("Qiniu upload of {key} failed: {error}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let message = format!("Qiniu upload of {key} failed: {status}. Body: {body}");
        if upload_issue_kind(status, &body) == BlobUploadIssueKind::File {
            return Err(UploadError::file(message));
        }
        return Err(UploadError::fatal(message));
    }
    // The PUT response carries the server clock (`Date`), which is the same
    // second-granularity source a later HEAD would report as `Last-Modified`.
    // Deriving put_time from it avoids a verification HEAD per upload; endpoint
    // or bucket misconfiguration is still caught by the connection test, which
    // round-trips upload → stat → download explicitly.
    Ok(put_time_from_response(&response))
}

/// GET an object, returning its bytes together with the put_time derived from
/// the response's `Last-Modified` header — so callers that need the version
/// timestamp don't have to issue a separate HEAD first.
async fn download_object(
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
    key: &str,
) -> Result<(Vec<u8>, u64), String> {
    let response = s3_send(config, secret, counters, reqwest::Method::GET, S3Resource::Object(key), &[], None).await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        counters.record_download(body.len());
        return Err(format!(
            "Qiniu download failed for {key}: {status}. Body: {body}. \
             Verify that the S3 endpoint, bucket, region, Access Key and Secret Key in \
             Settings → Cloud Sync are correct for this bucket."
        ));
    }
    let put_time = put_time_from_response(&response);
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    counters.record_download(bytes.len());
    Ok((bytes.to_vec(), put_time))
}

async fn download_bytes(
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
    key: &str,
) -> Result<Vec<u8>, String> {
    Ok(download_object(config, secret, counters, key).await?.0)
}

/// Reads the object size from the `Content-Length` header. reqwest's
/// `Response::content_length()` reports the *body* size hint, which is always 0
/// for a HEAD response, so it must not be used for stat calls.
fn content_length_header(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

/// Qiniu's native putTime is measured in 100-nanosecond units since the Unix
/// epoch. S3 only exposes second-granularity `Last-Modified`, so we scale it to
/// the same units — this keeps the last-write-wins ordering key comparable with
/// version rows written by the previous Qiniu-native implementation.
fn put_time_from_response(response: &reqwest::Response) -> u64 {
    let headers = response.headers();
    let system_time = headers
        .get(reqwest::header::LAST_MODIFIED)
        .or_else(|| headers.get(reqwest::header::DATE))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| httpdate::parse_http_date(value).ok())
        .unwrap_or_else(SystemTime::now);
    system_time.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) * 10_000_000
}

/// Returns `(put_time, etag, size)`. The etag is unused by callers but kept for
/// signature parity with the previous implementation.
async fn stat_object(
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
    key: &str,
) -> Result<(u64, String, u64), String> {
    let response = s3_send(config, secret, counters, reqwest::Method::HEAD, S3Resource::Object(key), &[], None).await?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("Qiniu stat of {key} failed: {status}."));
    }
    let put_time = put_time_from_response(&response);
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim_matches('"').to_string())
        .unwrap_or_default();
    let size = content_length_header(&response).unwrap_or(0);
    Ok((put_time, etag, size))
}

async fn stat_object_if_exists(
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
    key: &str,
) -> Result<Option<(u64, u64)>, String> {
    let response = s3_send(config, secret, counters, reqwest::Method::HEAD, S3Resource::Object(key), &[], None).await?;
    match classify_stat_status(response.status()) {
        Ok(true) => return Ok(None),
        Ok(false) => {}
        Err(status) => return Err(format!("Qiniu stat of {key} failed: {status}.")),
    }
    Ok(Some((put_time_from_response(&response), content_length_header(&response).unwrap_or(0))))
}

fn classify_stat_status(status: reqwest::StatusCode) -> Result<bool, reqwest::StatusCode> {
    if status == reqwest::StatusCode::NOT_FOUND {
        Ok(true)
    } else if status.is_success() {
        Ok(false)
    } else {
        Err(status)
    }
}

fn device_id(connection: &rusqlite::Connection) -> Result<String, String> {
    if let Some(id) = crate::db::get_meta_value(connection, DEVICE_META_KEY) {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    crate::db::set_meta_value(connection, DEVICE_META_KEY, &id)?;
    Ok(id)
}

fn next_batch_seq(connection: &rusqlite::Connection) -> u64 {
    crate::db::get_meta_value(connection, NEXT_BATCH_META_KEY)
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
    let connection = crate::db::open_library_db(app)?;
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
    Ok(Some((seq, body, rows)))
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
    if dirty > 0 && device != crate::db::get_meta_value(transaction, DEVICE_META_KEY).as_deref().unwrap_or("") {
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
    if let Err(error) = crate::search::sync_search_index_for_change(transaction, &change.entity, id, &data, deleted_at) {
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
    let mut connection = crate::db::open_library_db(app)?;
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
    crate::db::set_meta_value(&transaction, NEXT_BATCH_META_KEY, &(seq + 1).to_string())?;
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
    let mut connection = crate::db::open_library_db(app)?;
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

fn current_device_state<R: Runtime>(
    app: &AppHandle<R>,
    device: &str,
    latest: u64,
) -> Result<DeviceState, String> {
    let seen = {
        let connection = crate::db::open_library_db(app)?;
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
    let mut seen = seen;
    seen.insert(device.to_string(), latest);
    Ok(DeviceState {
        protocol_version: PROTOCOL_VERSION,
        device_id: device.to_string(),
        latest_batch_seq: latest,
        updated_at: now_iso(),
        seen,
    })
}

fn device_state_needs_publish<R: Runtime>(
    app: &AppHandle<R>,
    target: &str,
    state: &DeviceState,
) -> Result<bool, String> {
    let connection = crate::db::open_library_db(app)?;
    let Some(raw) = crate::db::get_meta_value(&connection, PUBLISHED_DEVICE_STATE_META_KEY) else {
        return Ok(true);
    };
    let Ok(published) = serde_json::from_str::<PublishedDeviceState>(&raw) else {
        return Ok(true);
    };
    Ok(!published_device_state_is_current(&published, target, state, now_millis()))
}

fn published_device_state_is_current(
    published: &PublishedDeviceState,
    target: &str,
    state: &DeviceState,
    now_ms: u64,
) -> bool {
    published.target == target
        && published.device_id == state.device_id
        && published.latest_batch_seq == state.latest_batch_seq
        && published.seen == state.seen
        && now_ms.saturating_sub(published.published_at_ms) < DEVICE_STATE_REPUBLISH_INTERVAL_MS
}

async fn upload_device_state<R: Runtime>(
    app: &AppHandle<R>,
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
    target: &str,
    state: &DeviceState,
) -> Result<(), String> {
    upload_bytes(
        config,
        secret,
        counters,
        &format!("{PREFIX}/devices/{}.json", state.device_id),
        &serde_json::to_vec(&state).unwrap(),
    )
    .await
    .map_err(|error| error.to_string())
    .map(|_| ())?;
    let published = PublishedDeviceState {
        target: target.to_string(),
        device_id: state.device_id.clone(),
        latest_batch_seq: state.latest_batch_seq,
        seen: state.seen.clone(),
        published_at_ms: now_millis(),
    };
    let connection = crate::db::open_library_db(app)?;
    crate::db::set_meta_value(
        &connection,
        PUBLISHED_DEVICE_STATE_META_KEY,
        &serde_json::to_string(&published).map_err(|error| error.to_string())?,
    )
}

async fn delete_object(
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
    key: &str,
) -> Result<(), String> {
    let response = s3_send(config, secret, counters, reqwest::Method::DELETE, S3Resource::Object(key), &[], None).await?;
    // S3 DELETE is idempotent: a 204 (deleted) and a 404 (already gone) are both
    // success from our perspective.
    if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format!("Qiniu delete of {key} failed: {status}. Body: {body}"))
}

/// Extracts the text of every `<tag>…</tag>` occurrence in an XML document.
/// The keys and continuation tokens we read are plain ASCII with no XML
/// entities, so this deliberately avoids pulling in a full XML parser.
fn extract_xml_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut values = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        values.push(after[..end].to_string());
        rest = &after[end + close.len()..];
    }
    values
}

#[derive(Debug, PartialEq, Eq)]
struct ListedDeviceObject {
    key: String,
    etag: String,
}

fn extract_listed_device_objects(xml: &str, prefix: &str) -> Vec<ListedDeviceObject> {
    extract_xml_values(xml, "Contents")
        .into_iter()
        .filter_map(|contents| {
            let key = extract_xml_values(&contents, "Key").into_iter().next()?;
            if !key.starts_with(prefix) || !key.ends_with(".json") {
                return None;
            }
            let etag = extract_xml_values(&contents, "ETag")
                .into_iter()
                .next()
                .unwrap_or_default()
                .trim()
                .trim_matches('"')
                .to_string();
            Some(ListedDeviceObject { key, etag })
        })
        .collect()
}

fn device_id_from_head_key<'a>(key: &'a str, prefix: &str) -> Option<&'a str> {
    key.strip_prefix(prefix).and_then(|value| value.strip_suffix(".json"))
}

fn device_head_needs_fetch(etag: &str, cached: Option<&(String, u64)>, current: u64) -> bool {
    etag.is_empty() || !cached.is_some_and(|(cached_etag, latest)| cached_etag == etag && current >= *latest)
}

/// Runs a paginated ListObjectsV2 under `prefix` and returns the raw XML of
/// every page. Callers extract the fields they care about.
async fn list_object_pages(
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let mut pages = Vec::new();
    let mut continuation: Option<String> = None;
    loop {
        let mut query: Vec<(&str, &str)> = vec![("list-type", "2"), ("prefix", prefix)];
        if let Some(token) = continuation.as_deref() {
            query.push(("continuation-token", token));
        }
        let response = s3_send(config, secret, counters, reqwest::Method::GET, S3Resource::Bucket, &query, None).await?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            counters.record_download(body.len());
            return Err(format!("Qiniu list of {prefix} failed: {status}. Body: {body}"));
        }
        let xml = response.text().await.map_err(|error| error.to_string())?;
        counters.record_download(xml.len());
        let next = extract_xml_values(&xml, "NextContinuationToken").into_iter().next();
        pages.push(xml);
        match next {
            Some(token) if !token.is_empty() => continuation = Some(token),
            _ => break,
        }
    }
    Ok(pages)
}

async fn list_device_objects(
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
) -> Result<Vec<ListedDeviceObject>, String> {
    let prefix = format!("{PREFIX}/devices/");
    let mut objects = Vec::new();
    for xml in list_object_pages(config, secret, counters, &prefix).await? {
        objects.extend(extract_listed_device_objects(&xml, &prefix));
    }
    Ok(objects)
}

fn extract_listed_blob_sizes(xml: &str, prefix: &str) -> Vec<(String, u64)> {
    extract_xml_values(xml, "Contents")
        .into_iter()
        .filter_map(|contents| {
            let key = extract_xml_values(&contents, "Key").into_iter().next()?;
            let sha256 = key.strip_prefix(prefix)?;
            if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            let size = extract_xml_values(&contents, "Size").into_iter().next()?.trim().parse().ok()?;
            Some((sha256.to_ascii_lowercase(), size))
        })
        .collect()
}

async fn pull_remote<R: Runtime>(
    app: &AppHandle<R>,
    config: &QiniuSyncConfig,
    secret: &str,
    counters: &NetworkCounters,
    local_device: &str,
    target: &str,
) -> Result<usize, String> {
    let objects = list_device_objects(config, secret, counters).await?;
    let device_prefix = format!("{PREFIX}/devices/");
    let mut applied = 0;
    for object in objects {
        let Some(listed_device) = device_id_from_head_key(&object.key, &device_prefix) else {
            continue;
        };
        if listed_device == local_device {
            continue;
        }
        let (current, cached_head) = {
            let connection = crate::db::open_library_db(app)?;
            let current = connection
                .query_row("SELECT batch_seq FROM sync_cursors WHERE device_id=?1", [listed_device], |row| row.get::<_, i64>(0))
                .optional()
                .map_err(|error| error.to_string())?
                .unwrap_or(0) as u64;
            let cached = connection
                .query_row(
                    "SELECT etag,latest_batch_seq FROM sync_device_heads WHERE target=?1 AND device_id=?2",
                    params![target, listed_device],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            (current, cached)
        };
        if !device_head_needs_fetch(&object.etag, cached_head.as_ref(), current) {
            continue;
        }

        let state: DeviceState = serde_json::from_slice(&download_bytes(config, secret, counters, &object.key).await?)
            .map_err(|error| error.to_string())?;
        if state.protocol_version != PROTOCOL_VERSION {
            return Err(format!("Unsupported cloud protocol version {}", state.protocol_version));
        }
        if state.device_id != listed_device {
            return Err(format!("Qiniu device head {} identifies itself as {}", object.key, state.device_id));
        }
        for seq in (current + 1)..=state.latest_batch_seq {
            let batch_key = format!("{PREFIX}/changes/{}/{seq:020}.json.gz", state.device_id);
            // A single GET provides both the body and the Last-Modified-derived
            // put_time; a separate stat HEAD per batch would double the request bill.
            let (bytes, put_time) = download_object(config, secret, counters, &batch_key).await?;
            let batch: CloudBatch = ungzip_json(&bytes)?;
            if batch.protocol_version != PROTOCOL_VERSION || batch.device_id != state.device_id || batch.batch_seq != seq {
                return Err(format!("Invalid cloud batch {batch_key}"));
            }
            let mut connection = crate::db::open_library_db(app)?;
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
        let connection = crate::db::open_library_db(app)?;
        connection
            .execute(
                "INSERT INTO sync_device_heads(target,device_id,etag,latest_batch_seq) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(target,device_id) DO UPDATE SET etag=excluded.etag,latest_batch_seq=excluded.latest_batch_seq",
                params![target, state.device_id, object.etag, state.latest_batch_seq as i64],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(applied)
}

#[tauri::command]
pub async fn qiniu_sync_config<R: Runtime>(app: AppHandle<R>) -> Result<Option<QiniuSyncConfig>, String> {
    let connection = crate::db::open_library_db(&app)?;
    crate::db::get_meta_value(&connection, CONFIG_META_KEY)
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
        return Err("Access Key, Secret Key, Bucket, and S3 endpoint are required.".to_string());
    }
    let config = QiniuSyncConfig {
        access_key: request.access_key.trim().to_string(),
        bucket: request.bucket.trim().to_string(),
        region: request.region.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
        private_domain: request.private_domain.trim().to_string(),
        prefix: PREFIX.to_string(),
        configured: true,
    };
    // Fail fast on an unusable endpoint/region before persisting anything.
    resolve_target(&config)?;
    keyring_entry(request.access_key.trim())?
        .set_password(&request.secret_key)
        .map_err(|error| format!("Failed to store Qiniu Secret Key in the system keychain: {error}"))?;
    let mut connection = crate::db::open_library_db(&app)?;
    let target = format!("{}:{}", config.access_key, config.bucket);
    if crate::db::get_meta_value(&connection, SEEDED_TARGET_META_KEY).as_deref() != Some(&target) {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        let max_seq: i64 = transaction
            .query_row("SELECT COALESCE(MAX(local_seq),0) FROM entities", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        transaction.execute("UPDATE entities SET local_seq=?1", [max_seq + 1]).map_err(|e| e.to_string())?;
        crate::db::set_meta_value(&transaction, SEEDED_TARGET_META_KEY, &target)?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    crate::db::set_meta_value(&connection, CONFIG_META_KEY, &serde_json::to_string(&config).unwrap())?;
    Ok(config)
}

#[tauri::command]
pub async fn qiniu_test_sync_connection<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let config = load_config(&app)
        .map_err(|error| format!("Qiniu connection test failed while reading the saved configuration: {error}"))?;
    let secret = load_secret(&config)
        .map_err(|error| format!("Qiniu connection test failed while reading the Secret Key from Keychain: {error}"))?;
    let counters = NetworkCounters::default();
    let key = format!("{PREFIX}/connection-test-{}.json", uuid::Uuid::new_v4());
    upload_bytes(&config, &secret, &counters, &key, br#"{"ok":true}"#)
        .await
        .map_err(|error| format!("Qiniu connection test failed during test-object upload: {error}"))?;
    stat_object(&config, &secret, &counters, &key)
        .await
        .map_err(|error| format!("Qiniu connection test uploaded the object, but Stat failed: {error}"))?;
    // Round-trip a download too, so a signing/endpoint/region mismatch that only
    // affects reads is caught here rather than during a real sync.
    download_bytes(&config, &secret, &counters, &key)
        .await
        .map_err(|error| format!("Qiniu connection test: upload succeeded but downloading through the S3 endpoint ({}) failed: {error}", config.private_domain))?;
    delete_object(&config, &secret, &counters, &key)
        .await
        .map_err(|error| format!("Qiniu connection test uploaded and verified the object, but cleanup deletion failed: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn qiniu_disconnect_sync<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let connection = crate::db::open_library_db(&app)?;
    if let Some(raw) = crate::db::get_meta_value(&connection, CONFIG_META_KEY) {
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
) -> Result<BlobUploadResult, String> {
    let counters = NetworkCounters::default();
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
        return Ok(BlobUploadResult {
            uploaded: false,
            stats: counters.snapshot(),
            error: Some(BlobUploadIssue {
                kind: BlobUploadIssueKind::File,
                message: "Local file SHA-256 does not match its FileAsset metadata.".to_string(),
            }),
        });
    }
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let key = format!("{PREFIX}/blobs/sha256/{expected}");
    let uploaded = match stat_object_if_exists(&config, &secret, &counters, &key).await {
        Ok(Some(_)) => false,
        Ok(None) => match upload_bytes(&config, &secret, &counters, &key, &bytes).await {
            Ok(_) => true,
            Err(error) => {
                return Ok(BlobUploadResult {
                    uploaded: false,
                    stats: counters.snapshot(),
                    error: Some(BlobUploadIssue { kind: error.kind, message: error.message }),
                });
            }
        },
        Err(error) => {
            return Ok(BlobUploadResult {
                uploaded: false,
                stats: counters.snapshot(),
                error: Some(BlobUploadIssue { kind: BlobUploadIssueKind::Fatal, message: error }),
            });
        }
    };
    Ok(BlobUploadResult { uploaded, stats: counters.snapshot(), error: None })
}

/// Checks a content-addressed blob without transferring any file bytes.
/// A missing object is a normal result; authentication, timeout, region and
/// other service failures remain errors so callers never mistake an outage for
/// a reason to read and re-upload the whole local library.
#[tauri::command]
pub async fn qiniu_object_exists<R: Runtime>(
    app: AppHandle<R>,
    sha256: String,
) -> Result<QiniuObjectStat, String> {
    let expected = sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Expected a 64-character SHA-256 value.".to_string());
    }
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let counters = NetworkCounters::default();
    let key = format!("{PREFIX}/blobs/sha256/{expected}");
    match stat_object_if_exists(&config, &secret, &counters, &key).await? {
        Some((_, size)) => Ok(QiniuObjectStat { exists: true, size: Some(size), stats: counters.snapshot() }),
        None => Ok(QiniuObjectStat { exists: false, size: None, stats: counters.snapshot() }),
    }
}

#[tauri::command]
pub async fn qiniu_download_blob<R: Runtime>(
    app: AppHandle<R>,
    sha256: String,
) -> Result<tauri::ipc::Response, String> {
    let expected = sha256.trim().to_ascii_lowercase();
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let counters = NetworkCounters::default();
    let key = format!("{PREFIX}/blobs/sha256/{expected}");
    let bytes = download_bytes(&config, &secret, &counters, &key).await?;
    if hex::encode(Sha256::digest(&bytes)) != expected {
        return Err("Downloaded Qiniu object failed SHA-256 verification.".to_string());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn qiniu_delete_blob<R: Runtime>(app: AppHandle<R>, sha256: String) -> Result<NetworkStats, String> {
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let counters = NetworkCounters::default();
    let key = format!("{PREFIX}/blobs/sha256/{}", sha256.trim().to_ascii_lowercase());
    // DELETE is idempotent (404 counts as success), so no existence HEAD first.
    delete_object(&config, &secret, &counters, &key).await?;
    Ok(counters.snapshot())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QiniuBlobList {
    /// sha256 (lowercase hex) → object size in bytes.
    pub sizes: HashMap<String, u64>,
    pub stats: NetworkStats,
}

/// Lists every content-addressed blob in one paginated ListObjectsV2 sweep
/// (up to 1000 keys per request), so the pre-sync existence check costs one GET
/// instead of one HEAD per file. With a `run_id`, the listing also seeds the
/// run's known-hash cache so later native uploads skip their existence HEADs.
#[tauri::command]
pub async fn qiniu_list_blobs<R: Runtime>(app: AppHandle<R>, run_id: Option<String>) -> Result<QiniuBlobList, String> {
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let counters = NetworkCounters::default();
    let prefix = format!("{PREFIX}/blobs/sha256/");
    let mut sizes = HashMap::new();
    for xml in list_object_pages(&config, &secret, &counters, &prefix).await? {
        sizes.extend(extract_listed_blob_sizes(&xml, &prefix));
    }
    if let Some(run_id) = run_id.as_deref() {
        known_cloud_run_apply(run_id, |run| {
            run.seeded = true;
            run.hashes.extend(sizes.keys().cloned());
        });
    }
    Ok(QiniuBlobList { sizes, stats: counters.snapshot() })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBlobUploadOutcome {
    /// Hash of the bytes actually read from disk; `None` when the local file
    /// could not be read — callers mirror the legacy IndexedDB fallback then.
    pub sha256: Option<String>,
    pub size: u64,
    pub modified_ms: u64,
    /// File metadata was identical before and after the read; only then may
    /// the caller cache the hash against this size/mtime pair.
    pub stable: bool,
    pub uploaded: bool,
    pub stats: NetworkStats,
    pub error: Option<BlobUploadIssue>,
}

fn stored_blob_outcome(
    sha256: Option<String>,
    size: u64,
    modified_ms: u64,
    stable: bool,
    uploaded: bool,
    counters: &NetworkCounters,
    error: Option<BlobUploadIssue>,
) -> StoredBlobUploadOutcome {
    StoredBlobUploadOutcome { sha256, size, modified_ms, stable, uploaded, stats: counters.snapshot(), error }
}

/// Native upload of a disk-stored PDF: reads, hashes and uploads entirely in
/// Rust, so the file bytes never cross the IPC boundary and are hashed once.
/// Existence checks consult the run's known-hash cache first; after a seeding
/// LIST, absence from the cache is proof enough to skip the HEAD as well.
#[tauri::command]
pub async fn qiniu_upload_stored_blob<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    dir: String,
    file_name: String,
) -> Result<StoredBlobUploadOutcome, String> {
    crate::file_storage::validate_stored_file_name(&file_name)?;
    let counters = NetworkCounters::default();

    let read = tauri::async_runtime::spawn_blocking(move || -> Option<(Vec<u8>, String, u64, bool)> {
        let path = std::path::Path::new(&dir).join(&file_name);
        let before = std::fs::metadata(&path).ok().filter(|metadata| metadata.is_file())?;
        let bytes = std::fs::read(&path).ok()?;
        if bytes.is_empty() {
            return None;
        }
        let after = std::fs::metadata(&path).ok()?;
        let stable = before.len() == after.len()
            && crate::file_storage::file_modified_ms(&before) == crate::file_storage::file_modified_ms(&after);
        let sha256 = sha256_hex(&bytes);
        let modified_ms = crate::file_storage::file_modified_ms(&after);
        Some((bytes, sha256, modified_ms, stable))
    })
    .await
    .map_err(|error| format!("Blob read task failed: {error}"))?;

    let Some((bytes, sha256, modified_ms, stable)) = read else {
        return Ok(stored_blob_outcome(None, 0, 0, false, false, &counters, None));
    };
    let size = bytes.len() as u64;

    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let (known, seeded) = known_cloud_run_apply(&run_id, |run| (run.hashes.contains(&sha256), run.seeded))
        .unwrap_or((false, false));
    if known {
        return Ok(stored_blob_outcome(Some(sha256), size, modified_ms, stable, false, &counters, None));
    }

    let key = format!("{PREFIX}/blobs/sha256/{sha256}");
    if !seeded {
        match stat_object_if_exists(&config, &secret, &counters, &key).await {
            Ok(Some(_)) => {
                known_cloud_run_apply(&run_id, |run| run.hashes.insert(sha256.clone()));
                return Ok(stored_blob_outcome(Some(sha256), size, modified_ms, stable, false, &counters, None));
            }
            Ok(None) => {}
            Err(error) => {
                return Ok(stored_blob_outcome(
                    Some(sha256),
                    size,
                    modified_ms,
                    stable,
                    false,
                    &counters,
                    Some(BlobUploadIssue { kind: BlobUploadIssueKind::Fatal, message: error }),
                ));
            }
        }
    }

    match upload_bytes(&config, &secret, &counters, &key, &bytes).await {
        Ok(_) => {
            known_cloud_run_apply(&run_id, |run| run.hashes.insert(sha256.clone()));
            Ok(stored_blob_outcome(Some(sha256), size, modified_ms, stable, true, &counters, None))
        }
        Err(error) => Ok(stored_blob_outcome(
            Some(sha256),
            size,
            modified_ms,
            stable,
            false,
            &counters,
            Some(BlobUploadIssue { kind: error.kind, message: error.message }),
        )),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobDownloadToFilesResult {
    pub files: Vec<crate::file_storage::StoredCopy>,
    pub size: u64,
    pub stats: NetworkStats,
}

/// Native download of a content-addressed blob straight to the storage folder:
/// one GET materializes every requested copy, the hash is verified in Rust and
/// the bytes never enter the webview.
#[tauri::command]
pub async fn qiniu_download_blob_to_files<R: Runtime>(
    app: AppHandle<R>,
    sha256: String,
    dir: String,
    file_names: Vec<String>,
) -> Result<BlobDownloadToFilesResult, String> {
    let expected = sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Expected a 64-character SHA-256 value.".to_string());
    }
    if file_names.is_empty() {
        return Err("No target file names given.".to_string());
    }
    for name in &file_names {
        crate::file_storage::validate_stored_file_name(name)?;
    }

    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let counters = NetworkCounters::default();
    let key = format!("{PREFIX}/blobs/sha256/{expected}");
    let bytes = download_bytes(&config, &secret, &counters, &key).await?;
    let stats = counters.snapshot();

    let (files, size) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        if sha256_hex(&bytes) != expected {
            return Err("Downloaded Qiniu object failed SHA-256 verification.".to_string());
        }
        let size = bytes.len() as u64;
        let files = crate::file_storage::write_blob_copies(std::path::Path::new(&dir), &file_names, &bytes)?;
        Ok((files, size))
    })
    .await
    .map_err(|error| format!("Blob materialize task failed: {error}"))??;

    Ok(BlobDownloadToFilesResult { files, size, stats })
}

#[tauri::command]
pub async fn qiniu_sync_library<R: Runtime>(app: AppHandle<R>) -> Result<SyncSummary, String> {
    let config = load_config(&app)?;
    let secret = load_secret(&config)?;
    let counters = NetworkCounters::default();
    let device = {
        let connection = crate::db::open_library_db(&app)?;
        device_id(&connection)?
    };
    // The protocol marker is immutable. Verify it once per configured target,
    // then avoid a redundant HEAD during every hourly steady-state sync.
    let target = sync_target_id(&config);
    let protocol_verified = {
        let connection = crate::db::open_library_db(&app)?;
        crate::db::get_meta_value(&connection, PROTOCOL_VERIFIED_TARGET_META_KEY).as_deref() == Some(&target)
    };
    if !protocol_verified {
        let protocol_key = format!("{PREFIX}/protocol.json");
        if stat_object_if_exists(&config, &secret, &counters, &protocol_key).await?.is_none() {
            upload_bytes(&config, &secret, &counters, &protocol_key, br#"{"protocolVersion":1}"#)
                .await
                .map_err(|error| error.to_string())?;
        }
        let connection = crate::db::open_library_db(&app)?;
        crate::db::set_meta_value(&connection, PROTOCOL_VERIFIED_TARGET_META_KEY, &target)?;
    }
    let mut summary = SyncSummary::default();
    let _ = app.emit("qiniu-sync-stage", "Uploading local changes to Qiniu…");
    while let Some((seq, body, rows)) = seal_batch(&app, &device)? {
        let key = format!("{PREFIX}/changes/{device}/{seq:020}.json.gz");
        let put_time = match stat_object_if_exists(&config, &secret, &counters, &key).await? {
            Some((put_time, _)) => put_time,
            None => upload_bytes(&config, &secret, &counters, &key, &body)
                .await
                .map_err(|error| error.to_string())?,
        };
        // The device state is published once after the whole sync (below); the
        // needs-publish check sees the advanced batch_seq and always fires then.
        // Publishing per batch here would cost an extra PUT per iteration.
        confirm_local_batch(&app, &device, seq, put_time, &rows)?;
        summary.uploaded_changes += rows.len();
    }
    summary.downloaded_changes += apply_deferred_inbox(&app)?;
    let _ = app.emit("qiniu-sync-stage", "Fetching changes from other devices…");
    summary.downloaded_changes += pull_remote(&app, &config, &secret, &counters, &device, &target).await?;
    summary.downloaded_changes += apply_deferred_inbox(&app)?;
    // Publish an empty/new device once, refresh when its semantic state changes,
    // and periodically republish so an externally deleted head self-heals.
    let latest = {
        let connection = crate::db::open_library_db(&app)?;
        next_batch_seq(&connection).saturating_sub(1)
    };
    let state = current_device_state(&app, &device, latest)?;
    if device_state_needs_publish(&app, &target, &state)? {
        upload_device_state(&app, &config, &secret, &counters, &target, &state).await?;
    }
    let last_synced_at = now_iso();
    let connection = crate::db::open_library_db(&app)?;
    crate::db::set_meta_value(&connection, LAST_SYNC_META_KEY, &last_synced_at)?;
    summary.pending_changes = connection
        .query_row("SELECT COUNT(*) FROM entities WHERE local_seq>0", [], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())? as usize;
    summary.last_synced_at = last_synced_at;
    summary.set_network_stats(counters.snapshot());
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
    fn amz_timestamps_break_down_utc_correctly() {
        assert_eq!(amz_timestamps(0), ("19700101T000000Z".into(), "19700101".into()));
        assert_eq!(amz_timestamps(1_000_000_000), ("20010909T014640Z".into(), "20010909".into()));
        assert_eq!(amz_timestamps(1_700_000_000), ("20231114T221320Z".into(), "20231114".into()));
    }

    #[test]
    fn uri_encode_matches_sigv4_rules() {
        // Unreserved characters pass through; '/' is kept only when encode_slash is false.
        assert_eq!(uri_encode("lumora/v1/a-b_c.json", false), "lumora/v1/a-b_c.json");
        assert_eq!(uri_encode("lumora/v1", true), "lumora%2Fv1");
        assert_eq!(uri_encode("a b+c", true), "a%20b%2Bc");
    }

    #[test]
    fn network_counters_track_requests_and_payload_bytes() {
        let counters = NetworkCounters::default();
        counters.record_request(&reqwest::Method::PUT, 128);
        counters.record_request(&reqwest::Method::HEAD, 0);
        counters.record_request(&reqwest::Method::GET, 0);
        counters.record_download(64);
        let stats = counters.snapshot();
        assert_eq!(stats.request_count, 3);
        assert_eq!(stats.put_requests, 1);
        assert_eq!(stats.get_requests, 1);
        assert_eq!(stats.head_requests, 1);
        assert_eq!(stats.uploaded_bytes, 128);
        assert_eq!(stats.downloaded_bytes, 64);
    }

    #[test]
    fn only_not_found_is_classified_as_a_missing_object() {
        assert_eq!(classify_stat_status(reqwest::StatusCode::NOT_FOUND), Ok(true));
        assert_eq!(classify_stat_status(reqwest::StatusCode::OK), Ok(false));
        assert_eq!(
            classify_stat_status(reqwest::StatusCode::FORBIDDEN),
            Err(reqwest::StatusCode::FORBIDDEN)
        );
        assert_eq!(
            classify_stat_status(reqwest::StatusCode::REQUEST_TIMEOUT),
            Err(reqwest::StatusCode::REQUEST_TIMEOUT)
        );
    }

    #[test]
    fn upload_failures_distinguish_file_limits_from_global_errors() {
        assert_eq!(
            upload_issue_kind(reqwest::StatusCode::PAYLOAD_TOO_LARGE, ""),
            BlobUploadIssueKind::File
        );
        assert_eq!(
            upload_issue_kind(reqwest::StatusCode::BAD_REQUEST, "<Code>EntityTooLarge</Code>"),
            BlobUploadIssueKind::File
        );
        assert_eq!(
            upload_issue_kind(reqwest::StatusCode::FORBIDDEN, "signature mismatch"),
            BlobUploadIssueKind::Fatal
        );
    }

    #[test]
    fn unchanged_device_state_is_cached_until_periodic_republish() {
        let seen = HashMap::from([("remote-a".to_string(), 3)]);
        let state = DeviceState {
            protocol_version: PROTOCOL_VERSION,
            device_id: "local".into(),
            latest_batch_seq: 7,
            updated_at: "new".into(),
            seen: seen.clone(),
        };
        let published = PublishedDeviceState {
            target: "target-a".into(),
            device_id: "local".into(),
            latest_batch_seq: 7,
            seen,
            published_at_ms: 1_000,
        };
        assert!(published_device_state_is_current(
            &published,
            "target-a",
            &state,
            1_000 + DEVICE_STATE_REPUBLISH_INTERVAL_MS - 1
        ));
        assert!(!published_device_state_is_current(
            &published,
            "target-a",
            &state,
            1_000 + DEVICE_STATE_REPUBLISH_INTERVAL_MS
        ));
        assert!(!published_device_state_is_current(&published, "target-b", &state, 1_001));
    }

    #[test]
    fn host_is_parsed_for_both_addressing_styles() {
        assert_eq!(parse_host("s3.cn-east-1.qiniucs.com"), Some(("cn-east-1".into(), AddressingStyle::Path)));
        assert_eq!(parse_host("s3-cn-north-1.qiniucs.com"), Some(("cn-north-1".into(), AddressingStyle::Path)));
        assert_eq!(
            parse_host("lumora-luolei.s3.cn-east-1.qiniucs.com"),
            Some(("cn-east-1".into(), AddressingStyle::VirtualHosted))
        );
        assert_eq!(parse_host("cdn.example.com"), None);
    }

    fn target_for(domain: &str) -> S3Target {
        resolve_target(&QiniuSyncConfig {
            access_key: "ak".into(),
            bucket: "my-bucket".into(),
            region: None,
            private_domain: domain.into(),
            prefix: PREFIX.into(),
            configured: true,
        })
        .unwrap()
    }

    #[test]
    fn object_uri_places_bucket_by_addressing_style() {
        let cfg = QiniuSyncConfig {
            access_key: "ak".into(),
            bucket: "my-bucket".into(),
            region: None,
            private_domain: String::new(),
            prefix: PREFIX.into(),
            configured: true,
        };
        // Path-style prepends the bucket; virtual-hosted keys off the root.
        let path = target_for("s3.cn-east-1.qiniucs.com");
        assert_eq!(object_uri(&path, &cfg, "lumora/v1/x.json"), "/my-bucket/lumora/v1/x.json");
        assert_eq!(bucket_uri(&path, &cfg), "/my-bucket");
        let virt = target_for("my-bucket.s3.cn-east-1.qiniucs.com");
        assert_eq!(object_uri(&virt, &cfg, "lumora/v1/x.json"), "/lumora/v1/x.json");
        assert_eq!(bucket_uri(&virt, &cfg), "/");
    }

    #[test]
    fn sigv4_matches_aws_published_test_vector() {
        // AWS "get-vanilla" case from the official Signature Version 4 test suite.
        // Validates the HMAC signing-key chain, sha256_hex, and the exact
        // string-to-sign layout that s3_send relies on.
        let secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
        let empty_hash = sha256_hex(&[]);
        let canonical_request = format!(
            "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n{empty_hash}"
        );
        let scope = "20150830/us-east-1/service/aws4_request";
        let string_to_sign =
            format!("AWS4-HMAC-SHA256\n20150830T123600Z\n{scope}\n{}", sha256_hex(canonical_request.as_bytes()));
        let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), b"20150830");
        let k_region = hmac_sha256(&k_date, b"us-east-1");
        let k_service = hmac_sha256(&k_region, b"service");
        let k_signing = hmac_sha256(&k_service, b"aws4_request");
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));
        assert_eq!(signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    }

    #[test]
    fn xml_values_are_extracted() {
        let xml = "<A><Key>k1</Key></A><A><Key>k2</Key></A><NextContinuationToken>tok</NextContinuationToken>";
        assert_eq!(extract_xml_values(xml, "Key"), vec!["k1".to_string(), "k2".to_string()]);
        assert_eq!(extract_xml_values(xml, "NextContinuationToken"), vec!["tok".to_string()]);
        assert!(extract_xml_values(xml, "Missing").is_empty());
    }

    #[test]
    fn device_list_extracts_etags_and_device_ids() {
        let xml = "<ListBucketResult>\
          <Contents><Key>lumora/v1/devices/local.json</Key><ETag>\"etag-local\"</ETag><Size>10</Size></Contents>\
          <Contents><Key>lumora/v1/devices/remote.json</Key><ETag>\"etag-remote\"</ETag><Size>11</Size></Contents>\
          <Contents><Key>lumora/v1/blobs/sha256/x</Key><ETag>\"blob\"</ETag></Contents>\
        </ListBucketResult>";
        let objects = extract_listed_device_objects(xml, "lumora/v1/devices/");
        assert_eq!(
            objects,
            vec![
                ListedDeviceObject { key: "lumora/v1/devices/local.json".into(), etag: "etag-local".into() },
                ListedDeviceObject { key: "lumora/v1/devices/remote.json".into(), etag: "etag-remote".into() },
            ]
        );
        assert_eq!(device_id_from_head_key(&objects[0].key, "lumora/v1/devices/"), Some("local"));
        let cached = ("etag-remote".to_string(), 4);
        assert!(!device_head_needs_fetch("etag-remote", Some(&cached), 4));
        assert!(device_head_needs_fetch("etag-new", Some(&cached), 4));
        assert!(device_head_needs_fetch("etag-remote", Some(&cached), 3));
        assert!(device_head_needs_fetch("", Some(&cached), 4));
    }

    #[test]
    fn blob_list_extracts_hashes_and_sizes() {
        let sha_a = "a".repeat(64);
        let sha_b = "B".repeat(64);
        let xml = format!(
            "<ListBucketResult>\
              <Contents><Key>lumora/v1/blobs/sha256/{sha_a}</Key><Size>42</Size></Contents>\
              <Contents><Key>lumora/v1/blobs/sha256/{sha_b}</Key><Size>7</Size></Contents>\
              <Contents><Key>lumora/v1/blobs/sha256/not-a-hash</Key><Size>1</Size></Contents>\
              <Contents><Key>lumora/v1/devices/d.json</Key><Size>2</Size></Contents>\
            </ListBucketResult>"
        );
        let blobs = extract_listed_blob_sizes(&xml, "lumora/v1/blobs/sha256/");
        assert_eq!(blobs, vec![(sha_a, 42), (sha_b.to_ascii_lowercase(), 7)]);
    }

    #[test]
    fn known_cloud_run_resets_on_a_new_run_id() {
        let run_a = format!("run-a-{}", uuid::Uuid::new_v4());
        let run_b = format!("run-b-{}", uuid::Uuid::new_v4());

        known_cloud_run_apply(&run_a, |run| {
            run.seeded = true;
            run.hashes.insert("hash-1".to_string());
        });
        assert_eq!(
            known_cloud_run_apply(&run_a, |run| (run.seeded, run.hashes.contains("hash-1"))),
            Some((true, true))
        );

        // A different run id must start with no knowledge at all.
        assert_eq!(
            known_cloud_run_apply(&run_b, |run| (run.seeded, run.hashes.contains("hash-1"))),
            Some((false, false))
        );
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
