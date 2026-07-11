import { useEffect, useMemo, useState } from "react";
import { Copy, Trash2, X } from "lucide-react";
import type { LibraryState } from "@lumora/shared";
import { findDuplicateDocuments } from "../lib/duplicateDocuments";

export function DuplicateDocumentsModal({ open, state, onClose, onDelete }: {
  open: boolean;
  state: LibraryState;
  onClose: () => void;
  onDelete: (paperIds: string[]) => void;
}) {
  const groups = useMemo(() => findDuplicateDocuments(state), [state]);
  const [keepByHash, setKeepByHash] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setKeepByHash(Object.fromEntries(groups.map((group) => [group.hash, group.documents[0].paper.id])));
  }, [open, groups]);

  if (!open) return null;
  const deleteIds = groups.flatMap((group) => group.documents
    .filter((document) => document.paper.id !== keepByHash[group.hash])
    .map((document) => document.paper.id));

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="manual-modal duplicate-documents-modal" role="dialog" aria-modal="true" aria-label="Duplicate documents">
        <header>
          <div><h2>Duplicate Documents</h2><p>PDFs are matched by SHA-256. Choose one document to keep in each group.</p></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="duplicate-documents-body">
          {groups.length === 0 ? (
            <div className="duplicate-empty"><Copy size={24} /><p>No duplicate PDFs found.</p></div>
          ) : groups.map((group, index) => (
            <section className="duplicate-group" key={group.hash}>
              <div className="duplicate-group-heading"><strong>Duplicate set {index + 1}</strong><code>{group.hash}</code></div>
              {group.documents.map((document) => (
                <label className={keepByHash[group.hash] === document.paper.id ? "duplicate-document keep" : "duplicate-document"} key={document.paper.id}>
                  <input type="radio" name={`keep-${group.hash}`} checked={keepByHash[group.hash] === document.paper.id}
                    onChange={() => setKeepByHash((current) => ({ ...current, [group.hash]: document.paper.id }))} />
                  <span className="duplicate-document-copy">
                    <strong>{document.paper.title}</strong>
                    <small>{document.fileName}</small>
                    <span className="duplicate-folder-paths">
                      {(document.folderPaths.length ? document.folderPaths : ["Unfiled"]).map((path) => <em key={path}>{path}</em>)}
                    </span>
                  </span>
                  <b>{keepByHash[group.hash] === document.paper.id ? "Keep" : "Move to Trash"}</b>
                </label>
              ))}
            </section>
          ))}
        </div>
        <footer>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="danger" disabled={!deleteIds.length} onClick={() => onDelete(deleteIds)}>
            <Trash2 size={15} /> Move {deleteIds.length} duplicate{deleteIds.length === 1 ? "" : "s"} to Trash
          </button>
        </footer>
      </section>
    </div>
  );
}
