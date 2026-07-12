# Qiniu object-storage sync

Lumora has no application server or cloud database. Each user provides a
private Qiniu Kodo bucket, and the native Tauri process talks to that bucket
using the official Rust SDK. The Secret Key lives only in the OS keychain.

## Protocol

Cloud keys are rooted at `lumora/v1/`:

- `protocol.json` identifies protocol version 1.
- `devices/{deviceId}.json` is a per-device head and vector cursor.
- `changes/{deviceId}/{batchSeq}.json.gz` contains immutable batches of at
  most 500 full-entity operations.
- `snapshots/` is reserved for bootstrap checkpoints.
- `blobs/sha256/{sha256}` stores content-addressed, non-arXiv files.

Every install owns one random device ID and a strictly increasing batch
sequence. Change objects are immutable and retries reuse the same key. Other
devices discover device heads, then fetch only sequence numbers beyond their
SQLite vector cursor. Qiniu `putTime`, followed by device ID, batch sequence,
and operation index, is the deterministic last-write-wins version stamp.

SQLite writes and the local dirty marker are transactional. A batch is sealed
locally before upload, the cloud object is verified with Stat, and the dirty
rows are cleared only after the device head is published. A remote operation
that collides with a still-dirty local entity is retained in `sync_inbox`
instead of overwriting the edit.

The app syncs once after startup, then every hour while running. Manual sync is
always available. There is no edit-debounce sync.

## Files and arXiv

Device-local paths and availability never enter cloud batches. Ordinary files
are addressed by SHA-256 and mirrored to macOS. A paper with an arXiv ID stores
the pinned ID including `vN`; its PDF is not uploaded. Qiniu sync never contacts
arXiv: missing arXiv PDFs remain metadata-only until the user explicitly runs
the separate arXiv download action.

Annotations carry the SHA-256 of the PDF they were created against. Coordinates
are not drawn when the current file has another fingerprint, although the note
and quote remain available for recovery. When a former object-backed PDF moves
to arXiv, the old blob is deleted only if no other active FileAsset references
the same hash.

To avoid repeatedly reading the user's whole PDF library, the desktop keeps a
device-local verification fingerprint (path, size, modification time, and the
last computed SHA-256). An unchanged file is checked with a Qiniu Stat request;
its bytes are read and hashed only when the object is missing or the local
fingerprint changed. Stats are deduplicated by SHA-256 and run with bounded
concurrency. A missing-object response is distinct from authentication,
timeout, region, and other service errors, so an outage cannot trigger a full
local-library scan. Uploads still verify SHA-256 before transfer and Stat the
stored size afterwards.

## Security and operational limits

- Use a dedicated private bucket and preferably a dedicated Qiniu key. A client
  holding AK/SK has management access and there is no server-side user layer.
- Metadata is not end-to-end encrypted; the bucket owner can read notes and
  bibliographic data.
- Never configure a lifecycle deletion rule for the `lumora/` prefix.
- Never edit or overwrite change objects manually. Metadata history is retained
  in version 1; snapshots optimize bootstrap but are not authorization to erase
  the immutable log.
- Last-write-wins can lose concurrent edits to the same entity. Directory
  membership and annotations remain separate entities, reducing conflict scope.
- Losing both the local library and Qiniu credentials makes recovery impossible;
  keep normal device and credential backups.
