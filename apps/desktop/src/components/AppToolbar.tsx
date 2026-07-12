import { HelpCircle, Search } from "lucide-react";
import { PdfFindBar } from "./PdfFindBar";

type AppToolbarProps = {
  search: string;
  searchMode: "library" | "pdf";
  status?: string;
  onSearchChange: (value: string) => void;
  pdfSearchTotalMatches?: number;
  pdfSearchActiveMatchIndex?: number;
  onPdfSearchNext?: () => void;
  onPdfSearchPrev?: () => void;
  onPdfSearchClose?: () => void;
};

export function AppToolbar({
  search,
  searchMode,
  status,
  onSearchChange,
  pdfSearchTotalMatches = 0,
  pdfSearchActiveMatchIndex = -1,
  onPdfSearchNext,
  onPdfSearchPrev,
  onPdfSearchClose
}: AppToolbarProps) {
  return (
    <header className="app-toolbar">
      {searchMode === "library" ? (
        <label className="global-search">
          <Search size={16} />
          <input
            type="text"
            data-search-input=""
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search library"
          />
        </label>
      ) : (
        <PdfFindBar
          query={search}
          onQueryChange={onSearchChange}
          totalMatches={pdfSearchTotalMatches}
          activeMatchIndex={pdfSearchActiveMatchIndex}
          onNextMatch={onPdfSearchNext ?? (() => {})}
          onPrevMatch={onPdfSearchPrev ?? (() => {})}
          onClose={onPdfSearchClose ?? (() => {})}
        />
      )}

      <div className="toolbar-status">
        {status && <span>{status}</span>}
        <button type="button" className="toolbar-icon" title="Help" aria-label="Help">
          <HelpCircle size={16} />
        </button>
      </div>
    </header>
  );
}
