import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { handleSearchEscape } from "../lib/searchKeyboard";

type PdfFindBarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  totalMatches: number;
  activeMatchIndex: number; // 0-based; -1 when no matches or no query
  onNextMatch: () => void;
  onPrevMatch: () => void;
  onClose: () => void;
};

export function PdfFindBar({
  query,
  onQueryChange,
  totalMatches,
  activeMatchIndex,
  onNextMatch,
  onPrevMatch,
  onClose
}: PdfFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the input when the bar appears.
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  // Keyboard shortcuts within the find bar.
  function handleKeyDown(event: React.KeyboardEvent) {
    if (handleSearchEscape(event, onClose)) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        onPrevMatch();
      } else {
        onNextMatch();
      }
    }
  }

  const hasQuery = query.trim().length > 0;
  const matchLabel = hasQuery
    ? totalMatches > 0
      ? activeMatchIndex >= 0
        ? `${activeMatchIndex + 1} of ${totalMatches}`
        : `${totalMatches} results`
      : "No results"
    : "";

  return (
    <div className="pdf-find-bar" role="search" aria-label="Find in document">
      <Search size={16} className="find-search-icon" />
      <input
        ref={inputRef}
        type="text"
        data-search-input=""
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in document"
        aria-label="Find in document"
      />
      <span className="find-match-count">{matchLabel}</span>
      <button
        type="button"
        className="find-nav-button"
        onClick={onPrevMatch}
        disabled={totalMatches === 0}
        aria-label="Previous match"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className="find-nav-button"
        onClick={onNextMatch}
        disabled={totalMatches === 0}
        aria-label="Next match"
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className="find-close-button"
        onClick={onClose}
        aria-label="Close find bar"
      >
        <X size={14} />
      </button>
    </div>
  );
}
