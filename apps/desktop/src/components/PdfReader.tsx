import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { MessageSquare, Minus, Plus, StickyNote, Trash2, X } from "lucide-react";
import type { Annotation, FileAsset, Paper } from "@lumora/shared";
import { mergeNearbyRects, normalizeRect } from "@lumora/shared";
import { createId } from "../lib/id";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

type PendingSelection = {
  pageIndex: number;
  rects: Annotation["rects"];
  quote: string;
};

type NewAnnotationContextMenu = {
  kind: "new";
  x: number;
  y: number;
  selection: PendingSelection;
  mode: "actions" | "note";
  noteText: string;
};

type ExistingAnnotationContextMenu = {
  kind: "existing";
  x: number;
  y: number;
  annotation: Annotation;
  mode: "actions" | "note" | "viewNote";
  noteText: string;
  selectionBased?: boolean;
};

type AnnotationContextMenu = NewAnnotationContextMenu | ExistingAnnotationContextMenu;

type PdfReaderProps = {
  paper?: Paper;
  fileAsset?: FileAsset;
  fileData?: Uint8Array;
  annotations: Annotation[];
  onCreateAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
};

const colors = ["#ffe45c", "#8ee6a8", "#82cfff", "#ffadad"];

export function PdfReader({
  paper,
  fileAsset,
  fileData,
  annotations,
  onCreateAnnotation,
  onDeleteAnnotation
}: PdfReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageWidth, setPageWidth] = useState(760);
  const [zoom, setZoom] = useState(1);
  const [color, setColor] = useState(colors[0]);
  const [contextMenu, setContextMenu] = useState<AnnotationContextMenu>();
  const [loadError, setLoadError] = useState<string>();
  const documentFile = useMemo(() => (fileData ? { data: fileData.slice() } : undefined), [fileData]);

  const visibleAnnotations = useMemo(
    () => annotations.filter((annotation) => !annotation.deletedAt),
    [annotations]
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const resize = () => {
      setPageWidth(Math.min(920, Math.max(420, element.clientWidth - 56)));
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = () => {
      if (contextMenu.mode !== "note") {
        setContextMenu(undefined);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(undefined);
      }
    };

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    setContextMenu(undefined);
    setNumPages(0);
    setLoadError(undefined);
  }, [fileData]);

  function handleContextMenu(event: React.MouseEvent) {
    const existingAnnotation = findAnnotationAtPoint(scrollRef.current, event.clientX, event.clientY, visibleAnnotations);
    if (existingAnnotation) {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      setContextMenu({
        kind: "existing",
        x: event.clientX,
        y: event.clientY,
        annotation: existingAnnotation,
        mode: "actions",
        noteText: existingAnnotation.comment ?? ""
      });
      return;
    }

    const selection = readCurrentSelection(scrollRef.current);
    if (!selection) {
      setContextMenu(undefined);
      return;
    }

    event.preventDefault();
    setContextMenu({
      kind: "new",
      x: event.clientX,
      y: event.clientY,
      selection,
      mode: "actions",
      noteText: ""
    });
  }

  function handleSelectionPointerUp(event: React.PointerEvent) {
    if (event.button !== 0) {
      return;
    }

    window.setTimeout(() => {
      const selection = readCurrentSelection(scrollRef.current);
      if (!selection) {
        return;
      }

      const existingAnnotation = findAnnotationForSelection(selection, visibleAnnotations);
      const position = getSelectionMenuPosition(scrollRef.current);
      if (!position) {
        return;
      }

      if (existingAnnotation) {
        setContextMenu({
          kind: "existing",
          x: position.x,
          y: position.y,
          annotation: existingAnnotation,
          mode: "actions",
          noteText: existingAnnotation.comment ?? "",
          selectionBased: true
        });
        return;
      }

      setContextMenu({
        kind: "new",
        x: position.x,
        y: position.y,
        selection,
        mode: "actions",
        noteText: ""
      });
    }, 0);
  }

  function createAnnotation(kind: Annotation["kind"], selection: PendingSelection, comment?: string) {
    if (!paper || !fileAsset) {
      return;
    }

    const now = new Date().toISOString();
    onCreateAnnotation({
      id: createId("annotation"),
      paperId: paper.id,
      fileId: fileAsset.id,
      pageIndex: selection.pageIndex,
      kind,
      color,
      rects: selection.rects,
      quote: selection.quote,
      comment: kind === "note" ? comment?.trim() : undefined,
      createdAt: now,
      updatedAt: now
    });

    window.getSelection()?.removeAllRanges();
    setContextMenu(undefined);
  }

  function updateAnnotationWithNote(annotation: Annotation, comment: string) {
    const trimmed = comment.trim();
    if (!trimmed) {
      setContextMenu(undefined);
      return;
    }

    onCreateAnnotation({
      ...annotation,
      kind: "note",
      comment: trimmed,
      updatedAt: new Date().toISOString()
    });
    setContextMenu(undefined);
  }

  function removeNoteFromAnnotation(annotation: Annotation) {
    onCreateAnnotation({
      ...annotation,
      kind: "highlight",
      comment: undefined,
      updatedAt: new Date().toISOString()
    });
    window.getSelection()?.removeAllRanges();
    setContextMenu(undefined);
  }

  if (!paper) {
    return (
      <section className="reader-empty">
        <div>
          <h2>No paper selected</h2>
          <p>Import a PDF or select a paper from the library.</p>
        </div>
      </section>
    );
  }

  if (!fileData) {
    return (
      <section className="reader-empty">
        <div>
          <h2>{paper.title}</h2>
          <p>The PDF is not available locally yet.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="reader">
      <header className="reader-toolbar">
        <div className="paper-heading">
          <h2>{paper.title}</h2>
          <span>{fileAsset?.fileName}</span>
        </div>
        <div className="toolbar-actions">
          <button className="icon-button" type="button" onClick={() => setZoom((value) => Math.max(0.7, value - 0.1))} aria-label="Zoom out">
            <Minus size={17} />
          </button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="icon-button" type="button" onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))} aria-label="Zoom in">
            <Plus size={17} />
          </button>
        </div>
      </header>

      <div className="reader-body">
        <div ref={scrollRef} className="pdf-scroll" onContextMenu={handleContextMenu} onPointerUp={handleSelectionPointerUp}>
          <Document
            file={documentFile}
            loading={<div className="pdf-status">Loading PDF...</div>}
            error={<div className="pdf-status">Failed to load PDF.{loadError ? <span>{loadError}</span> : null}</div>}
            onLoadSuccess={({ numPages: nextNumPages }) => setNumPages(nextNumPages)}
            onLoadError={(error) => setLoadError(error.message)}
          >
            {Array.from({ length: numPages }, (_, index) => (
              <div className="page-shell" data-page-index={index} key={index}>
                <Page pageNumber={index + 1} width={pageWidth * zoom} renderAnnotationLayer renderTextLayer />
                <AnnotationOverlay
                  annotations={visibleAnnotations.filter((annotation) => annotation.pageIndex === index)}
                  onOpenAnnotationMenu={(annotation, event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenu({
                      kind: "existing",
                      x: event.clientX,
                      y: event.clientY,
                      annotation,
                      mode: "actions",
                      noteText: annotation.comment ?? ""
                    });
                  }}
                />
              </div>
            ))}
          </Document>
        </div>
        {contextMenu && (
          <AnnotationContextMenu
            menu={contextMenu}
            color={color}
            onColorChange={setColor}
            onClose={() => setContextMenu(undefined)}
            onChangeNote={(noteText) => setContextMenu((current) => current ? { ...current, noteText } : current)}
            onStartNote={() => setContextMenu((current) => current ? { ...current, mode: "note" } : current)}
            onShowNote={() => setContextMenu((current) =>
              current?.kind === "existing" ? { ...current, mode: "viewNote" } : current
            )}
            onHighlight={() => {
              if (contextMenu.kind === "new") {
                createAnnotation("highlight", contextMenu.selection);
              }
            }}
            onDeleteAnnotation={(annotation) => {
              onDeleteAnnotation(annotation);
              window.getSelection()?.removeAllRanges();
              setContextMenu(undefined);
            }}
            onDeleteNote={removeNoteFromAnnotation}
            onSaveNote={(noteText) => {
              if (contextMenu.kind === "existing") {
                updateAnnotationWithNote(contextMenu.annotation, noteText);
              } else if (noteText.trim()) {
                createAnnotation("note", contextMenu.selection, noteText);
              } else {
                window.getSelection()?.removeAllRanges();
                setContextMenu(undefined);
              }
            }}
          />
        )}
      </div>
    </section>
  );
}

function AnnotationOverlay({
  annotations,
  onOpenAnnotationMenu
}: {
  annotations: Annotation[];
  onOpenAnnotationMenu: (annotation: Annotation, event: React.MouseEvent) => void;
}) {
  const [openNoteId, setOpenNoteId] = useState<string>();
  const openNote = annotations.find((annotation) => annotation.id === openNoteId && annotation.kind === "note");
  const openNoteRect = openNote?.rects[0];

  return (
    <div className="annotation-overlay">
      {annotations.flatMap((annotation) =>
        annotation.rects.map((rect, rectIndex) => (
          <span
            className="highlight-rect"
            key={`${annotation.id}-${rectIndex}`}
            aria-hidden
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              backgroundColor: annotation.color
            }}
          />
        ))
      )}
      {annotations.filter((annotation) => annotation.kind === "note").map((annotation) => {
        const rect = annotation.rects[0];
        if (!rect) {
          return null;
        }

        return (
          <button
            type="button"
            className={openNoteId === annotation.id ? "note-marker active" : "note-marker"}
            key={`${annotation.id}-marker`}
            style={{
              left: `${Math.min(0.965, rect.x + rect.width) * 100}%`,
              top: `${Math.max(0.01, rect.y) * 100}%`
            }}
            onClick={(event) => {
              event.stopPropagation();
              setOpenNoteId((current) => current === annotation.id ? undefined : annotation.id);
            }}
            onContextMenu={(event) => onOpenAnnotationMenu(annotation, event)}
            aria-label="Show note"
            title="Show note"
          >
            <MessageSquare size={12} />
          </button>
        );
      })}
      {openNote && openNoteRect && (
        <aside
          className="note-popover"
          style={{
            left: `${Math.min(0.84, openNoteRect.x + openNoteRect.width) * 100}%`,
            top: `${Math.min(0.92, openNoteRect.y + openNoteRect.height + 0.01) * 100}%`
          }}
        >
          <header>
            <span>Note</span>
            <button type="button" onClick={() => setOpenNoteId(undefined)} aria-label="Close note">
              <X size={13} />
            </button>
          </header>
          <p>{openNote.comment}</p>
        </aside>
      )}
    </div>
  );
}

function AnnotationContextMenu({
  menu,
  color,
  onColorChange,
  onClose,
  onChangeNote,
  onStartNote,
  onShowNote,
  onHighlight,
  onDeleteAnnotation,
  onDeleteNote,
  onSaveNote
}: {
  menu: AnnotationContextMenu;
  color: string;
  onColorChange: (color: string) => void;
  onClose: () => void;
  onChangeNote: (noteText: string) => void;
  onStartNote: () => void;
  onShowNote: () => void;
  onHighlight: () => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  onDeleteNote: (annotation: Annotation) => void;
  onSaveNote: (noteText: string) => void;
}) {
  const title = getContextMenuTitle(menu);
  const quote = menu.kind === "new" ? menu.selection.quote : menu.annotation.quote;

  return (
    <div
      className="pdf-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
      aria-label="Annotation actions"
    >
      <header>
        <span>{title}</span>
        <button
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
          aria-label="Close annotation menu"
        >
          <X size={14} />
        </button>
      </header>
      {quote && <p>{quote}</p>}
      {menu.kind === "new" && menu.mode === "actions" && (
        <div className="context-swatches" aria-label="Annotation color">
          {colors.map((item) => (
            <button
              key={item}
              type="button"
              className={item === color ? "swatch active" : "swatch"}
              style={{ backgroundColor: item }}
              onClick={() => onColorChange(item)}
              aria-label={`Use color ${item}`}
            />
          ))}
        </div>
      )}

      {menu.mode === "note" ? (
        <div className="context-note-editor">
          <textarea
            value={menu.noteText}
            onChange={(event) => onChangeNote(event.target.value)}
            onBlur={(event) => onSaveNote(event.currentTarget.value)}
            placeholder="Add a note"
            autoFocus
          />
          <span>Click outside to save</span>
        </div>
      ) : menu.kind === "existing" && menu.selectionBased && menu.annotation.kind === "note" ? (
        <div className="button-row vertical">
          <button type="button" className="danger" onClick={() => onDeleteNote(menu.annotation)}>
            <Trash2 size={16} />
            Delete Note
          </button>
        </div>
      ) : menu.mode === "viewNote" && menu.kind === "existing" ? (
        <div className="context-note-view">
          <blockquote>{menu.annotation.comment || "No note content."}</blockquote>
          <button type="button" className="danger" onClick={() => onDeleteAnnotation(menu.annotation)}>
            <Trash2 size={16} />
            Delete Annotation
          </button>
        </div>
      ) : menu.kind === "existing" ? (
        <div className="button-row vertical">
          {menu.annotation.kind === "note" ? (
            <button type="button" onClick={onShowNote}>
              <MessageSquare size={16} />
              Show Note
            </button>
          ) : (
            <button type="button" onClick={onStartNote}>
              <MessageSquare size={16} />
              Add Note
            </button>
          )}
          <button type="button" className="danger" onClick={() => onDeleteAnnotation(menu.annotation)}>
            <Trash2 size={16} />
            {menu.selectionBased ? "Delete Highlight" : "Delete Annotation"}
          </button>
        </div>
      ) : (
        <div className="button-row">
          <button type="button" onClick={onHighlight}>
            <StickyNote size={16} />
            Highlight
          </button>
          <button type="button" onClick={onStartNote}>
            <MessageSquare size={16} />
            Note
          </button>
        </div>
      )}
    </div>
  );
}

function getContextMenuTitle(menu: AnnotationContextMenu) {
  if (menu.kind === "new") {
    return menu.mode === "note" ? "Add note" : "Annotate selection";
  }

  if (menu.mode === "note") {
    return "Add note to highlight";
  }

  if (menu.mode === "viewNote") {
    return "Note";
  }

  return menu.annotation.kind === "note" ? "Note annotation" : "Highlight annotation";
}

function findAnnotationAtPoint(
  container: HTMLElement | null,
  clientX: number,
  clientY: number,
  annotations: Annotation[]
): Annotation | undefined {
  if (!container) {
    return undefined;
  }

  const pages = Array.from(container.querySelectorAll<HTMLElement>("[data-page-index]"));
  for (const page of pages) {
    const pageRect = page.getBoundingClientRect();
    if (clientX < pageRect.left || clientX > pageRect.right || clientY < pageRect.top || clientY > pageRect.bottom) {
      continue;
    }

    const pageIndex = Number(page.dataset.pageIndex);
    const x = (clientX - pageRect.left) / pageRect.width;
    const y = (clientY - pageRect.top) / pageRect.height;
    return annotations.find((annotation) =>
      annotation.pageIndex === pageIndex &&
      annotation.rects.some((rect) =>
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
      )
    );
  }

  return undefined;
}

function findAnnotationForSelection(selection: PendingSelection, annotations: Annotation[]) {
  const samePageAnnotations = annotations.filter((annotation) => annotation.pageIndex === selection.pageIndex);
  return samePageAnnotations.find((annotation) =>
    annotation.rects.some((annotationRect) =>
      selection.rects.some((selectionRect) => rectsOverlap(annotationRect, selectionRect))
    )
  );
}

function getSelectionMenuPosition(container: HTMLElement | null) {
  if (!container) {
    return undefined;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return undefined;
  }

  const rects = Array.from(selection.getRangeAt(0).getClientRects()).filter((rect) => rect.width > 2 && rect.height > 2);
  const containerRect = container.getBoundingClientRect();
  const usableRects = rects.filter((rect) =>
    rect.right >= containerRect.left &&
    rect.left <= containerRect.right &&
    rect.bottom >= containerRect.top &&
    rect.top <= containerRect.bottom
  );
  const firstRect = usableRects[0];
  if (!firstRect) {
    return undefined;
  }

  return {
    x: Math.min(window.innerWidth - 280, Math.max(12, firstRect.left + firstRect.width / 2 - 120)),
    y: Math.min(window.innerHeight - 160, Math.max(12, firstRect.bottom + 8))
  };
}

function rectsOverlap(a: Annotation["rects"][number], b: Annotation["rects"][number]) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > left && bottom > top;
}

function readCurrentSelection(container: HTMLElement | null): PendingSelection | undefined {
  if (!container) {
    return undefined;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return undefined;
  }

  const quote = selection.toString().trim();
  if (!quote) {
    return undefined;
  }

  const range = selection.getRangeAt(0);
  const clientRects = Array.from(range.getClientRects()).filter((rect) => rect.width > 2 && rect.height > 2);
  const pages = Array.from(container.querySelectorAll<HTMLElement>("[data-page-index]"));
  const grouped = new Map<number, Annotation["rects"]>();

  for (const rect of clientRects) {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const page = pages.find((pageElement) => {
      const pageRect = pageElement.getBoundingClientRect();
      return centerX >= pageRect.left && centerX <= pageRect.right && centerY >= pageRect.top && centerY <= pageRect.bottom;
    });

    if (!page) {
      continue;
    }

    const pageIndex = Number(page.dataset.pageIndex);
    const pageRect = page.getBoundingClientRect();
    const normalized = normalizeRect(rect, pageRect);
    grouped.set(pageIndex, [...(grouped.get(pageIndex) ?? []), normalized]);
  }

  const firstPage = [...grouped.entries()][0];
  if (!firstPage) {
    return undefined;
  }

  return {
    pageIndex: firstPage[0],
    rects: mergeNearbyRects(firstPage[1]),
    quote
  };
}
