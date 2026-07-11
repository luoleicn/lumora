import { useEffect, useState, type FormEvent } from "react";
import { Network, Save, X } from "lucide-react";
import { defaultProxySettings, type ProxySettings } from "../lib/proxySettings";

type ProxySettingsModalProps = {
  open: boolean;
  settings: ProxySettings;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSave: (settings: ProxySettings) => void;
};

export function ProxySettingsModal({ open, settings, busy, error, onClose, onSave }: ProxySettingsModalProps) {
  const [draft, setDraft] = useState<ProxySettings>(defaultProxySettings);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

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
    onSave({ ...draft, url: draft.url.trim(), username: draft.username.trim() });
  }

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <form className="manual-modal file-storage-modal" onSubmit={handleSubmit} role="dialog" aria-modal="true" aria-label="Proxy settings">
        <header>
          <div>
            <h2>Proxy</h2>
            <p>Configure the network route used by research services.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="file-storage-modal-body">
          <div className="proxy-scope-notice">
            <Network size={18} />
            <p>This proxy is used for Mendeley sync and all arXiv requests, including metadata search and PDF downloads.</p>
          </div>
          <label className="proxy-enabled-row">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              disabled={busy}
            />
            Enable proxy
          </label>
          <label>
            Proxy URL
            <input
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              placeholder="socks5h://127.0.0.1:1080"
              disabled={busy || !draft.enabled}
              required={draft.enabled}
            />
          </label>
          <p className="file-storage-hint">Supported protocols: HTTP, HTTPS, SOCKS5 and SOCKS5H.</p>
          <label>
            Username (optional)
            <input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} disabled={busy || !draft.enabled} />
          </label>
          <label>
            Password (optional)
            <input type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} disabled={busy || !draft.enabled} />
          </label>
          {error && <p className="sync-status">{error}</p>}
          <div className="sync-actions">
            <button type="submit" disabled={busy || (draft.enabled && !draft.url.trim())}>
              <Save size={15} />
              {busy ? "Saving…" : "Save Proxy"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
