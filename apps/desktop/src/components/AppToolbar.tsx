import { HelpCircle, Search } from "lucide-react";

type AppToolbarProps = {
  search: string;
  status?: string;
  onSearchChange: (value: string) => void;
};

export function AppToolbar({ search, status, onSearchChange }: AppToolbarProps) {
  return (
    <header className="app-toolbar">
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
