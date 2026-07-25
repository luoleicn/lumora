import { Hash, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { normalizeArxivId } from "../lib/arxivFiles";

type ArxivImportModalProps = {
  open: boolean;
  targetCollectionName?: string;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (arxivId: string) => void;
};

export function ArxivImportModal({ open, targetCollectionName, busy, error, onClose, onSubmit }: ArxivImportModalProps) {
  const [value, setValue] = useState("");
  const [localError, setLocalError] = useState<string>();

  useEffect(() => {
    if (open) {
      setValue("");
      setLocalError(undefined);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }

    const arxivId = normalizeArxivId(value);
    if (!arxivId) {
      setLocalError("Enter an arXiv ID like 2301.12345 or a link such as arxiv.org/abs/2301.12345.");
      return;
    }

    setLocalError(undefined);
    onSubmit(arxivId);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="manual-modal collection-modal" onSubmit={handleSubmit} role="dialog" aria-modal="true" aria-label="Add by arXiv ID">
        <header>
          <div>
            <h2>Add by arXiv ID</h2>
            <p>{targetCollectionName ? `Add to ${targetCollectionName}` : "Add to Unsorted"}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="collection-modal-body">
          <label>
            arXiv ID
            <input
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setLocalError(undefined);
              }}
              placeholder="2301.12345 or arxiv.org/abs/2301.12345"
              autoFocus
              required
              disabled={busy}
            />
          </label>
          {(localError ?? error) && <p className="modal-copy">{localError ?? error}</p>}
        </div>

        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            <Hash size={16} />
            {busy ? "Fetching..." : "Add"}
          </button>
        </footer>
      </form>
    </div>
  );
}
