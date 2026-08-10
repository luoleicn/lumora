import { ChevronRight, FileCheck2, FileDown, FilePlus2, FileQuestion, FileText, FolderInput, FolderMinus, RotateCcw, Star, Trash2 } from "lucide-react";
import type { FileAsset, LibraryState, Paper } from "@lumora/shared";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { resolveVirtualListRange } from "../lib/listVirtualization";
import { getCollectionOptions, type CollectionOption } from "../lib/libraryActions";
import type { PaperSelectionMode } from "../lib/paperSelection";
import { collapseCjkSpaces, splitSnippet, type PaperSearchMeta, type SearchMatchedField } from "../lib/searchIndex";

const matchedFieldLabels: Record<SearchMatchedField, string> = {
  title: "Title",
  body: "Full text",
  authors: "Author",
  notes: "Note"
};

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
const paperRowHeight = 34;
const paperTableHeaderHeight = 29;
const paperRowOverscan = 12;

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
  searchMeta?: Map<string, PaperSearchMeta>;
  selectedPaperId?: string;
  selectedPaperIds: ReadonlySet<string>;
  selectedCollectionId: string;
  onSelectPaper: (id: string, mode?: PaperSelectionMode) => void;
  onSelectAllPapers: () => void;
  onOpenPaper: (id: string) => void;
  onUpdatePaper: (paper: Paper) => void;
  onPaperDragStart: (paperId: string) => void;
  onPaperDragMove: (paperId: string, collectionId?: string) => void;
  onPaperDragEnd: (paperId: string, collectionId?: string) => void;
  onMovePaperToCollection: (paperId: string, collectionId: string) => void;
  onRemovePaperFromCollection: (paperId: string) => void;
  onDeletePaper: (paperId: string) => void;
  onRestorePaper: (paperId: string) => void;
  onPermanentlyDeletePaper: (paperId: string) => void;
  onBindLocalPdf: (paperId: string) => void;
};

export function PaperList({
  state,
  papers,
  searchMeta,
  selectedPaperId,
  selectedPaperIds,
  selectedCollectionId,
  onSelectPaper,
  onSelectAllPapers,
  onOpenPaper,
  onUpdatePaper,
  onPaperDragStart,
  onPaperDragMove,
  onPaperDragEnd,
  onMovePaperToCollection,
  onRemovePaperFromCollection,
  onDeletePaper,
  onRestorePaper,
  onPermanentlyDeletePaper,
  onBindLocalPdf
}: PaperListProps) {
  const isTrash = selectedCollectionId === "trash";
  const [sortKey, setSortKey] = useState<SortKey>("added");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [searchSortOverride, setSearchSortOverride] = useState(false);
  const [columnWidths, setColumnWidths] = useState<PaperColumnWidths>(() => loadColumnWidths());
  const [resizingColumn, setResizingColumn] = useState<PaperColumnKey>();
  const [contextMenu, setContextMenu] = useState<PaperContextMenu>();
  const columnResizeRef = useRef<ColumnResizeDrag | undefined>(undefined);
  const internalPaperDragRef = useRef<InternalPaperDrag | undefined>(undefined);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [tableViewport, setTableViewport] = useState({ scrollTop: 0, height: 700 });
  // Search results arrive relevance-ordered; keep that order until the user
  // explicitly clicks a column header, and reset once the search ends.
  const relevanceOrdered = Boolean(searchMeta) && !searchSortOverride;
  const sortedPapers = useMemo(
    () => (relevanceOrdered ? papers : [...papers].sort((a, b) => comparePapers(a, b, sortKey, sortDirection))),
    [papers, relevanceOrdered, sortDirection, sortKey]
  );

  useEffect(() => {
    if (!searchMeta) {
      setSearchSortOverride(false);
    }
  }, [searchMeta]);
  const tableMinWidth = useMemo(
    () => paperColumns.reduce((total, column) => total + columnWidths[column.key], 0),
    [columnWidths]
  );
  const virtualRange = useMemo(() => resolveVirtualListRange(
    sortedPapers.length,
    tableViewport.scrollTop,
    tableViewport.height,
    {
      itemHeight: paperRowHeight,
      leadingHeight: paperTableHeaderHeight,
      overscanItems: paperRowOverscan
    }
  ), [sortedPapers.length, tableViewport]);
  const visiblePapers = sortedPapers.slice(virtualRange.start, virtualRange.end);
  const collectionOptions = useMemo(() => getCollectionOptions(state.collections), [state.collections]);

  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element) {
      return;
    }

    const updateHeight = () => {
      const height = element.clientHeight;
      setTableViewport((current) => current.height === height ? current : { ...current, height });
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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

  useEffect(() => {
    const handleSelectAllKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      const isEditingText = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if (
        event.key.toLowerCase() !== "a"
        || (!event.metaKey && !event.ctrlKey)
        || event.altKey
        || event.shiftKey
        || isEditingText
      ) {
        return;
      }

      event.preventDefault();
      onSelectAllPapers();
    };

    window.addEventListener("keydown", handleSelectAllKeyDown);
    return () => window.removeEventListener("keydown", handleSelectAllKeyDown);
  }, [onSelectAllPapers]);

  function handleSort(nextSortKey: SortKey) {
    if (searchMeta) {
      setSearchSortOverride(true);
    }
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
    if (!selectedPaperIds.has(paperId)) {
      onSelectPaper(paperId);
    }
    setContextMenu({ paperId, x: event.clientX, y: event.clientY });
  }

  function handlePaperPointerDown(event: React.PointerEvent<HTMLTableRowElement>, paperId: string) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }

    event.preventDefault();
    tableWrapRef.current?.focus({ preventScroll: true });
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
        <span>
          {selectedPaperIds.size > 0 && `${selectedPaperIds.size} selected · `}
          {papers.length} shown
        </span>
      </header>

      <div
        ref={tableWrapRef}
        className={resizingColumn ? "paper-table-wrap resizing-columns" : "paper-table-wrap"}
        tabIndex={0}
        aria-label="Documents list"
        onScroll={(event) => {
          const scrollTop = event.currentTarget.scrollTop;
          setTableViewport((current) => current.scrollTop === scrollTop ? current : { ...current, scrollTop });
        }}
      >
        {sortedPapers.length === 0 ? (
          <div className="empty-list">
            <FileText size={24} />
            <p>{searchMeta ? "No matches in library." : "No papers in this collection."}</p>
          </div>
        ) : (
          <table
            className={resizingColumn ? "paper-table resizing-columns" : "paper-table"}
            style={{ minWidth: tableMinWidth }}
            role="grid"
            aria-multiselectable="true"
          >
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
              {virtualRange.paddingBefore > 0 && (
                <tr className="paper-table-spacer" aria-hidden>
                  <td colSpan={paperColumns.length} style={{ height: virtualRange.paddingBefore }} />
                </tr>
              )}
              {visiblePapers.map((paper) => {
                const isPaperPdf = (file: FileAsset) =>
                  file.paperId === paper.id
                  && !file.deletedAt
                  && (file.mime === "application/pdf" || /\.pdf$/i.test(file.fileName));
                // A PDF is only "local" when its bytes actually live on this
                // device (localPath, or the legacy downloadState flag). A synced
                // record with just a cloud reference is "remote" — it must not
                // read as an available local file, which is exactly what shows up
                // in the "No PDF" collection on a freshly synced device.
                const localPdf = state.fileAssets.find(
                  (file) => isPaperPdf(file) && (Boolean(file.localPath) || file.downloadState === "local")
                );
                const anyPdf = localPdf ?? state.fileAssets.find(isPaperPdf);
                const pdfState: PdfState = localPdf ? "local" : anyPdf ? "remote" : "none";
                return (
                  <PaperRow
                    key={paper.id}
                    paper={paper}
                    searchMeta={searchMeta?.get(paper.id)}
                    fileAsset={anyPdf}
                    pdfState={pdfState}
                    active={selectedPaperIds.has(paper.id)}
                    primary={paper.id === selectedPaperId}
                    onClick={(event) => onSelectPaper(
                      paper.id,
                      event.shiftKey
                        ? event.metaKey || event.ctrlKey ? "add-range" : "range"
                        : event.metaKey || event.ctrlKey ? "toggle" : "replace"
                    )}
                    onDoubleClick={() => onOpenPaper(paper.id)}
                    onUpdatePaper={onUpdatePaper}
                    onPointerDown={(event) => handlePaperPointerDown(event, paper.id)}
                    onContextMenu={(event) => handlePaperContextMenu(event, paper.id)}
                  />
                );
              })}
              {virtualRange.paddingAfter > 0 && (
                <tr className="paper-table-spacer" aria-hidden>
                  <td colSpan={paperColumns.length} style={{ height: virtualRange.paddingAfter }} />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {contextMenu && (
        <PaperContextMenu
          key={`${contextMenu.paperId}:${contextMenu.x}:${contextMenu.y}`}
          x={contextMenu.x}
          y={contextMenu.y}
          isTrash={isTrash}
          collectionOptions={collectionOptions}
          selectedCollectionId={selectedCollectionId}
          canRemoveFromCollection={isRealCollectionId(selectedCollectionId)}
          hasLocalPdf={state.fileAssets.some((file) => file.paperId === contextMenu.paperId && !file.deletedAt && (file.mime === "application/pdf" || /\.pdf$/i.test(file.fileName)) && (Boolean(file.localPath) || file.downloadState === "local"))}
          onBindLocalPdf={() => { onBindLocalPdf(contextMenu.paperId); setContextMenu(undefined); }}
          onMoveToCollection={(collectionId) => {
            onMovePaperToCollection(contextMenu.paperId, collectionId);
            setContextMenu(undefined);
          }}
          onRemoveFromCollection={() => {
            onRemovePaperFromCollection(contextMenu.paperId);
            setContextMenu(undefined);
          }}
          onRestorePaper={() => {
            onRestorePaper(contextMenu.paperId);
            setContextMenu(undefined);
          }}
          onPermanentlyDeletePaper={() => {
            onPermanentlyDeletePaper(contextMenu.paperId);
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

type PdfState = "local" | "remote" | "none";

function PaperRow({
  paper,
  searchMeta,
  fileAsset,
  pdfState,
  active,
  primary,
  onClick,
  onDoubleClick,
  onUpdatePaper,
  onPointerDown,
  onContextMenu
}: {
  paper: Paper;
  searchMeta?: PaperSearchMeta;
  fileAsset?: FileAsset;
  pdfState: PdfState;
  active: boolean;
  primary: boolean;
  onClick: (event: React.MouseEvent<HTMLTableRowElement>) => void;
  onDoubleClick: () => void;
  onUpdatePaper: (paper: Paper) => void;
  onPointerDown: (event: React.PointerEvent<HTMLTableRowElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLTableRowElement>) => void;
}) {
  const authorLine = paper.authors.map((author) => author.fullName).join(", ");

  return (
    <tr
      className={`${active ? "active " : ""}${paper.unread ? "unread" : ""}`}
      aria-selected={active}
      data-primary-selection={primary ? "true" : undefined}
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
        <div className="paper-title-line">
          <span
            className={`paper-file-status ${pdfState === "local" ? "has-pdf" : pdfState === "remote" ? "remote-pdf" : "no-pdf"}`}
            title={
              pdfState === "local"
                ? `PDF available locally: ${fileAsset?.fileName ?? ""}`
                : pdfState === "remote"
                  ? `PDF in cloud — not downloaded to this device${fileAsset ? `: ${fileAsset.fileName}` : ""}`
                  : "No PDF attached"
            }
            aria-label={
              pdfState === "local"
                ? "PDF available locally"
                : pdfState === "remote"
                  ? "PDF in cloud, not downloaded"
                  : "No PDF attached"
            }
          >
            {pdfState === "local"
              ? <FileCheck2 size={16} />
              : pdfState === "remote"
                ? <FileDown size={16} />
                : <FileQuestion size={16} />}
          </span>
          <span>{paper.title}</span>
        </div>
        {searchMeta && (
          <div className="paper-search-meta">
            {searchMeta.matchedFields.map((field) => (
              <span key={field} className="search-match-badge">{matchedFieldLabels[field]}</span>
            ))}
            {searchMeta.snippet && (
              <span className="search-snippet">
                {splitSnippet(collapseCjkSpaces(searchMeta.snippet)).map((segment, index) =>
                  segment.highlighted
                    ? <mark key={index}>{segment.text}</mark>
                    : <span key={index}>{segment.text}</span>
                )}
              </span>
            )}
          </div>
        )}
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
  isTrash,
  collectionOptions,
  selectedCollectionId,
  canRemoveFromCollection,
  onRemoveFromCollection,
  onRestorePaper,
  onPermanentlyDeletePaper,
  onDeletePaper,
  hasLocalPdf,
  onBindLocalPdf,
  onMoveToCollection
}: {
  x: number;
  y: number;
  isTrash: boolean;
  collectionOptions: CollectionOption[];
  selectedCollectionId: string;
  canRemoveFromCollection: boolean;
  onRemoveFromCollection: () => void;
  onRestorePaper: () => void;
  onPermanentlyDeletePaper: () => void;
  onDeletePaper: () => void;
  hasLocalPdf: boolean;
  onBindLocalPdf: () => void;
  onMoveToCollection: (collectionId: string) => void;
}) {
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const submenuOpensLeft = typeof window !== "undefined" && x + 430 > window.innerWidth;

  return (
    <div
      className="paper-context-menu"
      style={{ left: x, top: y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {isTrash ? (
        <>
          <button type="button" role="menuitem" onClick={onRestorePaper}>
            <RotateCcw size={15} />
            <span>Restore to Unsorted</span>
          </button>
          <button type="button" className="danger" role="menuitem" onClick={onPermanentlyDeletePaper}>
            <Trash2 size={15} />
            <span>Delete Permanently</span>
          </button>
        </>
      ) : (
        <>
          {!hasLocalPdf && (
            <button type="button" role="menuitem" onClick={onBindLocalPdf}>
              <FilePlus2 size={15} />
              <span>Bind Local PDF…</span>
            </button>
          )}
          <div className="paper-context-submenu-anchor">
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={moveMenuOpen}
              onClick={() => setMoveMenuOpen((current) => !current)}
            >
              <FolderInput size={15} />
              <span>Move to</span>
              <ChevronRight className="paper-context-menu-chevron" size={14} />
            </button>
            {moveMenuOpen && (
              <div
                className={`paper-context-submenu${submenuOpensLeft ? " open-left" : ""}`}
                role="menu"
                aria-label="Move document to collection"
              >
                {collectionOptions.map((collection) => {
                  const isCurrentCollection = collection.id === selectedCollectionId;
                  return (
                    <button
                      key={collection.id}
                      type="button"
                      role="menuitem"
                      disabled={isCurrentCollection}
                      title={isCurrentCollection ? `${collection.path} — current collection` : collection.path}
                      onClick={() => onMoveToCollection(collection.id)}
                    >
                      <span className="paper-context-collection-path">{collection.path}</span>
                    </button>
                  );
                })}
                {collectionOptions.length === 0 && (
                  <span className="paper-context-menu-empty">No collections available</span>
                )}
              </div>
            )}
          </div>
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
        </>
      )}
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
