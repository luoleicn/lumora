import { useEffect } from "react";
import { ExternalLink, Link2, Link2Off, RefreshCw, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  mendeleyRedirectUri,
  type MendeleyConnection,
  type MendeleySettings
} from "../lib/mendeleyClient";

type MendeleySyncModalProps = {
  open: boolean;
  settings: MendeleySettings;
  connection?: MendeleyConnection;
  busy: boolean;
  syncing?: boolean;
  status?: string;
  onSettingsChange: (settings: MendeleySettings) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onSync: () => void;
  onClose: () => void;
};

export function MendeleySyncModal({
  open,
  settings,
  connection,
  busy,
  syncing = false,
  status,
  onSettingsChange,
  onConnect,
  onDisconnect,
  onSync,
  onClose
}: MendeleySyncModalProps) {
  const controlsBusy = busy || syncing;
  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, busy, onClose]);

  if (!open) {
    return null;
  }

  const connected = Boolean(connection?.connected);
  const hasCredentials = Boolean(settings.clientId.trim());

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !busy) {
        onClose();
      }
    }}>
      <div className="manual-modal file-storage-modal" role="dialog" aria-modal="true" aria-label="Mendeley sync">
        <header>
          <div>
            <h2>Mendeley Sync</h2>
            <p>Connects this app directly to your Mendeley account.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="file-storage-modal-body">
          {!connected && (
            <>
              <h3 className="mendeley-step-heading">1. Create an API key (one-time)</h3>
              <p className="file-storage-hint">
                Sign in with your normal Mendeley email and password, register an app with any name and this
                redirect URL: <code>{mendeleyRedirectUri}</code> — then paste the generated ID and secret below.
                You will never need this page again.
              </p>
              <div className="sync-actions">
                <button
                  type="button"
                  onClick={() => void invoke("open_external_url", { url: "https://dev.mendeley.com/myapps.html" })}
                  disabled={controlsBusy}
                >
                  <ExternalLink size={15} />
                  Open registration page
                </button>
              </div>
              <label>
                Client ID
                <input
                  value={settings.clientId}
                  onChange={(event) => onSettingsChange({ ...settings, clientId: event.target.value })}
                  disabled={controlsBusy}
                />
              </label>
              <label>
                Client secret
                <input
                  type="password"
                  value={settings.clientSecret}
                  onChange={(event) => onSettingsChange({ ...settings, clientSecret: event.target.value })}
                  disabled={controlsBusy}
                />
              </label>
            </>
          )}

          <h3 className="mendeley-step-heading">
            {connected ? "Account" : "2. Authorize"}
            {connected && <span className="mendeley-step-done">Connected{connection?.displayName ? ` — ${connection.displayName}` : ""}</span>}
          </h3>
          {!connected && (
            <p className="file-storage-hint">
              Opens Mendeley in your browser — sign in with your Mendeley email and password and approve access;
              the app captures the approval automatically.
            </p>
          )}
          <div className="sync-actions">
            {connected ? (
              <button type="button" onClick={onDisconnect} disabled={controlsBusy}>
                <Link2Off size={16} />
                Disconnect
              </button>
            ) : (
              <button type="button" onClick={onConnect} disabled={controlsBusy || !hasCredentials}>
                <Link2 size={16} />
                Connect Mendeley
              </button>
            )}
          </div>

          <h3 className="mendeley-step-heading">{connected ? "Sync" : "3. Sync"}</h3>
          <p className="file-storage-hint">
            Two-way sync for complete document metadata, nested folders and membership, attachment metadata,
            highlights, document notes, and sticky notes. Local document, folder, membership, and annotation
            changes are sent back to Mendeley.
          </p>
          <div className="sync-actions">
            <button type="button" onClick={onSync} disabled={controlsBusy || !connected}>
              <RefreshCw className={syncing ? "spinning" : undefined} size={16} />
              {syncing ? "Syncing in background…" : "Sync with Mendeley"}
            </button>
          </div>

          {status && <p className="file-storage-preview">{status}</p>}
        </div>
      </div>
    </div>
  );
}
