import { FolderPlus, Pencil, Trash2, X } from "lucide-react";
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

type RenameCollectionModalProps = {
  open: boolean;
  currentName?: string;
  onClose: () => void;
  onSave: (name: string) => void;
};

export function RenameCollectionModal({ open, currentName, onClose, onSave }: RenameCollectionModalProps) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) {
      setName(currentName ?? "");
    }
  }, [open, currentName]);

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
      <form className="manual-modal collection-modal" onSubmit={handleSubmit} role="dialog" aria-modal="true" aria-label="Rename folder">
        <header>
          <div>
            <h2>Rename Folder</h2>
            <p>{currentName ? `Rename ${currentName}` : "Rename this folder"}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="collection-modal-body">
          <label>
            Folder name
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus required onFocus={(event) => event.target.select()} />
          </label>
        </div>

        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            <Pencil size={16} />
            Rename
          </button>
        </footer>
      </form>
    </div>
  );
}

type DeleteCollectionModalProps = {
  open: boolean;
  collectionName?: string;
  parentName?: string;
  onClose: () => void;
  onDelete: () => void;
};

export function DeleteCollectionModal({ open, collectionName, parentName, onClose, onDelete }: DeleteCollectionModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="manual-modal collection-modal" role="dialog" aria-modal="true" aria-label="Delete folder">
        <header>
          <div>
            <h2>Delete Folder</h2>
            <p>{collectionName ? `Delete ${collectionName}` : "Delete this folder"}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="collection-modal-body">
          <p className="modal-copy">
            Papers in this folder will move to {parentName ? parentName : "Unsorted"}. Nested folders will move up one level.
          </p>
        </div>

        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onDelete}>
            <Trash2 size={16} />
            Delete
          </button>
        </footer>
      </div>
    </div>
  );
}
