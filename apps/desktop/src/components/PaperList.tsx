import { AlertCircle, FileText, Star } from "lucide-react";
import type { FileAsset, LibraryState, Paper } from "@lumora/shared";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";

type SortKey = "authors" | "title" | "year" | "venue" | "added";
type PaperColumnKey = "favorite" | "review" | SortKey;

type PaperColumn = {
  key: PaperColumnKey;
  label: string;
  sortKey?: SortKey;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
};

type PaperColumnWidths = Record<PaperColumnKey, number>;

type ColumnResizeDrag = {
  key: PaperColumnKey;
  startX: number;
  startWidth: number;
};

const columnWidthsKey = "lumora:documents-column-widths";

const paperColumns: PaperColumn[] = [
  { key: "favorite", label: "Favorite", defaultWidth: 32, minWidth: 28, maxWidth: 72 },
  { key: "review", label: "Review status", defaultWidth: 32, minWidth: 28, maxWidth: 72 },
  { key: "authors", label: "Authors", sortKey: "authors", defaultWidth: 178, minWidth: 96, maxWidth: 520 },
  { key: "title", label: "Title", sortKey: "title", defaultWidth: 310, minWidth: 150, maxWidth: 760 },
  { key: "year", label: "Year", sortKey: "year", defaultWidth: 62, minWidth: 52, maxWidth: 120 },
  { key: "venue", label: "Published In", sortKey: "venue", defaultWidth: 178, minWidth: 104, maxWidth: 520 },
  { key: "added", label: "Added", sortKey: "added", defaultWidth: 82, minWidth: 72, maxWidth: 160 }
];

type PaperListProps = {
  state: LibraryState;
  papers: Paper[];
  selectedPaperId?: string;
  onSelectPaper: (id: string) => void;
  onOpenPaper: (id: string) => void;
  onUpdatePaper: (paper: Paper) => void;
};

export function PaperList({
  state,
  papers,
  selectedPaperId,
  onSelectPaper,
  onOpenPaper,
  onUpdatePaper
}: PaperListProps) {
  const [sortKey, setSortKey] = useState<SortKey>("added");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [columnWidths, setColumnWidths] = useState<PaperColumnWidths>(() => loadColumnWidths());
  const [resizingColumn, setResizingColumn] = useState<PaperColumnKey>();
  const columnResizeRef = useRef<ColumnResizeDrag | undefined>(undefined);
  const sortedPapers = useMemo(
    () => [...papers].sort((a, b) => comparePapers(a, b, sortKey, sortDirection)),
    [papers, sortDirection, sortKey]
  );
  const tableMinWidth = useMemo(
    () => paperColumns.reduce((total, column) => total + columnWidths[column.key], 0),
    [columnWidths]
  );

  useEffect(() => {
    localStorage.setItem(columnWidthsKey, JSON.stringify(columnWidths));
  }, [columnWidths]);

  function handleSort(nextSortKey: SortKey) {
    if (nextSortKey === sortKey) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }

    setSortKey(nextSortKey);
    setSortDirection(nextSortKey === "added" ? "desc" : "asc");
  }

  function handleColumnResizeStart(event: ReactPointerEvent<HTMLSpanElement>, key: PaperColumnKey) {
    event.preventDefault();
    event.stopPropagation();
    columnResizeRef.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key]
    };
    setResizingColumn(key);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleColumnResizeMove(event: ReactPointerEvent<HTMLSpanElement>) {
    const drag = columnResizeRef.current;
    if (!drag) {
      return;
    }

    const column = paperColumns.find((item) => item.key === drag.key);
    if (!column) {
      return;
    }

    const nextWidth = clamp(drag.startWidth + event.clientX - drag.startX, column.minWidth, column.maxWidth);
    setColumnWidths((current) => current[drag.key] === nextWidth
      ? current
      : { ...current, [drag.key]: nextWidth }
    );
  }

  function handleColumnResizeEnd(event: ReactPointerEvent<HTMLSpanElement>) {
    if (columnResizeRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    columnResizeRef.current = undefined;
    setResizingColumn(undefined);
  }

  function handleColumnResizeKeyDown(event: React.KeyboardEvent<HTMLSpanElement>, key: PaperColumnKey) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const column = paperColumns.find((item) => item.key === key);
    if (!column) {
      return;
    }

    const delta = event.key === "ArrowLeft" ? -12 : 12;
    setColumnWidths((current) => ({
      ...current,
      [key]: clamp(current[key] + delta, column.minWidth, column.maxWidth)
    }));
  }

  return (
    <section className="paper-list">
      <header className="paper-table-title">
        <h2>Documents</h2>
        <span>{papers.length} shown</span>
      </header>

      <div className={resizingColumn ? "paper-table-wrap resizing-columns" : "paper-table-wrap"}>
        {sortedPapers.length === 0 ? (
          <div className="empty-list">
            <FileText size={24} />
            <p>No papers in this collection.</p>
          </div>
        ) : (
          <table className={resizingColumn ? "paper-table resizing-columns" : "paper-table"} style={{ minWidth: tableMinWidth }}>
            <colgroup>
              {paperColumns.map((column) => (
                <col key={column.key} style={{ width: columnWidths[column.key] }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {paperColumns.map((column) => (
                  <ResizableHeader
                    key={column.key}
                    column={column}
                    activeSortKey={sortKey}
                    direction={sortDirection}
                    resizing={resizingColumn === column.key}
                    onSort={handleSort}
                    onResizeStart={handleColumnResizeStart}
                    onResizeMove={handleColumnResizeMove}
                    onResizeEnd={handleColumnResizeEnd}
                    onResizeKeyDown={handleColumnResizeKeyDown}
                  />
                ))}
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
                  onDoubleClick={() => onOpenPaper(paper.id)}
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

function ResizableHeader({
  column,
  activeSortKey,
  direction,
  resizing,
  onSort,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKeyDown
}: {
  column: PaperColumn;
  activeSortKey: SortKey;
  direction: "asc" | "desc";
  resizing: boolean;
  onSort: (sortKey: SortKey) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLSpanElement>, key: PaperColumnKey) => void;
  onResizeMove: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onResizeEnd: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>, key: PaperColumnKey) => void;
}) {
  const sortableKey = column.sortKey;

  return (
    <th aria-label={column.label} className={resizing ? "resizing-column" : undefined}>
      <div className="paper-table-header">
        {sortableKey ? (
          <button type="button" onClick={() => onSort(sortableKey)}>
            <span>{column.label}</span>
            {activeSortKey === sortableKey && <span>{direction === "asc" ? "▲" : "▼"}</span>}
          </button>
        ) : (
          <span className="paper-table-static-header" aria-hidden="true">
            {column.key === "favorite" && <Star size={13} />}
            {column.key === "review" && <AlertCircle size={13} />}
          </span>
        )}
        <span
          className={resizing ? "paper-column-resizer active" : "paper-column-resizer"}
          role="separator"
          aria-label={`Resize ${column.label} column`}
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={(event) => onResizeStart(event, column.key)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onKeyDown={(event) => onResizeKeyDown(event, column.key)}
        />
      </div>
    </th>
  );
}

function PaperRow({
  paper,
  fileAsset,
  active,
  onClick,
  onDoubleClick,
  onUpdatePaper
}: {
  paper: Paper;
  fileAsset?: FileAsset;
  active: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onUpdatePaper: (paper: Paper) => void;
}) {
  const authorLine = paper.authors.map((author) => author.fullName).join(", ");

  return (
    <tr
      className={`${active ? "active " : ""}${paper.unread ? "unread" : ""}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
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
      <td>{paper.year ?? ""}</td>
      <td title={paper.venue || fileAsset?.fileName || "PDF"}>{paper.venue || fileAsset?.fileName || "PDF"}</td>
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
    case "year":
      return paper.year ?? 0;
    case "venue":
      return paper.venue ?? "";
    case "added":
      return new Date(paper.createdAt).getTime();
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function loadColumnWidths(): PaperColumnWidths {
  try {
    const raw = localStorage.getItem(columnWidthsKey);
    const parsed = raw ? JSON.parse(raw) as Partial<Record<PaperColumnKey, unknown>> : {};
    return paperColumns.reduce((widths, column) => {
      const savedWidth = parsed[column.key];
      widths[column.key] = typeof savedWidth === "number" && Number.isFinite(savedWidth)
        ? clamp(savedWidth, column.minWidth, column.maxWidth)
        : column.defaultWidth;
      return widths;
    }, {} as PaperColumnWidths);
  } catch {
    return paperColumns.reduce((widths, column) => {
      widths[column.key] = column.defaultWidth;
      return widths;
    }, {} as PaperColumnWidths);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Math.round(value), min), max);
}
