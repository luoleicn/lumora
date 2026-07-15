import { useEffect, type ReactNode } from "react";
import { Download, RefreshCw, RotateCw, X } from "lucide-react";
import type { AppUpdateState } from "../lib/appUpdater";
import { formatFileSize } from "../lib/arxivFiles";

type UpdateModalProps = {
  state: AppUpdateState;
  onClose: () => void;
  onInstall: () => void;
  onRetry: () => void;
  onRestart: () => void;
};

export function UpdateModal({ state, onClose, onInstall, onRetry, onRestart }: UpdateModalProps) {
  const busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";

  useEffect(() => {
    if (!state.visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, state.visible]);

  if (!state.visible) return null;

  const progress = state.totalBytes
    ? Math.min(100, (state.downloadedBytes / state.totalBytes) * 100)
    : undefined;

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div className="manual-modal update-modal" role="dialog" aria-modal="true" aria-label="Software update">
        <header>
          <div>
            <h2>Software Update</h2>
            <p>{subtitle(state)}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="update-modal-body">
          {state.phase === "checking" && <UpdateActivity icon={<RefreshCw size={22} />} copy="Checking GitHub Releases…" spinning />}
          {state.phase === "upToDate" && <p className="modal-copy">You are using the latest version of lumora.</p>}
          {state.phase === "available" && (
            <>
              <div className="update-version-row">
                <span>Installed</span><strong>{state.currentVersion}</strong>
                <span>Available</span><strong>{state.version}</strong>
              </div>
              {state.notes
                ? <pre className="update-release-notes">{state.notes}</pre>
                : <p className="modal-copy">A new version of lumora is available.</p>}
            </>
          )}
          {(state.phase === "downloading" || state.phase === "installing") && (
            <>
              <UpdateActivity
                icon={<Download size={22} />}
                copy={state.phase === "installing" ? "Installing the verified update…" : "Downloading and verifying the update…"}
                spinning={state.phase === "installing"}
              />
              {state.phase === "downloading" && (
                <div className="update-progress">
                  <div className={progress === undefined ? "indeterminate" : "determinate"}>
                    <span style={progress === undefined ? undefined : { width: `${progress}%` }} />
                  </div>
                  <small>
                    {formatFileSize(state.downloadedBytes)}
                    {state.totalBytes ? ` / ${formatFileSize(state.totalBytes)}` : ""}
                  </small>
                </div>
              )}
            </>
          )}
          {state.phase === "readyToRestart" && (
            <UpdateActivity icon={<RotateCw size={22} />} copy="The update is installed. Restart lumora to use the new version." />
          )}
          {state.phase === "error" && <p className="sync-status">Update failed: {state.error}</p>}
        </div>

        {!busy && (
          <footer>
            {state.phase === "available" && (
              <>
                <button type="button" onClick={onClose}>Later</button>
                <button type="button" className="primary" onClick={onInstall}>Download and Install</button>
              </>
            )}
            {(state.phase === "upToDate" || state.phase === "error") && (
              <>
                {state.phase === "error" && <button type="button" onClick={onRetry}>Retry</button>}
                <button type="button" className="primary" onClick={onClose}>OK</button>
              </>
            )}
            {state.phase === "readyToRestart" && (
              <>
                <button type="button" onClick={onClose}>Later</button>
                <button type="button" className="primary" onClick={onRestart}>Restart Now</button>
              </>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

function UpdateActivity({ icon, copy, spinning = false }: { icon: ReactNode; copy: string; spinning?: boolean }) {
  return (
    <div className={`update-activity${spinning ? " spinning" : ""}`}>
      {icon}
      <p>{copy}</p>
    </div>
  );
}

function subtitle(state: AppUpdateState): string {
  if (state.version) return `lumora ${state.version}`;
  if (state.phase === "upToDate") return "lumora is up to date";
  if (state.phase === "error") return "Unable to complete the update";
  return "Keep lumora up to date";
}
