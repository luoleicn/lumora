import { BookOpen, ChevronDown, DatabaseZap, FilePlus, FolderPlus, HelpCircle, RefreshCw, Search, Upload } from "lucide-react";
import { useState } from "react";

type AppToolbarProps = {
  search: string;
  busy: boolean;
  status?: string;
  onSearchChange: (value: string) => void;
  onAddPdf: () => void;
  onAddManual: () => void;
  onImportReferences: () => void;
  onOpenNotebook: () => void;
  onCreateCollection: () => void;
  onSync: () => void;
  onConnectMendeley: () => void;
  onImportMendeley: () => void;
};

export function AppToolbar({
  search,
  busy,
  status,
  onSearchChange,
  onAddPdf,
  onAddManual,
  onImportReferences,
  onOpenNotebook,
  onCreateCollection,
  onSync,
  onConnectMendeley,
  onImportMendeley
}: AppToolbarProps) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  function runMenuAction(action: () => void) {
    action();
    setAddMenuOpen(false);
  }

  return (
    <header className="app-toolbar">
      <div className="toolbar-command-group">
        <div className="toolbar-menu">
          <button type="button" className="toolbar-command primary" onClick={() => setAddMenuOpen((open) => !open)}>
            <Upload size={16} />
            Add
            <ChevronDown size={14} />
          </button>
          {addMenuOpen && (
            <div className="toolbar-menu-popover">
              <button type="button" onClick={() => runMenuAction(onAddPdf)}>
                <Upload size={15} />
                Add PDF
              </button>
              <button type="button" onClick={() => runMenuAction(onAddManual)}>
                <FilePlus size={15} />
                Add Entry Manually
              </button>
              <button type="button" onClick={() => runMenuAction(onImportReferences)}>
                <DatabaseZap size={15} />
                Import RIS/BibTeX
              </button>
            </div>
          )}
        </div>
        <button type="button" className="toolbar-command" onClick={onCreateCollection}>
          <FolderPlus size={16} />
          Folders
        </button>
        <button type="button" className="toolbar-command" onClick={onOpenNotebook}>
          <BookOpen size={16} />
          Notebook
        </button>
        <button type="button" className="toolbar-command" onClick={onSync} disabled={busy}>
          <RefreshCw size={16} />
          Sync
        </button>
        <button type="button" className="toolbar-command" onClick={onConnectMendeley} disabled={busy}>
          <DatabaseZap size={16} />
          Mendeley
        </button>
        <button type="button" className="toolbar-command" onClick={onImportMendeley} disabled={busy}>
          <DatabaseZap size={16} />
          Import
        </button>
      </div>

      <label className="global-search">
        <Search size={16} />
        <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search library" />
      </label>

      <div className="toolbar-status">
        {status && <span>{status}</span>}
        <button type="button" className="toolbar-icon" title="Help" aria-label="Help">
          <HelpCircle size={16} />
        </button>
      </div>
    </header>
  );
}
