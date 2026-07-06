import { FolderPlus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

type CollectionModalProps = {
  open: boolean;
  parentName?: string;
  onClose: () => void;
  onSave: (name: string) => void;
};

export function CollectionModal({ open, parentName, onClose, onSave }: CollectionModalProps) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    onSave(trimmed);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="manual-modal collection-modal" onSubmit={handleSubmit} role="dialog" aria-modal="true" aria-label="Create folder">
        <header>
          <div>
            <h2>Create Folder</h2>
            <p>{parentName ? `Nested under ${parentName}` : "Create a top-level folder"}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="collection-modal-body">
          <label>
            Folder name
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
          </label>
        </div>

        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            <FolderPlus size={16} />
            Create
          </button>
        </footer>
      </form>
    </div>
  );
}
