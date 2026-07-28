import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Document, Page, pdfjs } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Languages, MessageSquare, StickyNote, Trash2, X } from "lucide-react";
import type { Annotation, FileAsset, Paper } from "@lumora/shared";
import { clamp01, mergeNearbyRects, normalizeRect } from "@lumora/shared";
import { NativePdfLinkLayer } from "./NativePdfLinkLayer";
import { NativePdfPage } from "./NativePdfPage";
import { NativePdfTextLayer } from "./NativePdfTextLayer";
import { createId } from "../lib/id";
import {
  openNativePdfDocument,
  openNativePdfPath,
  findInNativePdfText,
  shouldUseNativePdfRenderer,
  type NativePdfDocumentInfo
} from "../lib/nativePdfRenderer";
import {
  findInPageTextLayer,
  findInPdfText,
  nextPdfSearchMatchIndex,
  previousPdfSearchMatchIndex,
  type PdfSearchMatch,
  type PdfSearchTarget
} from "../lib/pdfSearch";
import {
  buildPdfPageMetrics,
  defaultPdfPageAspectRatio,
  findPdfPageRange,
  listMountedPdfPageIndexes,
  pageOffset,
  type PdfPageRange
} from "../lib/pdfVirtualization";
import {
  detectPdfRenderPolicy,
  detectPdfRenderPolicyWithGraphics,
  resolvePdfDevicePixelRatio,
  type PdfRenderPolicy
} from "../lib/pdfRenderPolicy";
import { getStoredPdfMetadata, readPdfFromDisk } from "../lib/fileStorage";
import { createLocalPdfRangeTransport, localPdfRangeChunkSize } from "../lib/pdfRangeTransport";
import { resolvePdfExitViewState, type PdfViewState } from "../lib/pdfViewState";
import { externalWebUrlFromTarget } from "../lib/externalWebLinks";
import { resolvePdfDestinationOffset } from "../lib/pdfDestination";
import { PdfLinkReturnController } from "../lib/pdfLinkReturn";
import { isLegacyWebKit } from "../lib/webkitPolyfills";
import { browserPrepareAppExitEvent } from "../lib/appExit";
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

/** Find-in-document navigation, registered by the active reader so the app
 * toolbar can drive next/previous from outside the component tree. */
export type PdfSearchNavHandle = {
  goToNextFindMatch: () => void;
  goToPrevFindMatch: () => void;
};

type PdfReaderProps = {
  paper?: Paper;
  fileAsset?: FileAsset;
  fileData?: Uint8Array;
  fileStorageDirectory?: string;
  annotations: Annotation[];
  active?: boolean;
  viewState?: PdfReaderViewState;
  onViewStateChange?: (viewState: PdfReaderViewState) => void;
  onCreateAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  pdfSearchQuery?: string;
  onPdfSearchUpdate?: (state: PdfSearchState) => void;
  /** Stable ref shared by all readers; only the active one registers into it. */
  searchNavRef?: MutableRefObject<PdfSearchNavHandle | null>;
};

type WebKitGestureEvent = Event & {
  scale: number;
};

type NativePdfRendererState =
  | { status: "disabled" | "loading" }
  | { status: "unavailable"; error: string }
  | { status: "ready"; document: NativePdfDocumentInfo };

export type PdfReaderViewState = PdfViewState;

const colors = ["#ffe45c", "#8ee6a8", "#82cfff", "#ffadad"];
const pdfViewEvent = "lumora-pdf-view-command";
const minZoom = 0.5;
const maxZoom = 3;
const zoomCommitDelayMs = 160;
const viewStateCommitDelayMs = 200;
const initialPageRange: PdfPageRange = { start: 0, end: 0 };
let activePdfRenderPolicy = detectPdfRenderPolicy(isLegacyWebKit);
const pdfRenderPolicyReady = detectPdfRenderPolicyWithGraphics(isLegacyWebKit).then((policy) => {
  activePdfRenderPolicy = policy;
  return policy;
});

function PdfReaderComponent({
  paper,
  fileAsset,
  fileData,
  fileStorageDirectory,
  annotations,
  active = true,
  viewState,
  onViewStateChange,
  onCreateAnnotation,
  onDeleteAnnotation,
  pdfSearchQuery,
  onPdfSearchUpdate,
  searchNavRef
}: PdfReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageJumpInputRef = useRef<HTMLInputElement>(null);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pendingScrollRestoreRef = useRef<number | undefined>(undefined);
  const restoringScrollRef = useRef(false);
  const gestureStartZoomRef = useRef(1);
  const pendingZoomRef = useRef<number | undefined>(undefined);
  const zoomCommitTimerRef = useRef<number | undefined>(undefined);
  const pendingViewStateRef = useRef<PdfReaderViewState | undefined>(undefined);
  const viewStateCommitTimerRef = useRef<number | undefined>(undefined);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const [pdfRenderPolicy, setPdfRenderPolicy] = useState<PdfRenderPolicy>(() => activePdfRenderPolicy);
  const nativePdfEnabled = shouldUseNativePdfRenderer(pdfRenderPolicy);
  const storedPdfFileName = fileAsset?.localPath;
  const hasStoredPdfPath = Boolean(fileStorageDirectory && storedPdfFileName);
  const hasNativePdfPath = nativePdfEnabled && hasStoredPdfPath;
  const hasPdfJsRangePath = !nativePdfEnabled && hasStoredPdfPath;
  const [nativeRenderer, setNativeRenderer] = useState<NativePdfRendererState>(() => (
    nativePdfEnabled ? { status: "loading" } : { status: "disabled" }
  ));
  const useNativePageRenderer = nativePdfEnabled;
  const nativePdfSessionId = nativeRenderer.status === "ready" ? nativeRenderer.document.sessionId : undefined;
  const [numPages, setNumPages] = useState(0);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const pdfDocumentRef = useRef<PDFDocumentProxy | undefined>(undefined);
  const [pageWidth, setPageWidth] = useState(760);
  const [viewportHeight, setViewportHeight] = useState(700);
  const [pageAspectRatios, setPageAspectRatios] = useState<Record<number, number>>({});
  const [pageRange, setPageRange] = useState<PdfPageRange>(initialPageRange);
  const [zoom, setZoom] = useState(viewState?.zoom ?? 1);
  const zoomRef = useRef(zoom);
  const [hasExplicitZoom, setHasExplicitZoom] = useState(viewState?.zoom !== undefined);
  const hasExplicitZoomRef = useRef(viewState?.zoom !== undefined);
  const [color, setColor] = useState(colors[0]);
  const [contextMenu, setContextMenu] = useState<AnnotationContextMenu>();
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("");
  const [loadError, setLoadError] = useState<string>();
  const [storedPdfSize, setStoredPdfSize] = useState<number>();
  const [rangeFallbackFileData, setRangeFallbackFileData] = useState<Uint8Array>();
  const [findMatches, setFindMatches] = useState<PdfSearchMatch[]>([]);
  const [searchTargets, setSearchTargets] = useState<PdfSearchTarget[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const searchTargetsRef = useRef<PdfSearchTarget[]>([]);
  const effectiveFileData = fileData ?? rangeFallbackFileData;
  const documentFile = useMemo(
    () => {
      if (useNativePageRenderer) {
        return undefined;
      }
      if (effectiveFileData) {
        return { data: effectiveFileData.slice() };
      }
      if (!hasPdfJsRangePath || !fileStorageDirectory || !storedPdfFileName || !storedPdfSize) {
        return undefined;
      }

      return {
        range: createLocalPdfRangeTransport(pdfjs.PDFDataRangeTransport, {
          directory: fileStorageDirectory,
          fileName: storedPdfFileName,
          size: storedPdfSize
        }, () => {
          // A file can be replaced or moved between metadata and range reads.
          // Fall back to the original full-file path instead of leaving PDF.js
          // waiting forever for a failed custom range request.
          void readPdfFromDisk(fileStorageDirectory, storedPdfFileName)
            .then(setRangeFallbackFileData)
            .catch((reason) => setLoadError(reason instanceof Error ? reason.message : String(reason)));
        })
      };
    },
    [effectiveFileData, fileStorageDirectory, hasPdfJsRangePath, storedPdfFileName, storedPdfSize, useNativePageRenderer]
  );
  const documentOptions = useMemo(() => {
    const usesRangeTransport = Boolean(documentFile && "range" in documentFile);
    return usesRangeTransport ? {
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: localPdfRangeChunkSize
    } : undefined;
  }, [documentFile]);
  const renderedPageWidth = pageWidth * zoom;
  const pageMetrics = useMemo(
    () => buildPdfPageMetrics(numPages, renderedPageWidth, pageAspectRatios),
    [numPages, pageAspectRatios, renderedPageWidth]
  );
  // react-pdf captures Document.onItemClick only on its first render. Keep the
  // callback stable and expose all mutable navigation inputs through refs so
  // internal links never use the initial (document-less) render's closure.
  const pageMetricsRef = useRef(pageMetrics);
  const renderedPageWidthRef = useRef(renderedPageWidth);
  const viewportHeightRef = useRef(viewportHeight);
  const pdfOverscanPagesRef = useRef(pdfRenderPolicy.overscanPages);
  const linkReturnControllerRef = useRef<PdfLinkReturnController | undefined>(undefined);
  if (!linkReturnControllerRef.current) {
    linkReturnControllerRef.current = new PdfLinkReturnController();
  }
  pageMetricsRef.current = pageMetrics;
  renderedPageWidthRef.current = renderedPageWidth;
  viewportHeightRef.current = viewportHeight;
  pdfOverscanPagesRef.current = pdfRenderPolicy.overscanPages;
  const virtualPageIndexes = useMemo(() => {
    // Keep the parsed PDF document warm for fast tab switching, but release
    // hidden canvases, text layers and native page images immediately.
    return listMountedPdfPageIndexes(numPages, pageRange, active);
  }, [active, numPages, pageRange]);

  const visibleAnnotations = useMemo(
    () => annotations.filter((annotation) =>
      !annotation.deletedAt
      && (!annotation.sourceSha256 || annotation.sourceSha256 === fileAsset?.sha256)
    ),
    [annotations, fileAsset?.sha256]
  );

  useEffect(() => {
    let cancelled = false;
    void pdfRenderPolicyReady.then((policy) => {
      if (!cancelled) {
        setPdfRenderPolicy(policy);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasPdfJsRangePath || !fileStorageDirectory || !storedPdfFileName) {
      setStoredPdfSize(undefined);
      setRangeFallbackFileData(undefined);
      return;
    }

    let cancelled = false;
    setStoredPdfSize(undefined);
    setRangeFallbackFileData(undefined);
    void getStoredPdfMetadata(fileStorageDirectory, storedPdfFileName)
      .then((metadata) => {
        if (!cancelled) {
          if (metadata.size <= 0) {
            throw new Error("The stored PDF is empty.");
          }
          setStoredPdfSize(metadata.size);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fileStorageDirectory, hasPdfJsRangePath, storedPdfFileName]);

  useEffect(() => {
    if (!nativePdfEnabled || (!hasNativePdfPath && !fileData)) {
      setNativeRenderer({ status: "disabled" });
      return;
    }

    let cancelled = false;
    setNativeRenderer({ status: "loading" });
    const openDocument = hasNativePdfPath
      ? openNativePdfPath(fileStorageDirectory!, storedPdfFileName!)
      : openNativePdfDocument(fileData!);
    void openDocument.then((document) => {
      if (cancelled) {
        return;
      }
      setNativeRenderer({ status: "ready", document });
      setNumPages(document.pages.length);
      setPageAspectRatios(Object.fromEntries(document.pages.map((page, index) => [
        index,
        page.height / page.width
      ])));
    }).catch((error) => {
      if (!cancelled) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("Native PDF renderer unavailable.", error);
        setNativeRenderer({ status: "unavailable", error: message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fileData, fileStorageDirectory, hasNativePdfPath, nativePdfEnabled, storedPdfFileName, paper?.id]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const resize = () => {
      setPageWidth(Math.max(420, element.clientWidth - 56));
      setViewportHeight(Math.max(1, element.clientHeight));
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fileData, storedPdfFileName, paper?.id]);

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
    linkReturnControllerRef.current!.reset();
    setContextMenu(undefined);
    setNumPages(0);
    pdfDocumentRef.current = undefined;
    setPdfDocument(undefined);
    setPageAspectRatios({});
    setPageRange(initialPageRange);
    setLoadError(undefined);
    setPageJumpOpen(false);
    setPageJumpValue("");
    pendingScrollRestoreRef.current = viewState?.scrollTop ?? 0;
    restoringScrollRef.current = true;
    setHasExplicitZoom(viewState?.zoom !== undefined);
    hasExplicitZoomRef.current = viewState?.zoom !== undefined;
    setZoom(viewState?.zoom ?? 1);
    setFindMatches([]);
    setSearchTargets([]);
    searchTargetsRef.current = [];
    // A pending scroll commit belongs to the previous document; dropping it
    // stops the old position from being written under the new paper's key.
    pendingViewStateRef.current = undefined;
    if (viewStateCommitTimerRef.current !== undefined) {
      window.clearTimeout(viewStateCommitTimerRef.current);
      viewStateCommitTimerRef.current = undefined;
    }
  }, [fileData, fileStorageDirectory, paper?.id, storedPdfFileName]);

  useEffect(() => {
    onViewStateChangeRef.current = onViewStateChange;
  }, [onViewStateChange]);

  useEffect(() => {
    pdfDocumentRef.current = pdfDocument;
  }, [pdfDocument]);

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
    if ((!effectiveFileData && !hasStoredPdfPath) || numPages === 0) {
      return;
    }

    pendingScrollRestoreRef.current = viewState?.scrollTop ?? 0;
    restoringScrollRef.current = true;
    const frame = restorePendingScroll();

    return () => cancelAnimationFrame(frame);
  }, [effectiveFileData, hasStoredPdfPath, numPages, paper?.id]);

  useEffect(() => {
    pageRefs.current = pageRefs.current.slice(0, numPages);
  }, [numPages]);

  useLayoutEffect(() => {
    updatePageRange(scrollRef.current?.scrollTop ?? viewState?.scrollTop ?? 0);
  }, [pageMetrics, pdfRenderPolicy.overscanPages, viewportHeight]);

  useEffect(() => () => {
    // A closed tab can unmount during either debounce window; persist its last
    // scroll position and zoom before releasing the warm PDF reader.
    flushViewStateForExit();
  }, []);

  useEffect(() => {
    const flushForPageExit = () => flushViewStateForExit();
    window.addEventListener("beforeunload", flushForPageExit);
    window.addEventListener("pagehide", flushForPageExit);
    window.addEventListener(browserPrepareAppExitEvent, flushForPageExit);
    return () => {
      window.removeEventListener("beforeunload", flushForPageExit);
      window.removeEventListener("pagehide", flushForPageExit);
      window.removeEventListener(browserPrepareAppExitEvent, flushForPageExit);
    };
  }, []);

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

      scheduleZoom(clamp(gestureStartZoomRef.current * scale, minZoom, maxZoom));
    };
    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
      commitPendingZoom();
    };

    const handleWheelZoom = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();
      const scale = Math.exp(-event.deltaY * 0.002);
      scheduleZoom(clamp((pendingZoomRef.current ?? zoomRef.current) * scale, minZoom, maxZoom));
    };

    element.addEventListener("gesturestart", handleGestureStart);
    element.addEventListener("gesturechange", handleGestureChange);
    element.addEventListener("gestureend", handleGestureEnd);
    // React attaches `onWheel` as a passive listener, which silently ignores
    // preventDefault(); registering natively with {passive: false} is required
    // to stop the browser's own ctrl+wheel zoom.
    element.addEventListener("wheel", handleWheelZoom, { passive: false });
    return () => {
      element.removeEventListener("gesturestart", handleGestureStart);
      element.removeEventListener("gesturechange", handleGestureChange);
      element.removeEventListener("gestureend", handleGestureEnd);
      element.removeEventListener("wheel", handleWheelZoom);
    };
  }, [active, pdfRenderPolicy.debounceZoom]);

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

      if (command === "back-to-link-origin") {
        handleBackToLinkOrigin();
        return;
      }

      if (command.startsWith("zoom:")) {
        const nextZoom = Number.parseFloat(command.slice("zoom:".length));
        if (Number.isFinite(nextZoom)) {
          commitZoom(nextZoom, true);
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

  const refreshVisibleSearchHighlights = useCallback((queryOverride?: string) => {
    const query = queryOverride ?? pdfSearchQuery?.trim();
    if (!query) {
      return;
    }

    const lowerQuery = query.toLowerCase();
    const visibleMatches = virtualPageIndexes.flatMap((pageIndex) => {
      const pageElement = pageRefs.current[pageIndex];
      return pageElement ? findInPageTextLayer(pageElement, pageIndex, lowerQuery) : [];
    });
    setFindMatches((current) => areSearchMatchesEqual(current, visibleMatches) ? current : visibleMatches);
  }, [pdfSearchQuery, virtualPageIndexes]);
  const refreshVisibleSearchHighlightsRef = useRef(refreshVisibleSearchHighlights);
  refreshVisibleSearchHighlightsRef.current = refreshVisibleSearchHighlights;

  // Search the PDF text model so virtualized, unmounted pages remain searchable.
  // DOM ranges are only measured for the small set of pages currently mounted.
  useEffect(() => {
    const query = pdfSearchQuery?.trim();
    if (!query || !active || (!pdfDocument && !nativePdfSessionId)) {
      setFindMatches([]);
      setSearchTargets([]);
      setActiveMatchIndex(-1);
      searchTargetsRef.current = [];
      onPdfSearchUpdate?.({ totalMatches: 0, activeMatchIndex: -1 });
      return undefined;
    }

    let cancelled = false;
    const search = nativePdfSessionId
      ? findInNativePdfText(nativePdfSessionId, query)
      : findInPdfText(pdfDocument!, query, () => cancelled);
    void search.then((targets) => {
      if (cancelled) {
        return;
      }

      setSearchTargets(targets);
      searchTargetsRef.current = targets;
      // Finding and navigating are separate operations. A new query highlights
      // visible matches but does not take scroll ownership from the user.
      setActiveMatchIndex(-1);
      onPdfSearchUpdate?.({ totalMatches: targets.length, activeMatchIndex: -1 });
      requestAnimationFrame(() => refreshVisibleSearchHighlightsRef.current(query));
    }).catch(() => {
      if (cancelled) {
        return;
      }
      setFindMatches([]);
      setSearchTargets([]);
      searchTargetsRef.current = [];
      setActiveMatchIndex(-1);
      onPdfSearchUpdate?.({ totalMatches: 0, activeMatchIndex: -1 });
    });

    return () => {
      cancelled = true;
    };
  }, [pdfDocument, nativePdfSessionId, pdfSearchQuery, active, onPdfSearchUpdate]);

  function goToNextFindMatch() {
    const targets = searchTargetsRef.current;
    if (targets.length === 0) return;
    const next = nextPdfSearchMatchIndex(activeMatchIndex, targets.length);
    setActiveMatchIndex(next);
    onPdfSearchUpdate?.({ totalMatches: targets.length, activeMatchIndex: next });
    scrollToPage(targets[next].pageIndex, "smooth");
  }

  function goToPrevFindMatch() {
    const targets = searchTargetsRef.current;
    if (targets.length === 0) return;
    const prev = previousPdfSearchMatchIndex(activeMatchIndex, targets.length);
    setActiveMatchIndex(prev);
    onPdfSearchUpdate?.({ totalMatches: targets.length, activeMatchIndex: prev });
    scrollToPage(targets[prev].pageIndex, "smooth");
  }

  // Register find navigation with the app toolbar. Only the active reader
  // registers, so the toolbar always drives the tab the user is looking at.
  // The handle delegates through a per-render ref: registration only re-runs
  // when `active` flips, yet always calls the latest closures.
  const findNavRef = useRef({ goToNextFindMatch, goToPrevFindMatch });
  findNavRef.current = { goToNextFindMatch, goToPrevFindMatch };
  useEffect(() => {
    if (!active || !searchNavRef) {
      return undefined;
    }
    const handle: PdfSearchNavHandle = {
      goToNextFindMatch: () => findNavRef.current.goToNextFindMatch(),
      goToPrevFindMatch: () => findNavRef.current.goToPrevFindMatch()
    };
    searchNavRef.current = handle;
    return () => {
      if (searchNavRef.current === handle) {
        searchNavRef.current = null;
      }
    };
  }, [active, searchNavRef]);

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
    commitZoom(1, false);
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
    scrollToPage(clampedPage - 1, "smooth");
  }

  function handleReaderScroll() {
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    updatePageRange(scrollTop);
    if (restoringScrollRef.current) {
      return;
    }

    // Committing per scroll event re-renders the whole app at scroll frequency;
    // the position is only needed for restore, so persist it after the scroll
    // settles. The unmount cleanup flushes mid-debounce tab switches.
    pendingViewStateRef.current = {
      scrollTop,
      zoom: hasExplicitZoom ? zoom : undefined
    };
    if (viewStateCommitTimerRef.current !== undefined) {
      window.clearTimeout(viewStateCommitTimerRef.current);
    }
    viewStateCommitTimerRef.current = window.setTimeout(flushPendingViewState, viewStateCommitDelayMs);
  }

  function flushPendingViewState() {
    if (viewStateCommitTimerRef.current !== undefined) {
      window.clearTimeout(viewStateCommitTimerRef.current);
      viewStateCommitTimerRef.current = undefined;
    }

    const pending = pendingViewStateRef.current;
    if (pending) {
      pendingViewStateRef.current = undefined;
      onViewStateChangeRef.current?.(pending);
    }
  }

  function flushViewStateForExit() {
    if (viewStateCommitTimerRef.current !== undefined) {
      window.clearTimeout(viewStateCommitTimerRef.current);
      viewStateCommitTimerRef.current = undefined;
    }
    if (zoomCommitTimerRef.current !== undefined) {
      window.clearTimeout(zoomCommitTimerRef.current);
      zoomCommitTimerRef.current = undefined;
    }

    const pending = pendingViewStateRef.current;
    pendingViewStateRef.current = undefined;
    const pendingZoom = pendingZoomRef.current;
    pendingZoomRef.current = undefined;
    onViewStateChangeRef.current?.(resolvePdfExitViewState({
      pendingViewState: pending,
      currentScrollTop: scrollRef.current?.scrollTop,
      restoredScrollTop: viewState?.scrollTop,
      pendingZoom,
      currentZoom: zoomRef.current,
      hasExplicitZoom: hasExplicitZoomRef.current
    }));
  }

  function updatePageRange(scrollTop: number) {
    const nextRange = findPdfPageRange(pageMetrics, scrollTop, viewportHeight, pdfRenderPolicy.overscanPages);
    setPageRange((current) => current.start === nextRange.start && current.end === nextRange.end ? current : nextRange);
  }

  function scrollToPage(pageIndex: number, behavior: ScrollBehavior = "auto") {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const top = pageOffset(pageMetrics, pageIndex);
    element.scrollTo({ top, behavior });
    updatePageRange(top);
  }

  function scrollToPdfOffset(top: number, behavior: ScrollBehavior = "auto") {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const metrics = pageMetricsRef.current;
    element.scrollTo({ top, behavior });
    const nextRange = findPdfPageRange(
      metrics,
      top,
      viewportHeightRef.current,
      pdfOverscanPagesRef.current
    );
    setPageRange((current) => current.start === nextRange.start && current.end === nextRange.end
      ? current
      : nextRange
    );
  }

  function handleBackToLinkOrigin() {
    const top = linkReturnControllerRef.current!.consumeReturn();
    if (top === undefined) {
      return;
    }
    scrollToPdfOffset(top, "smooth");
  }

  const handlePdfDestination = useCallback(async (
    pageIndex: number,
    destination: unknown,
    navigationRevision: number
  ) => {
    const document = pdfDocumentRef.current;
    const element = scrollRef.current;
    if (!document || !element) {
      return;
    }

    const metrics = pageMetricsRef.current;
    const pageWidth = renderedPageWidthRef.current;
    let top: number;
    try {
      top = await resolvePdfDestinationOffset(
        document,
        metrics,
        pageWidth,
        pageIndex,
        destination
      );
    } catch (error) {
      console.error("Failed to resolve PDF destination coordinates.", error);
      top = pageOffset(metrics, pageIndex);
    }
    // Ignore a destination that finished resolving after the document changed,
    // a newer internal link was clicked, or the user already returned.
    if (pdfDocumentRef.current !== document
      || scrollRef.current !== element
      || !linkReturnControllerRef.current!.isCurrent(navigationRevision)) {
      return;
    }
    scrollToPdfOffset(top, "smooth");
  }, []);

  const handlePdfItemClick = useCallback(({
    dest,
    pageIndex
  }: {
    dest?: unknown;
    pageIndex: number;
  }) => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const navigationRevision = linkReturnControllerRef.current!.beginLink(element.scrollTop);
    void handlePdfDestination(pageIndex, dest, navigationRevision);
  }, [handlePdfDestination]);

  const handleNativePdfInternalLink = useCallback((pageIndex: number) => {
    const element = scrollRef.current;
    const metrics = pageMetricsRef.current;
    if (!element || pageIndex < 0 || pageIndex >= metrics.heights.length) {
      return;
    }
    linkReturnControllerRef.current!.beginLink(element.scrollTop);
    scrollToPdfOffset(pageOffset(metrics, pageIndex), "smooth");
  }, []);

  function scheduleZoom(nextZoom: number) {
    if (!pdfRenderPolicy.debounceZoom) {
      // zoomRef only syncs post-render; update it now so wheel events landing
      // before the next render compound from the latest value.
      zoomRef.current = clamp(nextZoom, minZoom, maxZoom);
      commitZoom(zoomRef.current, true);
      return;
    }

    pendingZoomRef.current = clamp(nextZoom, minZoom, maxZoom);
    hasExplicitZoomRef.current = true;
    setHasExplicitZoom(true);
    if (zoomCommitTimerRef.current !== undefined) {
      window.clearTimeout(zoomCommitTimerRef.current);
    }
    zoomCommitTimerRef.current = window.setTimeout(commitPendingZoom, zoomCommitDelayMs);
  }

  function commitPendingZoom() {
    if (pendingZoomRef.current === undefined) {
      return;
    }
    commitZoom(pendingZoomRef.current, true);
  }

  function commitZoom(nextZoom: number, explicit: boolean) {
    if (zoomCommitTimerRef.current !== undefined) {
      window.clearTimeout(zoomCommitTimerRef.current);
      zoomCommitTimerRef.current = undefined;
    }
    pendingZoomRef.current = undefined;
    hasExplicitZoomRef.current = explicit;
    setHasExplicitZoom(explicit);
    setZoom(clamp(nextZoom, minZoom, maxZoom));
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
      updatePageRange(scrollTop);

      requestAnimationFrame(() => {
        const nextScrollTop = pendingScrollRestoreRef.current ?? scrollTop;
        if (scrollRef.current) {
          scrollRef.current.scrollTop = nextScrollTop;
        }
        updatePageRange(nextScrollTop);
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

  function handlePdfLinkClick(event: React.MouseEvent<HTMLElement>) {
    const url = externalWebUrlFromTarget(event.target);
    if (!url) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void invoke("open_external_url", { url }).catch((error) => {
      console.error("Failed to open PDF link in the default browser.", error);
    });
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

  if (!fileData && !hasStoredPdfPath) {
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
    <section
      className="reader"
      data-pdf-render-tier={pdfRenderPolicy.tier}
      data-pdf-renderer={nativePdfEnabled ? `native-${nativeRenderer.status}` : "pdfjs"}
      onClickCapture={handlePdfLinkClick}
    >
      <div className="reader-body">
        <div
          ref={scrollRef}
          className="pdf-scroll"
          onContextMenu={handleContextMenu}
          onPointerUp={handleSelectionPointerUp}
          onScroll={handleReaderScroll}
        >
          {nativeRenderer.status === "loading" && (
            <div className="pdf-status">Preparing native PDF renderer...</div>
          )}
          {nativeRenderer.status === "unavailable" && (
            <div className="pdf-status">
              Native PDF renderer is unavailable. Install poppler-utils and restart Lumora.
              <span>{nativeRenderer.error}</span>
            </div>
          )}
          {nativeRenderer.status === "ready" ? (
            <div className="pdf-page-list" style={{ height: pageMetrics.totalHeight }}>
              {virtualPageIndexes.map((index) => (
                <div
                  className="page-shell virtualized"
                  data-page-index={index}
                  key={index}
                  ref={(element) => {
                    pageRefs.current[index] = element;
                  }}
                  style={{
                    top: pageMetrics.offsets[index],
                    minHeight: pageMetrics.heights[index]
                  }}
                >
                  <div
                    className="native-pdf-page-frame"
                    style={{
                      width: renderedPageWidth,
                      height: pageMetrics.heights[index]
                    }}
                  >
                    <NativePdfPage
                      sessionId={nativeRenderer.document.sessionId}
                      pageNumber={index + 1}
                      cssWidth={renderedPageWidth}
                      devicePixelRatio={resolvePdfDevicePixelRatio(
                        window.devicePixelRatio || 1,
                        renderedPageWidth,
                        pageAspectRatios[index] ?? defaultPdfPageAspectRatio,
                        pdfRenderPolicy
                      )}
                      onLoad={restorePendingScroll}
                    />
                  </div>
                  <NativePdfTextLayer
                    sessionId={nativeRenderer.document.sessionId}
                    pageNumber={index + 1}
                    page={nativeRenderer.document.pages[index]}
                    cssHeight={pageMetrics.heights[index]}
                    onReady={refreshVisibleSearchHighlights}
                  />
                  <NativePdfLinkLayer
                    links={nativeRenderer.document.pages[index].links}
                    onInternalLink={handleNativePdfInternalLink}
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
                </div>
              ))}
            </div>
          ) : nativePdfEnabled ? null : documentFile ? (
            <Document
              file={documentFile}
              options={documentOptions}
              onItemClick={handlePdfItemClick}
              loading={<div className="pdf-status">Loading PDF...</div>}
              error={<div className="pdf-status">Failed to load PDF.{loadError ? <span>{loadError}</span> : null}</div>}
              onLoadSuccess={(document) => {
                pdfDocumentRef.current = document;
                setPdfDocument(document);
                setNumPages(document.numPages);
              }}
              onLoadError={(error) => setLoadError(error.message)}
            >
              <div className="pdf-page-list" style={{ height: pageMetrics.totalHeight }}>
                {virtualPageIndexes.map((index) => (
                  <div
                    className="page-shell virtualized"
                    data-page-index={index}
                    key={index}
                    ref={(element) => {
                      pageRefs.current[index] = element;
                    }}
                    style={{
                      top: pageMetrics.offsets[index],
                      minHeight: pageMetrics.heights[index]
                    }}
                  >
                    <Page
                      pageNumber={index + 1}
                      width={renderedPageWidth}
                      devicePixelRatio={resolvePdfDevicePixelRatio(
                      window.devicePixelRatio || 1,
                      renderedPageWidth,
                      pageAspectRatios[index] ?? defaultPdfPageAspectRatio,
                      pdfRenderPolicy
                    )}
                      renderAnnotationLayer
                      renderTextLayer
                      onLoadSuccess={(page) => {
                        const ratio = page.originalHeight / page.originalWidth;
                        if (!Number.isFinite(ratio) || ratio <= 0) {
                          return;
                        }
                        setPageAspectRatios((current) => current[index] === ratio
                          ? current
                          : { ...current, [index]: ratio }
                        );
                      }}
                      onRenderSuccess={restorePendingScroll}
                      onRenderTextLayerSuccess={refreshVisibleSearchHighlights}
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
                      .map((match) => {
                        const activeTarget = searchTargets[activeMatchIndex];
                        const isActive = activeTarget?.pageIndex === match.pageIndex
                          && activeTarget.pageMatchIndex === match.matchIndex;
                        return (
                          <span
                            key={match.key}
                            className={isActive ? "search-highlight-rect active" : "search-highlight-rect"}
                            aria-hidden
                            style={{
                              left: `${(match.rect.x * 100).toFixed(2)}%`,
                              top: `${(match.rect.y * 100).toFixed(2)}%`,
                              width: `${(match.rect.width * 100).toFixed(2)}%`,
                              height: `${(match.rect.height * 100).toFixed(2)}%`
                            }}
                          />
                        );
                      })}
                  </div>
                ))}
              </div>
            </Document>
          ) : (
            <div className="pdf-status">
              {loadError ? <>Failed to prepare PDF.<span>{loadError}</span></> : "Preparing PDF..."}
            </div>
          )}
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
  // viewState is deliberately not compared: the reader only reads it when a
  // document mounts or resets, and its updates originate from this component's
  // own scroll persistence — re-rendering on them would run the whole reader
  // once per debounced scroll commit for no visible change.
  return previous.paper?.id === next.paper?.id
    && previous.paper?.title === next.paper?.title
    && previous.fileAsset?.id === next.fileAsset?.id
    && previous.fileAsset?.localPath === next.fileAsset?.localPath
    && previous.fileAsset?.size === next.fileAsset?.size
    && previous.fileData === next.fileData
    && previous.fileStorageDirectory === next.fileStorageDirectory
    && previous.active === next.active
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
  // Visual position of the marker being dragged. Kept local so a drag never
  // touches the library state (whose every update re-renders the app and
  // enqueues a whole-library diff + SQLite write); the move is committed once
  // on pointer release.
  const [dragPosition, setDragPosition] = useState<{
    annotationId: string;
    x: number;
    y: number;
  }>();
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
    lastPosition?: NonNullable<Annotation["notePosition"]>;
  } | undefined>(undefined);
  const suppressClickRef = useRef<string | undefined>(undefined);
  const notePopoverRef = useRef<HTMLElement>(null);
  const openNote = annotations.find((annotation) => annotation.id === openNoteId && annotation.kind === "note");
  const openNotePosition = openNote
    ? dragPosition?.annotationId === openNote.id ? dragPosition : getNoteMarkerPosition(openNote)
    : undefined;

  // The commit round-trips through the app state; keep showing the local drag
  // position until the updated annotation arrives so the marker never snaps
  // back to its pre-drag spot for a frame.
  useEffect(() => {
    if (dragPosition && !markerDragRef.current) {
      setDragPosition(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations]);

  useEffect(() => {
    if (!openNote) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      // Keep open when clicking inside the popover or on a note marker.
      if (notePopoverRef.current?.contains(event.target)) return;
      if (event.target.closest(".note-marker")) return;
      setOpenNoteId(undefined);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [openNote]);

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
    const position = {
      x: clamp01(drag.startMarkerX + (event.clientX - drag.startX) / drag.pageWidth),
      y: clamp01(drag.startMarkerY + (event.clientY - drag.startY) / drag.pageHeight)
    };
    drag.lastPosition = position;
    setDragPosition({ annotationId: drag.annotation.id, ...position });
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
      if (drag.lastPosition) {
        onMoveAnnotation(drag.annotation, drag.lastPosition);
      }
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
        const markerPosition = dragPosition?.annotationId === annotation.id
          ? dragPosition
          : getNoteMarkerPosition(annotation);
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
          ref={notePopoverRef}
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

// Sub-pixel tolerance for match-rect comparison. WebKitGTK's getClientRects()
// returns values that jitter below the pixel on successive layouts of the same
// text, so exact float equality here would report "changed" every time the text
// layer re-renders, commit a new findMatches, re-render, and never converge — a
// main-thread loop that pins one CPU and explodes the AtomString table (each
// full-precision "left: …%" style string is a brand-new atom). ~0.15% of the
// page (~1px on a 700px page) is finer than any real match move and coarser
// than the jitter, so genuine changes still register while noise is absorbed.
const searchRectEpsilon = 0.0015;

function areSearchMatchesEqual(current: PdfSearchMatch[], next: PdfSearchMatch[]) {
  return current.length === next.length && current.every((match, index) => {
    const nextMatch = next[index];
    return nextMatch !== undefined
      && match.key === nextMatch.key
      && match.matchIndex === nextMatch.matchIndex
      && Math.abs(match.rect.x - nextMatch.rect.x) < searchRectEpsilon
      && Math.abs(match.rect.y - nextMatch.rect.y) < searchRectEpsilon
      && Math.abs(match.rect.width - nextMatch.rect.width) < searchRectEpsilon
      && Math.abs(match.rect.height - nextMatch.rect.height) < searchRectEpsilon;
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
