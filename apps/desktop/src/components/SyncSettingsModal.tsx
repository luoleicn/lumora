import { useEffect, useState, type FormEvent } from "react";
import { Cloud, KeyRound, RefreshCw, X } from "lucide-react";
import { normalizeAutoSyncInterval, type AutoSyncSettings, type SyncSettings } from "../lib/syncClient";

type SyncSettingsModalProps = {
  open: boolean;
  settings: SyncSettings;
  autoSync: AutoSyncSettings;
  busy: boolean;
  syncing: boolean;
  status?: string;
  onClose: () => void;
  onSave: (settings: SyncSettings) => void;
  onSync: () => void;
  onAutoSyncChange: (settings: AutoSyncSettings) => void;
};

export function SyncSettingsModal({
  open,
  settings,
  autoSync,
  busy,
  syncing,
  status,
  onClose,
  onSave,
  onSync,
  onAutoSyncChange
}: SyncSettingsModalProps) {
  const [draft, setDraft] = useState<SyncSettings>(settings);
  const [intervalDraft, setIntervalDraft] = useState(String(autoSync.intervalMinutes));

  useEffect(() => {
    if (open) setDraft({ ...settings, secretKey: undefined });
  }, [open, settings]);

  useEffect(() => {
    setIntervalDraft(String(autoSync.intervalMinutes));
  }, [autoSync.intervalMinutes]);

  function commitInterval(value: string) {
    const minutes = normalizeAutoSyncInterval(value);
    setIntervalDraft(String(minutes));
    if (minutes !== autoSync.intervalMinutes) onAutoSyncChange({ ...autoSync, intervalMinutes: minutes });
  }

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSave({
      ...draft,
      accessKey: draft.accessKey.trim(),
      bucket: draft.bucket.trim(),
      region: draft.region?.trim(),
      privateDomain: draft.privateDomain.trim()
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <form className="manual-modal file-storage-modal" onSubmit={handleSubmit} role="dialog" aria-modal="true" aria-label="Sync settings">
        <header>
          <div>
            <h2>Sync Settings</h2>
            <p>Connect this library directly to your private Qiniu Kodo bucket.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="file-storage-modal-body">
          <div className="proxy-scope-notice">
            <Cloud size={18} />
            <p>Metadata and non-arXiv files are stored under <code>lumora/v1/</code>. The Secret Key stays in macOS Keychain.</p>
          </div>
          <label>
            Qiniu Access Key
            <input value={draft.accessKey} onChange={(event) => setDraft({ ...draft, accessKey: event.target.value })} disabled={busy} required />
          </label>
          <label>
            Qiniu Secret Key
            <input
              type="password"
              value={draft.secretKey ?? ""}
              placeholder={settings.configured ? "Stored in macOS Keychain — enter again only to change settings" : "Required"}
              onChange={(event) => setDraft({ ...draft, secretKey: event.target.value })}
              disabled={busy}
              required={!settings.configured}
            />
          </label>
          <label>
            Bucket
            <input value={draft.bucket} onChange={(event) => setDraft({ ...draft, bucket: event.target.value })} disabled={busy} required />
          </label>
          <label>
            Region (optional)
            <input
              value={draft.region ?? ""}
              onChange={(event) => setDraft({ ...draft, region: event.target.value })}
              placeholder="Auto-detected from the endpoint, e.g. cn-east-1"
              disabled={busy}
            />
          </label>
          <label>
            S3 endpoint
            <input
              value={draft.privateDomain}
              onChange={(event) => setDraft({ ...draft, privateDomain: event.target.value })}
              placeholder="s3.cn-east-1.qiniucs.com"
              disabled={busy}
              required
            />
          </label>
          <div className="auto-sync-settings">
            <label className="auto-sync-toggle">
              <input
                type="checkbox"
                checked={autoSync.enabled}
                onChange={(event) => onAutoSyncChange({ ...autoSync, enabled: event.target.checked })}
              />
              Automatically sync in the background
            </label>
            <label className="auto-sync-interval">
              Sync every
              <input
                type="number"
                min={1}
                max={1440}
                step={1}
                value={intervalDraft}
                disabled={!autoSync.enabled}
                onChange={(event) => setIntervalDraft(event.target.value)}
                onBlur={(event) => commitInterval(event.target.value)}
              />
              minutes
            </label>
          </div>
          {status && <p className="sync-status">{status}</p>}
          <div className="sync-actions">
            <button type="submit" disabled={busy || syncing || (settings.configured && !draft.secretKey)}>
              <KeyRound size={16} />
              {busy ? "Working…" : "Save & Test"}
            </button>
            <button type="button" onClick={onSync} disabled={busy || syncing || !settings.configured}>
              <RefreshCw size={16} className={syncing ? "spinning" : undefined} />
              {syncing ? "Syncing…" : "Sync Now"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
