import { AlertCircle, FileText, Star } from "lucide-react";
import type { FileAsset, LibraryState, Paper } from "@lumora/shared";
import { useMemo, useState } from "react";

type SortKey = "authors" | "title" | "type" | "year" | "venue" | "tags" | "added";

type PaperListProps = {
  state: LibraryState;
  papers: Paper[];
  selectedPaperId?: string;
  onSelectPaper: (id: string) => void;
  onUpdatePaper: (paper: Paper) => void;
};

export function PaperList({
  state,
  papers,
  selectedPaperId,
  onSelectPaper,
  onUpdatePaper
}: PaperListProps) {
  const [sortKey, setSortKey] = useState<SortKey>("added");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const sortedPapers = useMemo(
    () => [...papers].sort((a, b) => comparePapers(a, b, sortKey, sortDirection)),
    [papers, sortDirection, sortKey]
  );

  function handleSort(nextSortKey: SortKey) {
    if (nextSortKey === sortKey) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }

    setSortKey(nextSortKey);
    setSortDirection(nextSortKey === "added" ? "desc" : "asc");
  }

  return (
    <section className="paper-list">
      <header className="paper-table-title">
        <h2>Documents</h2>
        <span>{papers.length} shown</span>
      </header>

      <div className="paper-table-wrap">
        {sortedPapers.length === 0 ? (
          <div className="empty-list">
            <FileText size={24} />
            <p>No papers in this collection.</p>
          </div>
        ) : (
          <table className="paper-table">
            <thead>
              <tr>
                <th aria-label="Favorite" />
                <th aria-label="Review status" />
                <SortableHeader label="Authors" sortKey="authors" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} />
                <SortableHeader label="Title" sortKey="title" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} />
                <SortableHeader label="Type" sortKey="type" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} />
                <SortableHeader label="Year" sortKey="year" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} />
                <SortableHeader label="Published In" sortKey="venue" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} />
                <SortableHeader label="Tags" sortKey="tags" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} />
                <SortableHeader label="Added" sortKey="added" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {sortedPapers.map((paper) => (
                <PaperRow
                  key={paper.id}
                  paper={paper}
                  fileAsset={state.fileAssets.find((file) => file.paperId === paper.id && !file.deletedAt)}
                  active={paper.id === selectedPaperId}
                  onClick={() => onSelectPaper(paper.id)}
                  onUpdatePaper={onUpdatePaper}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function SortableHeader({
  label,
  sortKey,
  activeSortKey,
  direction,
  onSort
}: {
  label: string;
  sortKey: SortKey;
  activeSortKey: SortKey;
  direction: "asc" | "desc";
  onSort: (sortKey: SortKey) => void;
}) {
  return (
    <th>
      <button type="button" onClick={() => onSort(sortKey)}>
        {label}
        {activeSortKey === sortKey && <span>{direction === "asc" ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

function PaperRow({
  paper,
  fileAsset,
  active,
  onClick,
  onUpdatePaper
}: {
  paper: Paper;
  fileAsset?: FileAsset;
  active: boolean;
  onClick: () => void;
  onUpdatePaper: (paper: Paper) => void;
}) {
  const authorLine = paper.authors.map((author) => author.fullName).join(", ");
  const tags = paper.tags?.join(", ") ?? "";

  return (
    <tr className={`${active ? "active " : ""}${paper.unread ? "unread" : ""}`} onClick={onClick}>
      <td>
        <button
          type="button"
          className={paper.favorite ? "table-icon-button active" : "table-icon-button"}
          onClick={(event) => {
            event.stopPropagation();
            onUpdatePaper({ ...paper, favorite: !paper.favorite });
          }}
          aria-label={paper.favorite ? "Remove from favorites" : "Add to favorites"}
        >
          <Star size={15} fill={paper.favorite ? "currentColor" : "none"} />
        </button>
      </td>
      <td>
        <button
          type="button"
          className={paper.needsReview ? "table-icon-button review active" : "table-icon-button review"}
          onClick={(event) => {
            event.stopPropagation();
            onUpdatePaper({ ...paper, needsReview: !paper.needsReview });
          }}
          aria-label={paper.needsReview ? "Mark reviewed" : "Mark needs review"}
        >
          <AlertCircle size={15} />
        </button>
      </td>
      <td title={authorLine || "No authors"}>{authorLine || "No authors"}</td>
      <td className="paper-title-cell" title={paper.title}>
        {fileAsset && <FileText size={14} />}
        <span>{paper.title}</span>
      </td>
      <td>{documentTypeLabel(paper.documentType)}</td>
      <td>{paper.year ?? ""}</td>
      <td title={paper.venue || fileAsset?.fileName || "PDF"}>{paper.venue || fileAsset?.fileName || "PDF"}</td>
      <td title={tags}>{tags}</td>
      <td>{formatDate(paper.createdAt)}</td>
    </tr>
  );
}

function comparePapers(a: Paper, b: Paper, sortKey: SortKey, direction: "asc" | "desc") {
  const multiplier = direction === "asc" ? 1 : -1;
  const aValue = sortValue(a, sortKey);
  const bValue = sortValue(b, sortKey);

  if (typeof aValue === "number" && typeof bValue === "number") {
    return (aValue - bValue) * multiplier;
  }

  return String(aValue).localeCompare(String(bValue)) * multiplier;
}

function sortValue(paper: Paper, sortKey: SortKey) {
  switch (sortKey) {
    case "authors":
      return paper.authors.map((author) => author.fullName).join(", ");
    case "title":
      return paper.title;
    case "type":
      return documentTypeLabel(paper.documentType);
    case "year":
      return paper.year ?? 0;
    case "venue":
      return paper.venue ?? "";
    case "tags":
      return paper.tags?.join(", ") ?? "";
    case "added":
      return new Date(paper.createdAt).getTime();
  }
}

function documentTypeLabel(value?: string) {
  switch (value) {
    case "book":
      return "Book";
    case "bookSection":
      return "Book Section";
    case "conferencePaper":
      return "Conference";
    case "thesis":
      return "Thesis";
    case "report":
      return "Report";
    case "journalArticle":
    default:
      return "Journal";
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}
