import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Document, Page, pdfjs } from "react-pdf";
import { Languages, MessageSquare, StickyNote, Trash2, X } from "lucide-react";
import type { Annotation, FileAsset, Paper } from "@lumora/shared";
import { clamp01, mergeNearbyRects, normalizeRect } from "@lumora/shared";
import { createId } from "../lib/id";
import { findInPageTextLayer, type PdfSearchMatch } from "../lib/pdfSearch";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

type PendingSelection = {
  pageIndex: number;
  rects: Annotation["rects"];
  quote: string;
};

type YoudaoTranslation = {
  query: string;
  phonetic?: string;
  explains: string[];
  pageUrl: string;
};

type TranslationState =
  | { status: "loading"; query: string }
  | { status: "ready"; query: string; result: YoudaoTranslation }
  | { status: "error"; query: string; error: string };

type NewAnnotationContextMenu = {
  kind: "new";
  x: number;
  y: number;
  selection: PendingSelection;
  mode: "actions" | "note" | "translate";
  noteText: string;
  translation?: TranslationState;
};

type ExistingAnnotationContextMenu = {
  kind: "existing";
  x: number;
  y: number;
  annotation: Annotation;
  mode: "actions" | "note" | "viewNote" | "translate";
  noteText: string;
  selectionBased?: boolean;
  translation?: TranslationState;
};

type AnnotationContextMenu = NewAnnotationContextMenu | ExistingAnnotationContextMenu;

export type PdfSearchState = {
  totalMatches: number;
  activeMatchIndex: number;
};

type PdfReaderProps = {
  paper?: Paper;
  fileAsset?: FileAsset;
  fileData?: Uint8Array;
  annotations: Annotation[];
  active?: boolean;
  viewState?: PdfReaderViewState;
  onViewStateChange?: (viewState: PdfReaderViewState) => void;
  onCreateAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  pdfSearchQuery?: string;
  onPdfSearchUpdate?: (state: PdfSearchState) => void;
};

type WebKitGestureEvent = Event & {
  scale: number;
};

export type PdfReaderViewState = {
  scrollTop: number;
  zoom?: number;
};

const colors = ["#ffe45c", "#8ee6a8", "#82cfff", "#ffadad"];
const pdfViewEvent = "lumora-pdf-view-command";
const minZoom = 0.5;
const maxZoom = 3;

function PdfReaderComponent({
  paper,
  fileAsset,
  fileData,
  annotations,
  active = true,
  viewState,
  onViewStateChange,
  onCreateAnnotation,
  onDeleteAnnotation,
  pdfSearchQuery,
  onPdfSearchUpdate
}: PdfReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageJumpInputRef = useRef<HTMLInputElement>(null);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pendingScrollRestoreRef = useRef<number | undefined>(undefined);
  const restoringScrollRef = useRef(false);
  const gestureStartZoomRef = useRef(1);
  const [numPages, setNumPages] = useState(0);
  const [pageWidth, setPageWidth] = useState(760);
  const [zoom, setZoom] = useState(viewState?.zoom ?? 1);
  const zoomRef = useRef(zoom);
  const [hasExplicitZoom, setHasExplicitZoom] = useState(viewState?.zoom !== undefined);
  const [color, setColor] = useState(colors[0]);
  const [contextMenu, setContextMenu] = useState<AnnotationContextMenu>();
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("");
  const [loadError, setLoadError] = useState<string>();
  const [findMatches, setFindMatches] = useState<PdfSearchMatch[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const findMatchesRef = useRef<PdfSearchMatch[]>([]);
  const pagesRenderedRef = useRef(new Set<number>());
  const pendingSearchRef = useRef<string | null>(null);
  const documentFile = useMemo(() => (fileData ? { data: fileData.slice() } : undefined), [fileData]);

  const visibleAnnotations = useMemo(
    () => annotations.filter((annotation) =>
      !annotation.deletedAt
      && (!annotation.sourceSha256 || annotation.sourceSha256 === fileAsset?.sha256)
    ),
    [annotations, fileAsset?.sha256]
  );

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const resize = () => {
      setPageWidth(Math.max(420, element.clientWidth - 56));
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fileData, paper?.id]);

  useEffect(() => {
    if (!active) {
      return;
    }

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
  }, [active, contextMenu]);

  useEffect(() => {
    setContextMenu(undefined);
    setNumPages(0);
    setLoadError(undefined);
    setPageJumpOpen(false);
    setPageJumpValue("");
    pendingScrollRestoreRef.current = viewState?.scrollTop ?? 0;
    restoringScrollRef.current = true;
    setHasExplicitZoom(viewState?.zoom !== undefined);
    setZoom(viewState?.zoom ?? 1);
  }, [fileData, paper?.id]);

  useEffect(() => {
    zoomRef.current = zoom;
    onViewStateChange?.({
      scrollTop: restoringScrollRef.current
        ? pendingScrollRestoreRef.current ?? viewState?.scrollTop ?? 0
        : scrollRef.current?.scrollTop ?? viewState?.scrollTop ?? 0,
      zoom: hasExplicitZoom ? zoom : undefined
    });
  }, [hasExplicitZoom, zoom]);

  useEffect(() => {
    if (!fileData || numPages === 0) {
      return;
    }

    pendingScrollRestoreRef.current = viewState?.scrollTop ?? 0;
    restoringScrollRef.current = true;
    const frame = restorePendingScroll();

    return () => cancelAnimationFrame(frame);
  }, [fileData, numPages, paper?.id]);

  useEffect(() => {
    pageRefs.current = pageRefs.current.slice(0, numPages);
    pagesRenderedRef.current.clear();
  }, [numPages]);

  useEffect(() => {
    if (!active) {
      return;
    }

    if (!pageJumpOpen) {
      return;
    }

    requestAnimationFrame(() => {
      pageJumpInputRef.current?.focus();
      pageJumpInputRef.current?.select();
    });
  }, [active, pageJumpOpen]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const isApplePlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
      const usesPrimaryModifier = isApplePlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const isPageJumpShortcut = event.key.toLowerCase() === "g"
        && usesPrimaryModifier
        && !event.altKey
        && !event.shiftKey;
      // On macOS this keydown never arrives: WKWebView claims text-editing key
      // equivalents (Cmd+Z, Cmd+;, ...) before the DOM, so Fit Width is
      // intercepted by a native NSEvent monitor in src-tauri/src/lib.rs instead.
      // This branch covers Ctrl+; on the other platforms.
      const isFitWidthShortcut = (event.key === ";" || event.code === "Semicolon")
        && usesPrimaryModifier
        && !event.altKey
        && !event.shiftKey;

      // Cmd+F / Ctrl+F — focus the global search bar which, on a paper tab,
      // acts as the find-in-document bar. On macOS WKWebView may intercept
      // Cmd+F for its own find bar before it reaches the DOM; the shortcut
      // still works on other platforms.
      const isFindShortcut = event.key.toLowerCase() === "f"
        && usesPrimaryModifier
        && !event.altKey
        && !event.shiftKey;

      if (isFindShortcut) {
        event.preventDefault();
        // Focus the app-toolbar search/find input so the user can start typing.
        const toolbarInput = document.querySelector<HTMLInputElement>(".app-toolbar input[type='text']");
        toolbarInput?.focus();
        toolbarInput?.select();
        return;
      }

      if ((!isPageJumpShortcut && !isFitWidthShortcut) || isEditableShortcutTarget(event.target)) {
        return;
      }

      event.preventDefault();
      if (isFitWidthShortcut) {
        handleFitWidth();
      } else {
        handlePromptPageJump();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, numPages]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartZoomRef.current = zoomRef.current;
    };
    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      const scale = (event as WebKitGestureEvent).scale;
      if (!Number.isFinite(scale)) {
        return;
      }

      setHasExplicitZoom(true);
      setZoom(clamp(gestureStartZoomRef.current * scale, minZoom, maxZoom));
    };

    const handleWheelZoom = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();
      const scale = Math.exp(-event.deltaY * 0.002);
      setHasExplicitZoom(true);
      setZoom((current) => clamp(current * scale, minZoom, maxZoom));
    };

    element.addEventListener("gesturestart", handleGestureStart);
    element.addEventListener("gesturechange", handleGestureChange);
    // React attaches `onWheel` as a passive listener, which silently ignores
    // preventDefault(); registering natively with {passive: false} is required
    // to stop the browser's own ctrl+wheel zoom.
    element.addEventListener("wheel", handleWheelZoom, { passive: false });
    return () => {
      element.removeEventListener("gesturestart", handleGestureStart);
      element.removeEventListener("gesturechange", handleGestureChange);
      element.removeEventListener("wheel", handleWheelZoom);
    };
  }, [active]);

  useEffect(() => {
    if (!active) {
      return;
    }

    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<string>(pdfViewEvent, (event) => {
      const command = event.payload;
      if (command === "fit-width") {
        handleFitWidth();
        return;
      }

      if (command === "go-to-page") {
        handlePromptPageJump();
        return;
      }

      if (command.startsWith("zoom:")) {
        const nextZoom = Number.parseFloat(command.slice("zoom:".length));
        if (Number.isFinite(nextZoom)) {
          setHasExplicitZoom(true);
          setZoom(nextZoom);
        }
      }
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active, numPages]);

  // PDF text search: walks every rendered page's text layer and collects
  // match positions as normalised rects. Delegates the initial search after
  // PDF load to onRenderSuccess so it never runs before text layers exist
  // in the DOM; subsequent queries (re-typing) run immediately.
  function runSearch(query: string) {
    const lowerQuery = query.toLowerCase();
    const allMatches: PdfSearchMatch[] = [];
    for (let i = 0; i < numPages; i += 1) {
      const pageEl = pageRefs.current[i];
      if (!pageEl) continue;
      const pageMatches = findInPageTextLayer(pageEl, i, lowerQuery);
      allMatches.push(...pageMatches);
    }

    setFindMatches(allMatches);
    findMatchesRef.current = allMatches;
    const activeIdx = allMatches.length > 0 ? 0 : -1;
    setActiveMatchIndex(activeIdx);
    onPdfSearchUpdate?.({ totalMatches: allMatches.length, activeMatchIndex: activeIdx });

    if (allMatches.length > 0) {
      scrollToFindMatch(allMatches[0]);
    }
  }

  useEffect(() => {
    const query = pdfSearchQuery?.trim();
    if (!query || !active) {
      setFindMatches([]);
      setActiveMatchIndex(-1);
      findMatchesRef.current = [];
      onPdfSearchUpdate?.({ totalMatches: 0, activeMatchIndex: -1 });
      pendingSearchRef.current = null;
      return undefined;
    }

    // PDF hasn't loaded yet — defer the search until pages are rendered.
    if (numPages === 0) {
      pendingSearchRef.current = query;
      return undefined;
    }

    // If all pages have already rendered (subsequent queries after the
    // initial load), search immediately.  Otherwise store the query and
    // let onRenderSuccess trigger it.
    if (pagesRenderedRef.current.size === numPages) {
      runSearch(query);
    } else {
      pendingSearchRef.current = query;
    }
  }, [pdfSearchQuery, numPages, active, onPdfSearchUpdate]);

  function scrollToFindMatch(match: PdfSearchMatch) {
    const pageEl = pageRefs.current[match.pageIndex];
    if (!pageEl) return;
    pageEl.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function goToNextFindMatch() {
    const matches = findMatchesRef.current;
    if (matches.length === 0) return;
    const next = activeMatchIndex < 0 || activeMatchIndex >= matches.length - 1 ? 0 : activeMatchIndex + 1;
    setActiveMatchIndex(next);
    onPdfSearchUpdate?.({ totalMatches: matches.length, activeMatchIndex: next });
    scrollToFindMatch(matches[next]);
  }

  function goToPrevFindMatch() {
    const matches = findMatchesRef.current;
    if (matches.length === 0) return;
    const prev = activeMatchIndex <= 0 ? matches.length - 1 : activeMatchIndex - 1;
    setActiveMatchIndex(prev);
    onPdfSearchUpdate?.({ totalMatches: matches.length, activeMatchIndex: prev });
    scrollToFindMatch(matches[prev]);
  }

  // Expose the navigation functions so App.tsx (via the toolbar) can drive them.
  // We update the refs on every render so the parent always sees the latest.
  const navRef = useRef({ goToNextFindMatch, goToPrevFindMatch });
  navRef.current = { goToNextFindMatch, goToPrevFindMatch };

  // Store nav in a DOM data attribute so the parent can retrieve it imperatively
  // without threading callbacks through the memo comparison.
  const readerBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = readerBodyRef.current;
    if (!el) return;
    (el as HTMLDivElement & { __pdfSearchNav?: typeof navRef.current }).__pdfSearchNav = navRef.current;
  });

  function handleContextMenu(event: React.MouseEvent) {
    if (!active) {
      return;
    }

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
    if (!active) {
      return;
    }

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
      sourceSha256: fileAsset.sha256,
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
      notePosition: undefined,
      updatedAt: new Date().toISOString()
    });
    window.getSelection()?.removeAllRanges();
    setContextMenu(undefined);
  }

  function handleFitWidth() {
    setHasExplicitZoom(false);
    setZoom(1);
  }

  function handlePromptPageJump() {
    if (numPages === 0) {
      return;
    }

    setContextMenu(undefined);
    setPageJumpValue("");
    setPageJumpOpen(true);
  }

  function handleSubmitPageJump(event: { preventDefault: () => void }) {
    event.preventDefault();
    handleJumpToPage(pageJumpValue);
    setPageJumpOpen(false);
  }

  function handleJumpToPage(pageValue: string | number) {
    const nextPage = typeof pageValue === "number" ? pageValue : Number.parseInt(pageValue, 10);
    if (!Number.isFinite(nextPage) || numPages === 0) {
      return;
    }

    const clampedPage = Math.min(Math.max(nextPage, 1), numPages);
    pageRefs.current[clampedPage - 1]?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function handleReaderScroll() {
    if (restoringScrollRef.current) {
      return;
    }

    onViewStateChange?.({
      scrollTop: scrollRef.current?.scrollTop ?? 0,
      zoom: hasExplicitZoom ? zoom : undefined
    });
  }

  function restorePendingScroll() {
    if (!restoringScrollRef.current && pendingScrollRestoreRef.current === undefined) {
      return 0;
    }

    return requestAnimationFrame(() => {
      const scrollTop = pendingScrollRestoreRef.current ?? 0;
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollTop;
      }

      requestAnimationFrame(() => {
        const nextScrollTop = pendingScrollRestoreRef.current ?? scrollTop;
        if (scrollRef.current) {
          scrollRef.current.scrollTop = nextScrollTop;
        }
        pendingScrollRestoreRef.current = undefined;
        restoringScrollRef.current = false;
      });
    });
  }

  async function handleTranslate(quote: string) {
    const query = normalizeDictionaryQuery(quote);
    if (!query) {
      return;
    }

    setContextMenu((current) => current ? {
      ...current,
      mode: "translate",
      translation: { status: "loading", query }
    } : current);

    try {
      const result = await invoke<YoudaoTranslation>("translate_with_youdao", { query });
      setContextMenu((current) => current?.translation?.query === query ? {
        ...current,
        mode: "translate",
        translation: { status: "ready", query, result }
      } : current);
    } catch (error) {
      setContextMenu((current) => current?.translation?.query === query ? {
        ...current,
        mode: "translate",
        translation: { status: "error", query, error: error instanceof Error ? error.message : String(error) }
      } : current);
    }
  }

  async function handleOpenDictionaryPage(url: string) {
    try {
      await invoke("open_external_url", { url });
    } catch (error) {
      window.open(url, "_blank", "noopener,noreferrer");
      console.error("Failed to open Youdao page through Tauri command.", error);
    }
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
      <div className="reader-body" ref={readerBodyRef}>
        <div
          ref={scrollRef}
          className="pdf-scroll"
          onContextMenu={handleContextMenu}
          onPointerUp={handleSelectionPointerUp}
          onScroll={handleReaderScroll}
        >
          <Document
            file={documentFile}
            loading={<div className="pdf-status">Loading PDF...</div>}
            error={<div className="pdf-status">Failed to load PDF.{loadError ? <span>{loadError}</span> : null}</div>}
            onLoadSuccess={({ numPages: nextNumPages }) => setNumPages(nextNumPages)}
            onLoadError={(error) => setLoadError(error.message)}
          >
            {Array.from({ length: numPages }, (_, index) => (
              <div
                className="page-shell"
                data-page-index={index}
                key={index}
                ref={(element) => {
                  pageRefs.current[index] = element;
                }}
              >
                <Page
                  pageNumber={index + 1}
                  width={pageWidth * zoom}
                  renderAnnotationLayer
                  renderTextLayer
                  onRenderSuccess={() => {
                    restorePendingScroll();
                    pagesRenderedRef.current.add(index);
                    const pending = pendingSearchRef.current;
                    if (pending && pagesRenderedRef.current.size === numPages && active) {
                      pendingSearchRef.current = null;
                      runSearch(pending);
                    }
                  }}
                />
                <AnnotationOverlay
                  annotations={visibleAnnotations.filter((annotation) => annotation.pageIndex === index)}
                  onMoveAnnotation={(annotation, position) => onCreateAnnotation(moveNoteMarker(annotation, position))}
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
                {findMatches
                  .filter((match) => match.pageIndex === index)
                  .map((match) => (
                    <span
                      key={match.key}
                      className={
                        match === findMatches[activeMatchIndex]
                          ? "search-highlight-rect active"
                          : "search-highlight-rect"
                      }
                      aria-hidden
                      style={{
                        left: `${match.rect.x * 100}%`,
                        top: `${match.rect.y * 100}%`,
                        width: `${match.rect.width * 100}%`,
                        height: `${match.rect.height * 100}%`
                      }}
                    />
                  ))}
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
            onTranslate={handleTranslate}
            onOpenDictionaryPage={handleOpenDictionaryPage}
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
        {pageJumpOpen && (
          <div className="page-jump-popover" role="dialog" aria-modal="true" aria-label="Go to page">
            <form onSubmit={handleSubmitPageJump}>
              <label htmlFor="page-jump-input">Go to page</label>
              <div>
                <input
                  ref={pageJumpInputRef}
                  id="page-jump-input"
                  type="number"
                  min={1}
                  max={numPages}
                  value={pageJumpValue}
                  placeholder={`1-${numPages}`}
                  onChange={(event) => setPageJumpValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setPageJumpOpen(false);
                    }
                  }}
                />
                <button type="submit">Go</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}

export const PdfReader = memo(PdfReaderComponent, arePdfReaderPropsEqual);

function arePdfReaderPropsEqual(previous: PdfReaderProps, next: PdfReaderProps) {
  return previous.paper?.id === next.paper?.id
    && previous.paper?.title === next.paper?.title
    && previous.fileAsset?.id === next.fileAsset?.id
    && previous.fileData === next.fileData
    && previous.active === next.active
    && previous.viewState?.scrollTop === next.viewState?.scrollTop
    && previous.viewState?.zoom === next.viewState?.zoom
    && previous.pdfSearchQuery === next.pdfSearchQuery
    && annotationsEqual(previous.annotations, next.annotations);
}

function annotationsEqual(previous: Annotation[], next: Annotation[]) {
  if (previous === next) {
    return true;
  }

  if (previous.length !== next.length) {
    return false;
  }

  return previous.every((annotation, index) => {
    const nextAnnotation = next[index];
    return annotation.id === nextAnnotation.id
      && annotation.updatedAt === nextAnnotation.updatedAt
      && annotation.deletedAt === nextAnnotation.deletedAt
      && annotation.kind === nextAnnotation.kind
      && annotation.color === nextAnnotation.color
      && annotation.comment === nextAnnotation.comment
      && annotation.pageIndex === nextAnnotation.pageIndex
      && annotation.rects === nextAnnotation.rects
      && annotation.notePosition === nextAnnotation.notePosition;
  });
}

function AnnotationOverlay({
  annotations,
  onMoveAnnotation,
  onOpenAnnotationMenu
}: {
  annotations: Annotation[];
  onMoveAnnotation: (annotation: Annotation, position: NonNullable<Annotation["notePosition"]>) => void;
  onOpenAnnotationMenu: (annotation: Annotation, event: React.MouseEvent) => void;
}) {
  const [openNoteId, setOpenNoteId] = useState<string>();
  const markerDragRef = useRef<{
    annotation: Annotation;
    pointerId: number;
    startX: number;
    startY: number;
    startMarkerX: number;
    startMarkerY: number;
    pageWidth: number;
    pageHeight: number;
    dragging: boolean;
  } | undefined>(undefined);
  const suppressClickRef = useRef<string | undefined>(undefined);
  const openNote = annotations.find((annotation) => annotation.id === openNoteId && annotation.kind === "note");
  const openNotePosition = openNote ? getNoteMarkerPosition(openNote) : undefined;

  function handleMarkerPointerDown(annotation: Annotation, event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }

    const markerPosition = getNoteMarkerPosition(annotation);
    const pageRect = event.currentTarget.closest<HTMLElement>(".annotation-overlay")?.getBoundingClientRect();
    if (!markerPosition || !pageRect) {
      return;
    }

    event.stopPropagation();
    markerDragRef.current = {
      annotation,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startMarkerX: markerPosition.x,
      startMarkerY: markerPosition.y,
      pageWidth: pageRect.width,
      pageHeight: pageRect.height,
      dragging: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleMarkerPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = markerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && distance < 4) {
      return;
    }

    drag.dragging = true;
    event.preventDefault();
    onMoveAnnotation(drag.annotation, {
      x: drag.startMarkerX + (event.clientX - drag.startX) / drag.pageWidth,
      y: drag.startMarkerY + (event.clientY - drag.startY) / drag.pageHeight
    });
  }

  function handleMarkerPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = markerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (drag.dragging) {
      suppressClickRef.current = drag.annotation.id;
      event.preventDefault();
      setOpenNoteId(drag.annotation.id);
    }

    markerDragRef.current = undefined;
  }

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
        const markerPosition = getNoteMarkerPosition(annotation);
        if (!markerPosition) {
          return null;
        }

        return (
          <button
            type="button"
            className={openNoteId === annotation.id ? "note-marker active" : "note-marker"}
            key={`${annotation.id}-marker`}
            style={{
              left: `${markerPosition.x * 100}%`,
              top: `${markerPosition.y * 100}%`
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (suppressClickRef.current === annotation.id) {
                suppressClickRef.current = undefined;
                return;
              }

              setOpenNoteId((current) => current === annotation.id ? undefined : annotation.id);
            }}
            onPointerDown={(event) => handleMarkerPointerDown(annotation, event)}
            onPointerMove={handleMarkerPointerMove}
            onPointerUp={handleMarkerPointerUp}
            onPointerCancel={handleMarkerPointerUp}
            onContextMenu={(event) => onOpenAnnotationMenu(annotation, event)}
            aria-label="Show note"
            title="Drag to move note"
          >
            <MessageSquare size={12} />
          </button>
        );
      })}
      {openNote && openNotePosition && (
        <aside
          className="note-popover"
          style={{
            left: `${Math.min(0.84, openNotePosition.x) * 100}%`,
            top: `${Math.min(0.92, openNotePosition.y + 0.035) * 100}%`
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

function getNoteMarkerPosition(annotation: Annotation): Annotation["notePosition"] {
  const firstRect = annotation.rects[0];
  if (!firstRect) {
    return annotation.notePosition;
  }

  return annotation.notePosition ?? {
    x: Math.min(0.965, firstRect.x + firstRect.width),
    y: Math.max(0.01, firstRect.y)
  };
}

function moveNoteMarker(annotation: Annotation, position: NonNullable<Annotation["notePosition"]>): Annotation {
  return {
    ...annotation,
    notePosition: {
      x: clamp01(position.x),
      y: clamp01(position.y)
    },
    updatedAt: new Date().toISOString()
  };
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
  onTranslate,
  onOpenDictionaryPage,
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
  onTranslate: (quote: string) => void;
  onOpenDictionaryPage: (url: string) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  onDeleteNote: (annotation: Annotation) => void;
  onSaveNote: (noteText: string) => void;
}) {
  const title = getContextMenuTitle(menu);
  const quote = menu.kind === "new" ? menu.selection.quote : menu.annotation.quote;
  const compact = menu.mode !== "note" && menu.mode !== "translate" && (menu.kind === "new" || Boolean(menu.selectionBased));

  return (
    <div
      className={compact ? "pdf-context-menu compact" : "pdf-context-menu"}
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
      aria-label="Annotation actions"
    >
      {!compact && (
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
      )}
      {!compact && quote && <p>{quote}</p>}
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

      {menu.mode === "translate" ? (
        <TranslationView translation={menu.translation} onOpenPage={onOpenDictionaryPage} />
      ) : menu.mode === "note" ? (
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
          {quote && (
            <button type="button" onClick={() => onTranslate(quote)} aria-label="Translate" title="Translate">
              <Languages size={16} />
            </button>
          )}
          <button type="button" className="danger text-action" onClick={() => onDeleteNote(menu.annotation)}>
            <Trash2 size={16} />
            Delete Note
          </button>
        </div>
      ) : menu.mode === "viewNote" && menu.kind === "existing" ? (
        <div className="context-note-view">
          <blockquote>{menu.annotation.comment || "No note content."}</blockquote>
          {quote && (
            <button type="button" onClick={() => onTranslate(quote)} aria-label="Translate" title="Translate">
              <Languages size={16} />
            </button>
          )}
          <button type="button" className="danger" onClick={() => onDeleteAnnotation(menu.annotation)}>
            <Trash2 size={16} />
            Delete Annotation
          </button>
        </div>
      ) : menu.kind === "existing" ? (
        <div className="button-row vertical">
          {quote && (
            <button type="button" onClick={() => onTranslate(quote)} aria-label="Translate" title="Translate">
              <Languages size={16} />
            </button>
          )}
          {menu.annotation.kind === "note" ? (
            <button type="button" onClick={onShowNote}>
              <MessageSquare size={16} />
              Show Note
            </button>
          ) : (
            <button type="button" onClick={onStartNote}>
              <MessageSquare size={16} />
              {menu.selectionBased ? "Note" : "Add Note"}
            </button>
          )}
          <button type="button" className="danger" onClick={() => onDeleteAnnotation(menu.annotation)}>
            <Trash2 size={16} />
            {menu.selectionBased ? "Delete Highlight" : "Delete Annotation"}
          </button>
        </div>
      ) : (
        <div className="button-row">
          <button type="button" onClick={() => onTranslate(menu.selection.quote)} aria-label="Translate" title="Translate">
            <Languages size={16} />
          </button>
          <button type="button" onClick={onHighlight} aria-label="Highlight" title="Highlight">
            <StickyNote size={16} />
          </button>
          <button type="button" onClick={onStartNote} aria-label="Note" title="Note">
            <MessageSquare size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function TranslationView({
  translation,
  onOpenPage
}: {
  translation?: TranslationState;
  onOpenPage: (url: string) => void;
}) {
  if (!translation || translation.status === "loading") {
    return <div className="context-translation muted">Translating...</div>;
  }

  if (translation.status === "error") {
    return <div className="context-translation error">{translation.error || "Translation failed."}</div>;
  }

  return (
    <div className="context-translation">
      <strong>{translation.result.query}</strong>
      {translation.result.phonetic && <span>/{translation.result.phonetic}/</span>}
      {translation.result.explains.length > 0 ? (
        <ul>
          {translation.result.explains.map((explain) => (
            <li key={explain}>{explain}</li>
          ))}
        </ul>
      ) : (
        <p>No translation found.</p>
      )}
      <button type="button" className="youdao-link-button" onClick={() => onOpenPage(translation.result.pageUrl)}>
        Open in Youdao
      </button>
    </div>
  );
}

function normalizeDictionaryQuery(quote: string) {
  return quote.trim().replace(/\s+/g, " ").slice(0, 200);
}

function getContextMenuTitle(menu: AnnotationContextMenu) {
  if (menu.kind === "new") {
    return menu.mode === "note" ? "Add note" : "Annotate selection";
  }

  if (menu.selectionBased && menu.annotation.kind === "note") {
    return "Note";
  }

  if (menu.selectionBased) {
    return "Highlight";
  }

  if (menu.mode === "note") {
    return "Add note to highlight";
  }

  if (menu.mode === "translate") {
    return "Translation";
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
  const overlappingAnnotations = samePageAnnotations.filter((annotation) =>
    annotation.rects.some((annotationRect) =>
      selection.rects.some((selectionRect) => rectsOverlap(annotationRect, selectionRect))
    )
  );
  return overlappingAnnotations.find((annotation) => annotation.kind === "note") ?? overlappingAnnotations[0];
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

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
