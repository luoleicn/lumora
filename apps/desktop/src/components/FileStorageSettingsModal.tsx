import { useEffect, useState, type FormEvent } from "react";
import { FolderOpen, Save, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Paper } from "@lumora/shared";
import { buildPdfFileName, defaultNameTemplate, type FileStorageSettings } from "../lib/fileStorage";

type FileStorageSettingsModalProps = {
  open: boolean;
  settings: FileStorageSettings;
  previewPaper?: Paper;
  busy: boolean;
  onClose: () => void;
  onSave: (settings: FileStorageSettings) => void;
};

export function FileStorageSettingsModal({
  open: isOpen,
  settings,
  previewPaper,
  busy,
  onClose,
  onSave
}: FileStorageSettingsModalProps) {
  const [directory, setDirectory] = useState<string>();
  const [nameTemplate, setNameTemplate] = useState(defaultNameTemplate);

  useEffect(() => {
    if (isOpen) {
      setDirectory(settings.directory);
      setNameTemplate(settings.nameTemplate);
    }
  }, [isOpen, settings]);

  useEffect(() => {
    if (!isOpen) {
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
  }, [isOpen, busy, onClose]);

  if (!isOpen) {
    return null;
  }

  const previewName = previewPaper
    ? buildPdfFileName(previewPaper, nameTemplate.trim() || defaultNameTemplate)
    : undefined;

  async function handleChooseDirectory() {
    const selected = await open({ directory: true, multiple: false, defaultPath: directory });
    if (typeof selected === "string") {
      setDirectory(selected);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }

    onSave({
      directory,
      nameTemplate: nameTemplate.trim() || defaultNameTemplate
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !busy) {
        onClose();
      }
    }}>
      <form
        className="manual-modal file-storage-modal"
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-label="File storage settings"
      >
        <header>
          <div>
            <h2>File Storage Settings</h2>
            <p>Choose where PDF files live on disk and how they are named.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="file-storage-modal-body">
          <label>
            Storage folder
            <div className="file-storage-directory-row">
              <input value={directory ?? ""} placeholder="Not configured — PDFs stay in the app database" readOnly />
              <button type="button" onClick={() => void handleChooseDirectory()} disabled={busy}>
                <FolderOpen size={15} />
                Choose...
              </button>
            </div>
          </label>

          <label>
            File name template
            <input
              value={nameTemplate}
              onChange={(event) => setNameTemplate(event.target.value)}
              placeholder={defaultNameTemplate}
              disabled={busy}
            />
          </label>
          <p className="file-storage-hint">
            Placeholders: {"{title}"}, {"{year}"}, {"{author}"} (first author). Missing fields collapse cleanly.
          </p>

          {previewName && (
            <p className="file-storage-preview">
              Preview: <strong>{previewName}</strong>
            </p>
          )}

          {directory && (
            <p className="file-storage-hint">
              Saving moves every stored PDF into this folder with the template name. Metadata edits rename files automatically.
            </p>
          )}
        </div>

        <footer>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            <Save size={16} />
            {busy ? "Migrating..." : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}
