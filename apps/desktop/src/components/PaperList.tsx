import { FileText, FolderMinus, Star, Trash2 } from "lucide-react";
import type { FileAsset, LibraryState, Paper } from "@lumora/shared";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";

type SortKey = "authors" | "title" | "year" | "venue" | "added";
type PaperColumnKey = "favorite" | SortKey;

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

type InternalPaperDrag = {
  paperId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  cleanup: () => void;
};

type PaperContextMenu = {
  paperId: string;
  x: number;
  y: number;
};

const columnWidthsKey = "lumora:documents-column-widths";

const paperColumns: PaperColumn[] = [
  { key: "favorite", label: "Favorite", defaultWidth: 32, minWidth: 28, maxWidth: 72 },
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
  selectedCollectionId: string;
  onSelectPaper: (id: string) => void;
  onOpenPaper: (id: string) => void;
  onUpdatePaper: (paper: Paper) => void;
  onPaperDragStart: (paperId: string) => void;
  onPaperDragMove: (paperId: string, collectionId?: string) => void;
  onPaperDragEnd: (paperId: string, collectionId?: string) => void;
  onRemovePaperFromCollection: (paperId: string) => void;
  onDeletePaper: (paperId: string) => void;
};

export function PaperList({
  state,
  papers,
  selectedPaperId,
  selectedCollectionId,
  onSelectPaper,
  onOpenPaper,
  onUpdatePaper,
  onPaperDragStart,
  onPaperDragMove,
  onPaperDragEnd,
  onRemovePaperFromCollection,
  onDeletePaper
}: PaperListProps) {
  const [sortKey, setSortKey] = useState<SortKey>("added");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [columnWidths, setColumnWidths] = useState<PaperColumnWidths>(() => loadColumnWidths());
  const [resizingColumn, setResizingColumn] = useState<PaperColumnKey>();
  const [contextMenu, setContextMenu] = useState<PaperContextMenu>();
  const columnResizeRef = useRef<ColumnResizeDrag | undefined>(undefined);
  const internalPaperDragRef = useRef<InternalPaperDrag | undefined>(undefined);
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

  useEffect(() => {
    return () => {
      internalPaperDragRef.current?.cleanup();
      document.body.classList.remove("paper-pointer-dragging");
    };
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = () => setContextMenu(undefined);
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [contextMenu]);

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

  function handlePaperContextMenu(event: React.MouseEvent<HTMLTableRowElement>, paperId: string) {
    event.preventDefault();
    onSelectPaper(paperId);
    setContextMenu({ paperId, x: event.clientX, y: event.clientY });
  }

  function handlePaperPointerDown(event: React.PointerEvent<HTMLTableRowElement>, paperId: string) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }

    event.preventDefault();
    internalPaperDragRef.current?.cleanup();

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const drag: InternalPaperDrag = {
      paperId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      cleanup: () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerEnd);
        window.removeEventListener("pointercancel", handlePointerEnd);
        document.body.style.userSelect = previousUserSelect;
        if (internalPaperDragRef.current === drag) {
          internalPaperDragRef.current = undefined;
        }
      }
    };

    function handlePointerMove(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== drag.pointerId) {
        return;
      }

      const distance = Math.hypot(pointerEvent.clientX - drag.startX, pointerEvent.clientY - drag.startY);
      if (!drag.dragging && distance > 6) {
        drag.dragging = true;
        document.body.classList.add("paper-pointer-dragging");
        onPaperDragStart(paperId);
      }

      if (drag.dragging) {
        pointerEvent.preventDefault();
        onPaperDragMove(paperId, getCollectionDropIdAtPoint(pointerEvent.clientX, pointerEvent.clientY));
      }
    }

    function handlePointerEnd(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== drag.pointerId) {
        return;
      }

      const collectionId = drag.dragging
        ? getCollectionDropIdAtPoint(pointerEvent.clientX, pointerEvent.clientY)
        : undefined;

      drag.cleanup();
      document.body.classList.remove("paper-pointer-dragging");

      if (drag.dragging) {
        pointerEvent.preventDefault();
        onPaperDragEnd(paperId, collectionId);
      }
    }

    internalPaperDragRef.current = drag;
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
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
                  onPointerDown={(event) => handlePaperPointerDown(event, paper.id)}
                  onContextMenu={(event) => handlePaperContextMenu(event, paper.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {contextMenu && (
        <PaperContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canRemoveFromCollection={isRealCollectionId(selectedCollectionId)}
          onRemoveFromCollection={() => {
            onRemovePaperFromCollection(contextMenu.paperId);
            setContextMenu(undefined);
          }}
          onDeletePaper={() => {
            onDeletePaper(contextMenu.paperId);
            setContextMenu(undefined);
          }}
        />
      )}
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
  onUpdatePaper,
  onPointerDown,
  onContextMenu
}: {
  paper: Paper;
  fileAsset?: FileAsset;
  active: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onUpdatePaper: (paper: Paper) => void;
  onPointerDown: (event: React.PointerEvent<HTMLTableRowElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLTableRowElement>) => void;
}) {
  const authorLine = paper.authors.map((author) => author.fullName).join(", ");

  return (
    <tr
      className={`${active ? "active " : ""}${paper.unread ? "unread" : ""}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
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
      <td title={authorLine || "No authors"}>{authorLine || "No authors"}</td>
      <td className="paper-title-cell" title={paper.title}>
        {fileAsset && <FileText size={14} />}
        <span>{paper.title}</span>
      </td>
      <td>{paper.year ?? ""}</td>
      <td title={paper.venue || fileAsset?.fileName || "PDF"}>
        {paper.venue || fileAsset?.fileName || "PDF"}
      </td>
      <td>{formatDate(paper.createdAt)}</td>
    </tr>
  );
}

function PaperContextMenu({
  x,
  y,
  canRemoveFromCollection,
  onRemoveFromCollection,
  onDeletePaper
}: {
  x: number;
  y: number;
  canRemoveFromCollection: boolean;
  onRemoveFromCollection: () => void;
  onDeletePaper: () => void;
}) {
  return (
    <div
      className="paper-context-menu"
      style={{ left: x, top: y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {canRemoveFromCollection && (
        <button type="button" role="menuitem" onClick={onRemoveFromCollection}>
          <FolderMinus size={15} />
          <span>Remove from Folder</span>
        </button>
      )}
      <button type="button" className="danger" role="menuitem" onClick={onDeletePaper}>
        <Trash2 size={15} />
        <span>Delete Document</span>
      </button>
    </div>
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

function getCollectionDropIdAtPoint(x: number, y: number) {
  const elements = typeof document.elementsFromPoint === "function"
    ? document.elementsFromPoint(x, y)
    : [document.elementFromPoint(x, y)].filter(Boolean);

  for (const element of elements) {
    const dropElement = element?.closest?.(".collection-tree-row[data-collection-drop-id]") as HTMLElement | null | undefined;
    if (dropElement?.dataset.collectionDropId) {
      return dropElement.dataset.collectionDropId;
    }
  }

  return undefined;
}

function isRealCollectionId(collectionId: string) {
  return !["all", "recently_added", "favorites", "unsorted", "trash"].includes(collectionId);
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
