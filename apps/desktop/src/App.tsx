import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { Annotation, Collection, FileAsset, LibraryState, Paper } from "@lumora/shared";
import { FileText, X } from "lucide-react";
import { AppToolbar } from "./components/AppToolbar";
import { ArxivDownloadToast } from "./components/ArxivDownloadToast";
import { CollectionModal, DeleteCollectionModal, RenameCollectionModal } from "./components/CollectionModal";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { ManualReferenceModal, type ManualReferenceDraft } from "./components/ManualReferenceModal";
import { ShortcutsHelpModal } from "./components/ShortcutsHelpModal";
import { AboutModal } from "./components/AboutModal";
import { NotebookPanel } from "./components/NotebookPanel";
import { PaperList } from "./components/PaperList";
import { PdfReader, type PdfReaderViewState, type PdfSearchNavHandle } from "./components/PdfReader";
import { SyncPanel } from "./components/SyncPanel";
import { SyncSettingsModal } from "./components/SyncSettingsModal";
import { createId } from "./lib/id";
import {
  addPaperToCollection,
  deleteCollectionAndReassignPapers,
  deletePaperFromLibrary,
  getCollectionAndDescendantIds,
  removePaperFromCollectionTree,
  renameCollection,
  restorePaperFromTrash,
  permanentlyDeletePaperFromTrash,
  permanentlyDeleteAllFromTrash
} from "./lib/libraryActions";
import {
  deleteFileBlob,
  markAnnotationDeleted,
  upsertById
} from "./lib/localStore";
import { deletePersistedEntities } from "./lib/libraryDb";
import {
  buildPdfFileName,
  bindPdfToPaper,
  deleteStoredPdf,
  fileNameMatchesTarget,
  importPdf,
  loadFileStorageSettings,
  migrateStoredPdfs,
  movePdfOnDisk,
  readFileBytes,
  reconcileFileStorage,
  saveFileStorageSettings,
  type FileStorageSettings
} from "./lib/fileStorage";
import { cleanupDuplicateDownloads, scanDuplicateDownloads, type CleanupDuplicateSummary } from "./lib/cleanupDuplicates";
import { FileStorageSettingsModal } from "./components/FileStorageSettingsModal";
import { MendeleySyncModal } from "./components/MendeleySyncModal";
import { ProxySettingsModal } from "./components/ProxySettingsModal";
import { DuplicateDocumentsModal } from "./components/DuplicateDocumentsModal";
import { UpdateModal } from "./components/UpdateModal";
import { parseReferenceFile } from "./lib/referenceImport";
import {
  extractPdfBodyText,
  getSearchIndexStatus,
  indexPaperBody,
  mapHitsToPapers,
  planBodyBackfill,
  searchLibrary,
  type PaperSearchMeta,
  type SearchHit
} from "./lib/searchIndex";
import { formatFileSize } from "./lib/arxivFiles";
import { defaultProxySettings, loadProxySettings, saveProxySettings, type ProxySettings } from "./lib/proxySettings";
import { AppUpdater, initialAppUpdateState, type AppUpdateState } from "./lib/appUpdater";
import { useLibraryStore } from "./hooks/useLibraryStore";
import { useCloudSync } from "./hooks/useCloudSync";
import { useMendeleySync } from "./hooks/useMendeleySync";
import { useArxivDownloads } from "./hooks/useArxivDownloads";
import { browserPrepareAppExitEvent, nativePrepareAppExitEvent } from "./lib/appExit";
import {
  documentsTab,
  loadWorkspaceSession,
  reconcileWorkspaceSession,
  saveWorkspaceSession,
  type WorkspaceSessionV1,
  type WorkspaceTab
} from "./lib/workspaceSession";

const workspaceLayoutKey = "lumora:workspace-layout";
const collapseThreshold = 82;

type MainPanelKey = "library" | "workspace" | "sync";

type WorkspaceLayout = {
  widths: Record<MainPanelKey, number>;
  visible: Record<MainPanelKey, boolean>;
};

type ResizeDrag = {
  left: MainPanelKey;
  right: MainPanelKey;
  startX: number;
  startLeftWidth: number;
  startRightWidth: number;
};

type PaperDrag = {
  paperId: string;
  overCollectionId?: string;
};

const workspaceCommandEvent = "lumora-workspace-command";

const defaultWorkspaceLayout: WorkspaceLayout = {
  widths: {
    library: 236,
    workspace: 1040,
    sync: 280
  },
  visible: {
    library: true,
    workspace: true,
    sync: true
  }
};

const panelOrder: MainPanelKey[] = ["library", "workspace", "sync"];

function isPdfFile(fileAsset: FileAsset) {
  return fileAsset.mime === "application/pdf" || /\.pdf$/i.test(fileAsset.fileName);
}

// Single resolver for "focus the toolbar search box" so every entry point — the
// DOM keydown handler and the native Cmd+F event forwarded from Rust — agrees on
// the target. The input is located by the semantic `data-search-input` marker
// rather than a tag/type/class, which are presentational and can silently drift
// (a missing `type="text"` once made this a no-op on the Documents tab). The
// marker sits on whichever field the toolbar currently shows: the library search
// on Documents, the find-in-document input on a paper tab.
function focusToolbarSearch() {
  const input = document.querySelector<HTMLInputElement>(".app-toolbar input[data-search-input]");
  input?.focus();
  input?.select();
}

// A PDF is locally available when it lives on disk. `localPath` is authoritative
// — it is only ever set to a `.pdf` file we stored, so it stands on its own even
// when a record's mime/fileName came from a source (e.g. Mendeley) that doesn't
// look PDF-ish. The startup reconcile keeps localPath in sync with the folder,
// clearing it when the file is gone. `downloadState === "local"` is the legacy
// fallback for records that predate localPath.
function isLocalPdfFile(fileAsset: FileAsset): boolean {
  if (fileAsset.localPath) {
    return true;
  }
  return isPdfFile(fileAsset) && fileAsset.downloadState === "local";
}

export default function App() {
  const appUpdaterRef = useRef<AppUpdater | undefined>(undefined);
  if (!appUpdaterRef.current) {
    appUpdaterRef.current = new AppUpdater();
  }
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const bindPdfInputRef = useRef<HTMLInputElement>(null);
  const bindPdfPaperIdRef = useRef<string | undefined>(undefined);
  const importTargetCollectionIdRef = useRef<string | undefined>(undefined);
  const pdfRenameInFlightRef = useRef(false);
  // Filled by whichever PdfReader is active; the toolbar drives find next/prev
  // through it without re-rendering the memoized readers.
  const pdfSearchNavRef = useRef<PdfSearchNavHandle | null>(null);
  const [initialWorkspaceSession] = useState(() => loadWorkspaceSession());
  const workspaceSessionRef = useRef<WorkspaceSessionV1>(initialWorkspaceSession);
  const workspaceSessionReconciledRef = useRef(false);
  const [status, setStatus] = useState<string>();
  const [fileStorageSettings, setFileStorageSettings] = useState<FileStorageSettings>(() => loadFileStorageSettings());
  const [syncSettingsOpen, setSyncSettingsOpen] = useState(false);
  const libraryStore = useLibraryStore({
    onError: setStatus,
    reconcile: (state) => reconcileFileStorage(state, fileStorageSettings)
  });
  const { library, setLibrary, libraryRef, loadedRef: libraryLoadedRef, loaded: libraryLoaded, adoptFromDb } = libraryStore;
  const cloudSync = useCloudSync({
    store: libraryStore,
    onStatus: setStatus,
    onRequireConfiguration: () => setSyncSettingsOpen(true)
  });
  const mendeleySync = useMendeleySync({ store: libraryStore, fileStorageSettings, onStatus: setStatus });
  const arxivDownloads = useArxivDownloads({ store: libraryStore, fileStorageSettings, onStatus: setStatus });
  const [selectedCollectionId, setSelectedCollectionId] = useState(initialWorkspaceSession.selectedCollectionId);
  const [selectedAuthor, setSelectedAuthor] = useState<string>();
  const [selectedTag, setSelectedTag] = useState<string>();
  const [selectedPaperId, setSelectedPaperId] = useState<string | undefined>(initialWorkspaceSession.selectedPaperId);
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>(initialWorkspaceSession.tabs);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState(initialWorkspaceSession.activeTabId);
  const [pdfViewStates, setPdfViewStates] = useState<Record<string, PdfReaderViewState>>(initialWorkspaceSession.pdfViewStates);
  const pdfViewStatesRef = useRef<Record<string, PdfReaderViewState>>(initialWorkspaceSession.pdfViewStates);
  const [hydratedPaperTabIds, setHydratedPaperTabIds] = useState<Set<string>>(() => {
    const activeTab = initialWorkspaceSession.tabs.find((tab) => tab.id === initialWorkspaceSession.activeTabId);
    return new Set(activeTab?.kind === "paper" ? [activeTab.id] : []);
  });
  const [search, setSearch] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>();
  const [pdfSearchQuery, setPdfSearchQuery] = useState("");
  const [pdfSearchState, setPdfSearchState] = useState({ totalMatches: 0, activeMatchIndex: -1 });
  const backfillRunningRef = useRef(false);
  const [fileDataById, setFileDataById] = useState<Record<string, Uint8Array>>({});
  const [fileStorageModalOpen, setFileStorageModalOpen] = useState(false);
  const [mendeleySyncOpen, setMendeleySyncOpen] = useState(false);
  const [proxySettingsOpen, setProxySettingsOpen] = useState(false);
  const [duplicateDocumentsOpen, setDuplicateDocumentsOpen] = useState(false);
  const [proxySettings, setProxySettings] = useState<ProxySettings>(defaultProxySettings);
  const [proxySettingsLoaded, setProxySettingsLoaded] = useState(false);
  const [proxySettingsBusy, setProxySettingsBusy] = useState(false);
  const [proxySettingsError, setProxySettingsError] = useState<string>();
  const [fileStorageBusy, setFileStorageBusy] = useState(false);
  const [workspaceLayout, setWorkspaceLayout] = useState<WorkspaceLayout>(() => loadWorkspaceLayout());
  const [resizeDrag, setResizeDrag] = useState<ResizeDrag>();
  const [paperDrag, setPaperDrag] = useState<PaperDrag>();
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [collectionModalParentId, setCollectionModalParentId] = useState<string | undefined>();
  const [collectionModalOpen, setCollectionModalOpen] = useState(false);
  const [deleteCollectionId, setDeleteCollectionId] = useState<string | undefined>();
  const [renameCollectionId, setRenameCollectionId] = useState<string | undefined>();
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>(initialAppUpdateState);
  const collectionPaperCounts = useMemo(() => getCollectionPaperCounts(library), [library]);

  useEffect(() => {
    void loadProxySettings()
      .then(setProxySettings)
      .catch((error) => {
        setStatus(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setProxySettingsLoaded(true));
  }, []);

  useEffect(() => appUpdaterRef.current!.subscribe(setAppUpdateState), []);

  useEffect(() => {
    if (!proxySettingsLoaded || import.meta.env.DEV) return;
    void appUpdaterRef.current!.checkForUpdates("startup", proxySettings);
  }, [proxySettings, proxySettingsLoaded]);

  useEffect(() => {
    localStorage.setItem(workspaceLayoutKey, JSON.stringify(workspaceLayout));
  }, [workspaceLayout]);

  useEffect(() => {
    const session: WorkspaceSessionV1 = {
      version: 1,
      tabs: workspaceTabs,
      activeTabId: activeWorkspaceTabId,
      selectedCollectionId,
      selectedPaperId,
      pdfViewStates
    };
    workspaceSessionRef.current = session;
    pdfViewStatesRef.current = pdfViewStates;
    saveWorkspaceSession(session);
  }, [activeWorkspaceTabId, pdfViewStates, selectedCollectionId, selectedPaperId, workspaceTabs]);

  useEffect(() => {
    if (!libraryLoaded || workspaceSessionReconciledRef.current) {
      return;
    }
    workspaceSessionReconciledRef.current = true;

    const session = reconcileWorkspaceSession(workspaceSessionRef.current, library);
    workspaceSessionRef.current = session;
    saveWorkspaceSession(session);
    setWorkspaceTabs(session.tabs);
    setActiveWorkspaceTabId(session.activeTabId);
    setSelectedCollectionId(session.selectedCollectionId);
    setSelectedPaperId(session.selectedPaperId);
    pdfViewStatesRef.current = session.pdfViewStates;
    setPdfViewStates(session.pdfViewStates);

    const activeTab = session.tabs.find((tab) => tab.id === session.activeTabId);
    if (activeTab?.kind === "paper") {
      setHydratedPaperTabIds(new Set([activeTab.id]));
    }
  }, [library, libraryLoaded]);

  useEffect(() => {
    saveFileStorageSettings(fileStorageSettings);
  }, [fileStorageSettings]);

  useEffect(() => {
    if (!mendeleySyncOpen) {
      return;
    }

    void mendeleySync.refreshConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mendeleySyncOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isApplePlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
      const usesPrimaryModifier = isApplePlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const isCloseTabShortcut = event.key.toLowerCase() === "w"
        && usesPrimaryModifier
        && !event.altKey
        && !event.shiftKey;
      if (isCloseTabShortcut) {
        event.preventDefault();
        handleCloseActiveWorkspaceTab();
        return;
      }

      if (usesPrimaryModifier && !event.altKey && !event.shiftKey) {
        // Match the physical digit row so the shortcut survives IME/layout quirks.
        const digitMatch = /^Digit([1-9])$/.exec(event.code);
        const digit = digitMatch
          ? Number.parseInt(digitMatch[1], 10)
          : /^[1-9]$/.test(event.key)
            ? Number.parseInt(event.key, 10)
            : undefined;
        if (digit !== undefined) {
          const tab = workspaceTabs[digit - 1];
          if (tab) {
            event.preventDefault();
            handleActivateWorkspaceTab(tab);
          }
          return;
        }
      }

      // Cmd+F / Ctrl+F: focus the toolbar search bar (library search on
      // Documents, find-in-document on a paper tab). On macOS WKWebView claims
      // Cmd+F before the DOM sees it, so this branch is the Windows/Linux path;
      // macOS arrives via the native monitor's `focus-toolbar-search` event.
      // Both share focusToolbarSearch so they can never disagree on the target.
      const isFindShortcut = event.key.toLowerCase() === "f"
        && usesPrimaryModifier
        && !event.altKey
        && !event.shiftKey;
      if (isFindShortcut) {
        event.preventDefault();
        focusToolbarSearch();
        return;
      }

      const isPanelShortcut = usesPrimaryModifier && !event.altKey && !event.shiftKey;
      const shortcutKey = event.key.toLowerCase();
      const targetPanel: MainPanelKey | undefined = isPanelShortcut
        ? shortcutKey === "i"
          ? "sync"
          : shortcutKey === "j"
            ? "library"
            : undefined
        : undefined;

      if (!targetPanel) {
        return;
      }

      event.preventDefault();
      setWorkspaceLayout((current) => ({
        ...current,
        visible: {
          ...current.visible,
          [targetPanel]: !current.visible[targetPanel]
        }
      }));
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeWorkspaceTabId, workspaceTabs]);

  // The handler reads the latest closures through a ref so the Tauri event
  // subscription is registered exactly once — re-subscribing on every tab or
  // settings change cost an unlisten/listen IPC round trip each time.
  const workspaceCommandRef = useRef<(command: string) => void>(() => {});
  workspaceCommandRef.current = (command: string) => {
    if (command === "close-active-tab") {
      handleCloseActiveWorkspaceTab();
    } else if (command === "show-shortcuts-help") {
      setShortcutsHelpOpen(true);
    } else if (command === "show-about") {
      setAboutOpen(true);
    } else if (command === "check-for-updates") {
      void appUpdaterRef.current!.checkForUpdates("manual", proxySettings);
    } else if (command === "show-file-storage-settings") {
      setFileStorageModalOpen(true);
    } else if (command === "show-mendeley-sync") {
      setMendeleySyncOpen(true);
    } else if (command === "show-proxy-settings") {
      setProxySettingsError(undefined);
      setProxySettingsOpen(true);
    } else if (command === "show-sync-settings") {
      setStatus(undefined);
      setSyncSettingsOpen(true);
    } else if (command === "show-duplicate-documents") {
      setDuplicateDocumentsOpen(true);
    } else if (command === "download-arxiv-files") {
      void arxivDownloads.download();
    } else if (command === "refresh-library") {
      void handleRefreshLibrary();
    } else if (command === "focus-toolbar-search") {
      focusToolbarSearch();
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<string>(workspaceCommandEvent, (event) => {
      workspaceCommandRef.current(event.payload);
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
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen(nativePrepareAppExitEvent, () => {
      // Native Cmd+Q does not reliably fire WebView lifecycle events on macOS.
      // Give every mounted reader one synchronous chance to commit its latest
      // debounced position before acknowledging the intercepted quit request.
      window.dispatchEvent(new Event(browserPrepareAppExitEvent));
      void invoke("complete_app_exit");
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
  }, []);

  useEffect(() => {
    if (!resizeDrag) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const delta = event.clientX - resizeDrag.startX;
      const nextLeftWidth = resizeDrag.startLeftWidth + delta;
      const nextRightWidth = resizeDrag.startRightWidth - delta;

      if (nextLeftWidth < collapseThreshold) {
        setWorkspaceLayout((current) => ({
          widths: {
            ...current.widths,
            [resizeDrag.right]: Math.max(
              defaultWorkspaceLayout.widths[resizeDrag.right],
              resizeDrag.startRightWidth + resizeDrag.startLeftWidth
            )
          },
          visible: {
            ...current.visible,
            [resizeDrag.left]: false
          }
        }));
        setResizeDrag(undefined);
        return;
      }

      if (nextRightWidth < collapseThreshold) {
        setWorkspaceLayout((current) => ({
          widths: {
            ...current.widths,
            [resizeDrag.left]: Math.max(
              defaultWorkspaceLayout.widths[resizeDrag.left],
              resizeDrag.startLeftWidth + resizeDrag.startRightWidth
            )
          },
          visible: {
            ...current.visible,
            [resizeDrag.right]: false
          }
        }));
        setResizeDrag(undefined);
        return;
      }

      setWorkspaceLayout((current) => ({
        ...current,
        widths: {
          ...current.widths,
          [resizeDrag.left]: nextLeftWidth,
          [resizeDrag.right]: nextRightWidth
        }
      }));
    };

    const handlePointerUp = () => setResizeDrag(undefined);

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [resizeDrag]);

  const filteredPapers = useMemo(() => {
    const selectedCollectionIds = getCollectionAndDescendantIds(library.collections, selectedCollectionId);
    const collectionPaperIds = new Set(
      library.paperCollections
        .filter((item) => !item.deletedAt && selectedCollectionIds.has(item.collectionId))
        .map((item) => item.paperId)
    );
    const isTrash = selectedCollectionId === "trash";
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // One pass per lookup table so the per-paper filters below stay O(1)
    // instead of rescanning fileAssets/paperCollections for every paper.
    const paperIdsWithLocalPdf = new Set(
      library.fileAssets
        .filter((fileAsset) => !fileAsset.deletedAt && isLocalPdfFile(fileAsset))
        .map((fileAsset) => fileAsset.paperId)
    );
    const paperIdsInAnyCollection = new Set(
      library.paperCollections.filter((item) => !item.deletedAt).map((item) => item.paperId)
    );

    return library.papers
      .filter((paper) => isTrash ? Boolean(paper.deletedAt) : !paper.deletedAt)
      .filter((paper) => {
        switch (selectedCollectionId) {
          case "all":
            return true;
          case "recently_added":
            return paper.createdAt >= weekAgo;
          case "no_arxiv":
            return !paper.arxiv;
          case "no_pdf":
            return !paperIdsWithLocalPdf.has(paper.id);
          case "favorites":
            return Boolean(paper.favorite);
          case "unsorted":
            return !paperIdsInAnyCollection.has(paper.id);
          case "trash":
            return true;
          default:
            return collectionPaperIds.has(paper.id);
        }
      })
      .filter((paper) => {
        if (!selectedAuthor) {
          return true;
        }

        return paper.authors.some((author) => author.fullName === selectedAuthor);
      })
      .filter((paper) => {
        if (!selectedTag) {
          return true;
        }

        return paper.tags?.includes(selectedTag);
      })
      .sort((a, b) => {
        if (selectedCollectionId === "recently_added") {
          return b.createdAt.localeCompare(a.createdAt);
        }

        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [library, selectedAuthor, selectedCollectionId, selectedTag]);

  // A non-empty query searches the whole library via the FTS index; clearing it
  // restores the filtered view. Adding selectedCollectionId to the deps re-runs
  // the debounced fetch when the user clicks a different folder while a query is
  // active, so the frontend filter in displayedPapers can rescope results.
  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setSearchHits(undefined);
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchLibrary(query)
        .then((hits) => {
          if (!cancelled) {
            setSearchHits(hits);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setSearchHits([]);
            setStatus(`Search failed: ${error}`);
          }
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, selectedCollectionId]);

  const searchActive = search.trim().length > 0;
  const displayedPapers = useMemo(() => {
    if (!searchActive || !searchHits) {
      return filteredPapers;
    }
    const hitsToPapers = mapHitsToPapers(searchHits, library.papers);
    // Scope search results to the selected folder and its descendants when a
    // real collection is selected. Virtual collections ("all", "favorites",
    // etc.) are identified by their fixed string IDs and always show all hits.
    const isRealCollection = selectedCollectionId !== "all"
      && selectedCollectionId !== "recently_added"
      && selectedCollectionId !== "favorites"
      && selectedCollectionId !== "unsorted"
      && selectedCollectionId !== "trash";
    if (!isRealCollection) {
      return hitsToPapers;
    }
    const collectionIds = getCollectionAndDescendantIds(library.collections, selectedCollectionId);
    const paperIdsInCollection = new Set(
      library.paperCollections
        .filter((pc) => !pc.deletedAt && collectionIds.has(pc.collectionId))
        .map((pc) => pc.paperId)
    );
    return hitsToPapers.filter((paper) => paperIdsInCollection.has(paper.id));
  }, [filteredPapers, library.papers, library.collections, library.paperCollections, searchActive, searchHits, selectedCollectionId]);
  const searchMetaByPaperId = useMemo(() => {
    if (!searchActive || !searchHits) {
      return undefined;
    }
    return new Map<string, PaperSearchMeta>(
      searchHits.map((hit) => [hit.paperId, { matchedFields: hit.matchedFields, snippet: hit.snippet }])
    );
  }, [searchActive, searchHits]);

  // Body-text backfill: extract and index the full text of any local PDF whose
  // sha256 is not in the search index yet. Depending on `library.fileAssets`
  // covers every ingest path (import, arXiv download, Mendeley sync, re-bind)
  // without per-path hooks; the sha diff makes re-runs idempotent.
  useEffect(() => {
    let cancelled = false;

    const timer = window.setTimeout(() => {
      if (backfillRunningRef.current || !libraryLoadedRef.current) {
        return;
      }
      backfillRunningRef.current = true;

      void (async () => {
        try {
          const status = await getSearchIndexStatus();
          const current = libraryRef.current;
          if (!current || cancelled) {
            return;
          }

          for (const item of planBodyBackfill(current, status)) {
            if (cancelled) {
              return;
            }
            try {
              const bytes = await readFileBytes(item.fileAsset, fileStorageSettings);
              if (bytes) {
                // Extraction failures (encrypted or scanned PDFs) still record
                // the sha so the file is not retried on every startup.
                const text = await extractPdfBodyText(bytes).catch(() => "");
                if (cancelled) {
                  return;
                }
                await indexPaperBody(item.paperId, item.fileAsset.sha256, text);
              }
            } catch {
              // Unreadable file: leave it unindexed and retry on the next run.
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        } catch {
          // Index status unavailable; retried on the next fileAssets change.
        } finally {
          backfillRunningRef.current = false;
        }
      })();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileStorageSettings, library.fileAssets]);

  const selectedPaper = library.papers.find((paper) => paper.id === selectedPaperId && !paper.deletedAt);
  const selectedFile = selectedPaper
    ? (library.fileAssets.find((fileAsset) => fileAsset.paperId === selectedPaper.id && !fileAsset.deletedAt && isLocalPdfFile(fileAsset))
      ?? library.fileAssets.find((fileAsset) => fileAsset.paperId === selectedPaper.id && !fileAsset.deletedAt))
    : undefined;
  const selectedAnnotations = selectedPaper
    ? library.annotations.filter((annotation) => annotation.paperId === selectedPaper.id)
    : [];
  const selectedFileData = selectedFile ? fileDataById[selectedFile.id] : undefined;
  const selectedHasLocalPdf = selectedPaper
    ? library.fileAssets.some((fileAsset) =>
      fileAsset.paperId === selectedPaper.id
      && !fileAsset.deletedAt
      && isLocalPdfFile(fileAsset)
      && (Boolean(fileDataById[fileAsset.id]?.length)
        || Boolean(fileStorageSettings.directory && fileAsset.localPath))
    )
    : false;
  async function requestSelectedFileData() {
    if (!selectedFile) {
      return undefined;
    }
    return selectedFileData ?? readFileBytes(selectedFile, fileStorageSettings);
  }
  const activeWorkspaceTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? documentsTab;
  const searchMode = activeWorkspaceTab.kind === "paper" ? "pdf" as const : "library" as const;

  // Clear PDF search when switching away from a paper tab; carry the library
  // search query over to PDF find when opening a paper tab.
  useEffect(() => {
    if (activeWorkspaceTab.kind !== "paper") {
      setPdfSearchQuery("");
      setPdfSearchState({ totalMatches: 0, activeMatchIndex: -1 });
    } else if (search.trim() && !pdfSearchQuery.trim()) {
      setPdfSearchQuery(search);
    }
  }, [activeWorkspaceTabId]);

  const openPaperFileIds = useMemo(() => {
    const fileIds = workspaceTabs.flatMap((tab) => {
      if (tab.kind !== "paper") {
        return [];
      }

      const paper = library.papers.find((item) => item.id === tab.paperId && !item.deletedAt);
      if (!paper) {
        return [];
      }
      // Prefer a fileAsset that is actually on disk or marked local, then fall
      // back to any non-deleted file for the paper. Without this a Mendeley
      // "remote" entry would shadow a local PDF that lives in the storage folder.
      const fileAsset =
        library.fileAssets.find((item) => item.paperId === paper.id && !item.deletedAt && isLocalPdfFile(item))
        ?? library.fileAssets.find((item) => item.paperId === paper.id && !item.deletedAt && isPdfFile(item));
      const opensFromStoragePath = Boolean(
        fileStorageSettings.directory && fileAsset?.localPath
      );
      return fileAsset && !opensFromStoragePath ? [fileAsset.id] : [];
    });

    // The Details panel (Extract PDF, metadata preview) needs bytes for the
    // selected paper even when its reader tab isn't open.
    const selectedFileIds = selectedPaperId
      ? library.fileAssets
        .filter((item) => item.paperId === selectedPaperId
          && !item.deletedAt
          && isPdfFile(item)
          && !(fileStorageSettings.directory && item.localPath))
        .map((item) => item.id)
      : [];
    for (const selectedFileId of selectedFileIds) {
      if (!fileIds.includes(selectedFileId)) {
        fileIds.push(selectedFileId);
      }
    }

    return fileIds;
  }, [fileStorageSettings.directory, library.fileAssets, library.papers, selectedPaperId, workspaceTabs]);

  // PDF bytes are large and each retained Uint8Array prevents the corresponding
  // document from being reclaimed. Disk-backed readers now open their native
  // path directly (Poppler on Linux, PDF.js ranges elsewhere), so this cache is
  // reserved for legacy IndexedDB PDFs. Details loads disk bytes only when its
  // explicit metadata extraction action needs them.
  useEffect(() => {
    const requiredFileIds = new Set(openPaperFileIds);
    setFileDataById((current) => {
      const entries = Object.entries(current).filter(([fileId]) => requiredFileIds.has(fileId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [openPaperFileIds]);

  useEffect(() => {
    let cancelled = false;

    const missingFileIds = openPaperFileIds.filter((fileId) => !fileDataById[fileId]);
    if (missingFileIds.length === 0) {
      return undefined;
    }

    void Promise.all(missingFileIds.map(async (fileId): Promise<{ fileId: string; bytes?: Uint8Array; missingFileName?: string } | undefined> => {
      const fileAsset = library.fileAssets.find((item) => item.id === fileId);
      if (!fileAsset) {
        return undefined;
      }

      const bytes = await readFileBytes(fileAsset, fileStorageSettings);
      if (!bytes && fileAsset.localPath) {
        return { fileId, missingFileName: fileAsset.fileName };
      }
      return bytes ? { fileId, bytes } : undefined;
    })).then((loadedFiles) => {
      if (cancelled) {
        return;
      }

      const missingFile = loadedFiles.find((loadedFile) => loadedFile?.missingFileName);
      if (missingFile?.missingFileName) {
        setStatus(`PDF file not found on disk: ${missingFile.missingFileName}`);
      }

      setFileDataById((current) => {
        let changed = false;
        const next = { ...current };
        for (const loadedFile of loadedFiles) {
          if (loadedFile?.bytes) {
            next[loadedFile.fileId] = loadedFile.bytes;
            changed = true;
          }
        }
        // When every required file is missing from disk, nothing gets added.
        // Returning a fresh object would keep re-triggering this effect (it
        // depends on fileDataById) and spin the WebKit process at 100% CPU, so
        // return the original reference to let React bail out of the update.
        return changed ? next : current;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [fileDataById, fileStorageSettings, library.fileAssets, openPaperFileIds]);

  // Details-panel inputs fire onUpdatePaper per keystroke, so on-disk renames are
  // debounced off a fingerprint of the naming inputs instead of running inline.
  const pdfRenameFingerprint = useMemo(() => {
    if (!fileStorageSettings.directory) {
      return "";
    }

    const papersById = new Map(
      library.papers.filter((paper) => !paper.deletedAt).map((paper) => [paper.id, paper])
    );
    return library.fileAssets
      .filter((fileAsset) => !fileAsset.deletedAt && fileAsset.localPath)
      .map((fileAsset) => {
        const paper = papersById.get(fileAsset.paperId);
        return paper
          ? `${fileAsset.id}:${fileAsset.localPath}:${buildPdfFileName(paper, fileStorageSettings.nameTemplate)}`
          : "";
      })
      .join("|");
  }, [fileStorageSettings, library.fileAssets, library.papers]);

  useEffect(() => {
    if (!pdfRenameFingerprint || fileStorageBusy) {
      return;
    }

    const timer = window.setTimeout(() => {
      void renameStoredPdfsToMatchMetadata();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [fileStorageBusy, pdfRenameFingerprint]);

  async function handleImportPdf(file?: File, targetCollectionId?: string) {
    if (!file) {
      return;
    }

    const imported = await importPdf(library, file, fileStorageSettings);
    const targetCollection = targetCollectionId && targetCollectionId !== "collection_inbox"
      ? library.collections.find((collection) => collection.id === targetCollectionId && !collection.deletedAt)
      : undefined;
    const finalState = targetCollection
      ? addPaperToCollection(imported.state, imported.paper.id, targetCollection.id)
      : imported.state;

    setLibrary(finalState);
    setSelectedPaperId(imported.paper.id);
    setSelectedCollectionId(targetCollection?.id ?? "all");
    setSelectedAuthor(undefined);
    setSelectedTag(undefined);
    setStatus(targetCollection ? `Imported ${file.name} to ${targetCollection.name}.` : `Imported ${file.name}.`);
  }

  async function handleBindLocalPdf(file?: File) {
    const paperId = bindPdfPaperIdRef.current;
    bindPdfPaperIdRef.current = undefined;
    if (!file || !paperId) return;
    try {
      const current = libraryRef.current ?? library;
      const result = await bindPdfToPaper(current, paperId, file, fileStorageSettings);
      const bytes = new Uint8Array(await file.arrayBuffer());
      setLibrary(result.state);
      setFileDataById((items) => ({ ...items, [result.fileAsset.id]: bytes }));
      const paper = result.state.papers.find((item) => item.id === paperId);
      setStatus(`Bound ${result.fileAsset.fileName} to ${paper?.title ?? "document"}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function handleRequestBindLocalPdf(paperId: string) {
    bindPdfPaperIdRef.current = paperId;
    bindPdfInputRef.current?.click();
  }

  async function handleImportReferenceFile(file?: File) {
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const papers = parseReferenceFile(file.name, text);
      if (papers.length === 0) {
        setStatus("No references found in the selected file.");
        return;
      }

      const now = new Date().toISOString();
      const paperCollections = papers.map((paper) => ({
        id: createId("paper_collection"),
        paperId: paper.id,
        collectionId: "collection_inbox",
        createdAt: now,
        updatedAt: now
      }));

      setLibrary((current) => ({
        ...current,
        papers: [...papers, ...current.papers],
        paperCollections: [...paperCollections, ...current.paperCollections]
      }));
      setSelectedCollectionId("all");
      setSelectedAuthor(undefined);
      setSelectedTag(undefined);
      setSelectedPaperId(papers[0]?.id);
      setStatus(`Imported ${papers.length} references from ${file.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to import references.");
    }
  }

  function handleCreateManualReference(draft: ManualReferenceDraft) {
    const now = new Date().toISOString();
    const paper: Paper = {
      id: createId("paper"),
      title: draft.title,
      authors: draft.authors.map((fullName) => ({ fullName })),
      year: draft.year,
      venue: draft.venue,
      doi: draft.doi,
      abstract: draft.abstract,
      source: "manual",
      documentType: draft.documentType,
      tags: draft.tags,
      keywords: draft.keywords,
      url: draft.url,
      pages: draft.pages,
      volume: draft.volume,
      issue: draft.issue,
      publisher: draft.publisher,
      favorite: false,
      needsReview: false,
      unread: true,
      createdAt: now,
      updatedAt: now
    };

    setLibrary((current) => ({
      ...current,
      papers: [paper, ...current.papers],
      paperCollections: [
        {
          id: createId("paper_collection"),
          paperId: paper.id,
          collectionId: "collection_inbox",
          createdAt: now,
          updatedAt: now
        },
        ...current.paperCollections
      ]
    }));
    setSelectedCollectionId("all");
    setSelectedAuthor(undefined);
    setSelectedTag(undefined);
    setSelectedPaperId(paper.id);
    setStatus("Manual entry added.");
  }

  function handleCreateCollection(parentId?: string) {
    setCollectionModalParentId(parentId);
    setCollectionModalOpen(true);
  }

  function handleAddPdfToCollection(collectionId: string) {
    importTargetCollectionIdRef.current = collectionId;
    fileInputRef.current?.click();
  }

  function handleSaveCollection(name: string) {
    const parent = collectionModalParentId
      ? library.collections.find((collection) => collection.id === collectionModalParentId && !collection.deletedAt)
      : undefined;
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    const now = new Date().toISOString();
    const siblingCount = library.collections.filter((item) => !item.deletedAt && item.parentId === parent?.id).length;
    const collection: Collection = {
      id: createId("collection"),
      name: trimmedName,
      parentId: parent?.id,
      sortOrder: siblingCount,
      createdAt: now,
      updatedAt: now
    };
    setLibrary((current) => ({
      ...current,
      collections: [...current.collections, collection]
    }));
    setSelectedCollectionId(collection.id);
    setCollectionModalOpen(false);
    setCollectionModalParentId(undefined);
    setStatus(parent ? `Created folder in ${parent.name}.` : "Created folder.");
  }

  function handleRequestRenameCollection(collectionId: string) {
    setRenameCollectionId(collectionId);
  }

  function handleRenameCollection(name: string) {
    if (!renameCollectionId) {
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    setLibrary((current) => renameCollection(current, renameCollectionId, trimmedName));
    setRenameCollectionId(undefined);
    setStatus(`Renamed folder to ${trimmedName}.`);
  }

  function handleRequestDeleteCollection(collectionId: string) {
    if (collectionId === "collection_inbox") {
      setStatus("Inbox is a system folder and cannot be deleted.");
      return;
    }

    setDeleteCollectionId(collectionId);
  }

  function handleDeleteCollection() {
    if (!deleteCollectionId) {
      return;
    }

    const target = library.collections.find((collection) => collection.id === deleteCollectionId && !collection.deletedAt);
    if (!target || target.id === "collection_inbox") {
      setDeleteCollectionId(undefined);
      return;
    }

    const parentId = target.parentId;
    setLibrary((current) => deleteCollectionAndReassignPapers(current, target.id));

    if (selectedCollectionId === target.id) {
      setSelectedCollectionId(parentId ?? "unsorted");
    }

    setDeleteCollectionId(undefined);
    setStatus(parentId ? "Deleted folder and moved papers to parent folder." : "Deleted folder and moved papers to Unsorted.");
  }

  function handleAddPaperToCollection(paperId: string, collectionId: string) {
    let added = false;
    let paperTitle = "paper";
    let collectionName = "folder";

    flushSync(() => {
      setLibrary((current) => {
        const nextLibrary = addPaperToCollection(current, paperId, collectionId);
        added = nextLibrary !== current;
        paperTitle = current.papers.find((item) => item.id === paperId)?.title ?? paperTitle;
        collectionName = current.collections.find((item) => item.id === collectionId)?.name ?? collectionName;
        return nextLibrary;
      });
      setSelectedCollectionId(collectionId);
    });

    setStatus(added
      ? `Added ${paperTitle} to ${collectionName}.`
      : "Paper is already in that folder."
    );
  }

  function handlePaperDragStart(paperId: string) {
    setPaperDrag({ paperId });
  }

  function handlePaperDragMove(paperId: string, overCollectionId?: string) {
    setPaperDrag((current) => {
      if (current?.paperId === paperId && current.overCollectionId === overCollectionId) {
        return current;
      }

      return { paperId, overCollectionId };
    });
  }

  function handlePaperDragEnd(paperId: string, collectionId?: string) {
    setPaperDrag(undefined);
    if (collectionId) {
      handleAddPaperToCollection(paperId, collectionId);
    }
  }

  function handleRemovePaperFromSelectedCollection(paperId: string) {
    const collection = library.collections.find((item) => item.id === selectedCollectionId && !item.deletedAt);
    if (!collection) {
      setStatus("Select a folder before removing a folder relationship.");
      return;
    }

    setLibrary((current) => removePaperFromCollectionTree(current, paperId, collection.id));
    setStatus(collection.parentId
      ? "Removed from this folder tree and moved the document to the parent folder."
      : "Removed from this folder tree. The document remains in the library."
    );
  }

  function handleDeletePaper(paperId: string) {
    const paper = library.papers.find((item) => item.id === paperId && !item.deletedAt);
    if (!paper) {
      return;
    }

    setLibrary((current) => deletePaperFromLibrary(current, paperId));
    if (selectedPaperId === paperId) {
      setSelectedPaperId(undefined);
    }
    const deletedFileIds = library.fileAssets.filter((file) => file.paperId === paperId).map((file) => file.id);
    setFileDataById((current) => Object.fromEntries(
      Object.entries(current).filter(([fileId]) => !deletedFileIds.includes(fileId))
    ));
    setWorkspaceTabs((current) => current.filter((tab) => !(tab.kind === "paper" && tab.paperId === paperId)));
    if (activeWorkspaceTabId === `paper:${paperId}`) {
      setActiveWorkspaceTabId(documentsTab.id);
    }
    setStatus(`Deleted ${paper.title}.`);
  }

  function handleRestorePaper(paperId: string) {
    const paper = library.papers.find((item) => item.id === paperId && item.deletedAt);
    if (!paper) {
      return;
    }

    setLibrary((current) => restorePaperFromTrash(current, paperId));
    setStatus(`Restored ${paper.title} to Unsorted.`);
  }

  async function handlePermanentlyDeletePaper(paperId: string) {
    const paper = library.papers.find((item) => item.id === paperId && item.deletedAt);
    if (!paper) {
      return;
    }
    if (!window.confirm(`Permanently delete “${paper.title}”? This cannot be undone.`)) {
      return;
    }

    const files = library.fileAssets.filter((item) => item.paperId === paperId);
    const annotations = library.annotations.filter((item) => item.paperId === paperId);
    const memberships = library.paperCollections.filter((item) => item.paperId === paperId);
    setLibrary((current) => permanentlyDeletePaperFromTrash(current, paperId));
    if (selectedPaperId === paperId) setSelectedPaperId(undefined);
    setFileDataById((current) => Object.fromEntries(
      Object.entries(current).filter(([fileId]) => !files.some((file) => file.id === fileId))
    ));
    setWorkspaceTabs((current) => current.filter((tab) => !(tab.kind === "paper" && tab.paperId === paperId)));
    if (activeWorkspaceTabId === `paper:${paperId}`) setActiveWorkspaceTabId(documentsTab.id);

    const diskDeletes = files.flatMap((file) =>
      file.localPath && fileStorageSettings.directory
        ? [deleteStoredPdf(fileStorageSettings.directory, file.localPath)]
        : []
    );
    await Promise.allSettled([...files.map((file) => deleteFileBlob(file.id)), ...diskDeletes]);
    await deletePersistedEntities([
      { entityType: "paper", id: paperId },
      ...files.map((file) => ({ entityType: "fileAsset" as const, id: file.id })),
      ...annotations.map((annotation) => ({ entityType: "annotation" as const, id: annotation.id })),
      ...memberships.map((membership) => ({ entityType: "paperCollection" as const, id: membership.id }))
    ]);
    setStatus(`Permanently deleted ${paper.title}.`);
  }

  async function handleRefreshLibrary() {
    try {
      const refreshed = await adoptFromDb();
      if (!refreshed) {
        setStatus("Library is empty — nothing to refresh.");
        return;
      }
      // Force re-reading file bytes for currently open papers so icons and
      // download states reflect the actual files on disk.
      setFileDataById({});
      setStatus("Library refreshed from disk.");
    } catch (error) {
      setStatus(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleEmptyTrash() {
    const trashedPapers = library.papers.filter((paper) => paper.deletedAt);
    if (trashedPapers.length === 0) {
      setStatus("Trash is already empty.");
      return;
    }
    if (!window.confirm(`Permanently delete all ${trashedPapers.length} document${trashedPapers.length === 1 ? "" : "s"} in Trash? This cannot be undone.`)) {
      return;
    }

    const files = library.fileAssets.filter((item) => trashedPapers.some((paper) => paper.id === item.paperId));
    const annotations = library.annotations.filter((item) => trashedPapers.some((paper) => paper.id === item.paperId));
    const memberships = library.paperCollections.filter((item) => trashedPapers.some((paper) => paper.id === item.paperId));
    const trashedPaperIds = new Set(trashedPapers.map((paper) => paper.id));

    const { state: nextState } = permanentlyDeleteAllFromTrash(library);
    setLibrary(nextState);
    if (selectedPaperId && trashedPaperIds.has(selectedPaperId)) setSelectedPaperId(undefined);
    setFileDataById((current) => Object.fromEntries(
      Object.entries(current).filter(([fileId]) => !files.some((file) => file.id === fileId))
    ));
    setWorkspaceTabs((current) => current.filter((tab) => !(tab.kind === "paper" && trashedPaperIds.has(tab.paperId))));
    if (activeWorkspaceTabId.startsWith("paper:")) {
      const tabPaperId = activeWorkspaceTabId.slice("paper:".length);
      if (trashedPaperIds.has(tabPaperId)) setActiveWorkspaceTabId(documentsTab.id);
    }

    const diskDeletes = files.flatMap((file) =>
      file.localPath && fileStorageSettings.directory
        ? [deleteStoredPdf(fileStorageSettings.directory, file.localPath)]
        : []
    );
    await Promise.allSettled([...files.map((file) => deleteFileBlob(file.id)), ...diskDeletes]);
    await deletePersistedEntities([
      ...trashedPapers.map((paper) => ({ entityType: "paper" as const, id: paper.id })),
      ...files.map((file) => ({ entityType: "fileAsset" as const, id: file.id })),
      ...annotations.map((annotation) => ({ entityType: "annotation" as const, id: annotation.id })),
      ...memberships.map((membership) => ({ entityType: "paperCollection" as const, id: membership.id }))
    ]);
    setStatus(`Emptied Trash: permanently deleted ${trashedPapers.length} document${trashedPapers.length === 1 ? "" : "s"}.`);
  }

  function handleCreateAnnotation(annotation: Annotation) {
    setLibrary((current) => ({
      ...current,
      annotations: upsertById(current.annotations, annotation)
    }));
  }

  function handleDeleteAnnotation(annotation: Annotation) {
    setLibrary((current) => markAnnotationDeleted(current, annotation));
  }

  function handleSelectPaper(paperId: string) {
    setSelectedPaperId(paperId);
    setLibrary((current) => {
      const paper = current.papers.find((item) => item.id === paperId);
      if (!paper?.unread) {
        return current;
      }

      return {
        ...current,
        papers: current.papers.map((item) =>
          item.id === paperId ? { ...item, unread: false, updatedAt: new Date().toISOString() } : item
        )
      };
    });
  }

  function handleSelectCollection(collectionId: string) {
    setSelectedCollectionId(collectionId);
    // Clicking a collection always lands on the Documents tab, even while reading a paper.
    setActiveWorkspaceTabId(documentsTab.id);
    if (!selectedPaperId) return;
    const current = libraryRef.current ?? library;
    const paper = current.papers.find((item) => item.id === selectedPaperId);
    if (!paper) return;
    // Virtual collections: paper visibility is determined by filter logic in filteredPapers.
    // "all", "recently_added", "favorites", "unsorted", "trash" — let the filter decide.
    if (!collectionId || ["all", "recently_added", "favorites", "unsorted", "trash"].includes(collectionId)) return;
    // Real collection: deselect if the paper isn't a member.
    const isMember = current.paperCollections.some(
      (item) => item.paperId === selectedPaperId && item.collectionId === collectionId && !item.deletedAt
    );
    if (!isMember) {
      setSelectedPaperId(undefined);
    }
  }

  function handleOpenPaperTab(paperId: string) {
    const paper = library.papers.find((item) => item.id === paperId && !item.deletedAt);
    if (!paper) {
      return;
    }

    handleSelectPaper(paperId);
    const tabId = `paper:${paperId}`;
    setHydratedPaperTabIds((current) => current.has(tabId) ? current : new Set(current).add(tabId));
    setWorkspaceTabs((current) => {
      if (current.some((tab) => tab.id === tabId)) {
        return current;
      }

      return [...current, { id: tabId, kind: "paper", paperId, title: paper.title }];
    });
    setActiveWorkspaceTabId(tabId);
  }

  function handleOpenNotebookTab() {
    setWorkspaceTabs((current) => current.some((tab) => tab.id === "notebook")
      ? current
      : [...current, { id: "notebook", kind: "notebook", title: "Notebook" }]
    );
    setActiveWorkspaceTabId("notebook");
  }

  function handleCloseWorkspaceTab(tabId: string) {
    if (tabId === documentsTab.id) {
      return;
    }

    setWorkspaceTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      const next = current.filter((tab) => tab.id !== tabId);
      if (activeWorkspaceTabId === tabId) {
        const fallback = next[Math.max(0, index - 1)] ?? documentsTab;
        setActiveWorkspaceTabId(fallback.id);
        if (fallback.kind === "paper") {
          handleSelectPaper(fallback.paperId);
        }
      }

      return next;
    });
  }

  function handleCloseActiveWorkspaceTab() {
    const activeTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId);
    if (!activeTab || activeTab.id === documentsTab.id) {
      return;
    }

    handleCloseWorkspaceTab(activeTab.id);
  }

  function handleActivateWorkspaceTab(tab: WorkspaceTab) {
    setActiveWorkspaceTabId(tab.id);
    if (tab.kind === "paper") {
      setHydratedPaperTabIds((current) => current.has(tab.id) ? current : new Set(current).add(tab.id));
      handleSelectPaper(tab.paperId);
    }
  }

  function handleUpdatePdfViewState(paperId: string, viewState: PdfReaderViewState) {
    const previous = pdfViewStatesRef.current[paperId];
    if (previous?.scrollTop === viewState.scrollTop && previous.zoom === viewState.zoom) {
      return;
    }

    const next = { ...pdfViewStatesRef.current, [paperId]: viewState };
    pdfViewStatesRef.current = next;
    // This direct, synchronous snapshot write is also used by PdfReader's
    // page-exit flush. React effects are not guaranteed to run after Cmd+Q,
    // while localStorage completes before the WebView is torn down.
    const session = { ...workspaceSessionRef.current, pdfViewStates: next };
    workspaceSessionRef.current = session;
    saveWorkspaceSession(session);
    setPdfViewStates(next);
  }

  function handleUpdatePaper(paper: Paper) {
    // Bail out with the original array when no tab title actually changes, so
    // per-keystroke metadata edits don't re-render the tab bar.
    setWorkspaceTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (tab.kind === "paper" && tab.paperId === paper.id && tab.title !== paper.title) {
          changed = true;
          return { ...tab, title: paper.title };
        }
        return tab;
      });
      return changed ? next : current;
    });
    setLibrary((current) => ({
      ...current,
      papers: upsertById(current.papers, {
        ...paper,
        updatedAt: new Date().toISOString()
      })
    }));
  }

  async function renameStoredPdfsToMatchMetadata() {
    const directory = fileStorageSettings.directory;
    if (!directory || pdfRenameInFlightRef.current) {
      return;
    }

    pdfRenameInFlightRef.current = true;
    try {
      const updates: Array<{ id: string; fileName: string }> = [];
      for (const fileAsset of library.fileAssets) {
        if (fileAsset.deletedAt || !fileAsset.localPath) {
          continue;
        }

        const paper = library.papers.find((item) => item.id === fileAsset.paperId && !item.deletedAt);
        if (!paper) {
          continue;
        }

        const targetName = buildPdfFileName(paper, fileStorageSettings.nameTemplate);
        if (fileNameMatchesTarget(fileAsset.localPath, targetName)) {
          continue;
        }

        try {
          const storedName = await movePdfOnDisk(directory, fileAsset.localPath, directory, targetName);
          updates.push({ id: fileAsset.id, fileName: storedName });
        } catch (error) {
          setStatus(`Failed to rename PDF: ${error}`);
        }
      }

      if (updates.length > 0) {
        const now = new Date().toISOString();
        setLibrary((current) => ({
          ...current,
          fileAssets: current.fileAssets.map((item) => {
            const update = updates.find((entry) => entry.id === item.id);
            return update
              ? { ...item, fileName: update.fileName, localPath: update.fileName, updatedAt: now }
              : item;
          })
        }));
      }
    } finally {
      pdfRenameInFlightRef.current = false;
    }
  }

  async function handleSaveProxySettings(settings: ProxySettings) {
    setProxySettingsBusy(true);
    setProxySettingsError(undefined);
    try {
      await saveProxySettings(settings);
      setProxySettings(settings);
      setProxySettingsOpen(false);
      setStatus(settings.enabled ? `Proxy enabled: ${settings.url}` : "Proxy disabled.");
    } catch (error) {
      setProxySettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setProxySettingsBusy(false);
    }
  }

  async function handleSaveFileStorageSettings(nextSettings: FileStorageSettings) {
    const directoryChanged = nextSettings.directory !== fileStorageSettings.directory;
    const templateChanged = nextSettings.nameTemplate !== fileStorageSettings.nameTemplate;

    if (!nextSettings.directory || (!directoryChanged && !templateChanged)) {
      setFileStorageSettings(nextSettings);
      setFileStorageModalOpen(false);
      return;
    }

    setFileStorageBusy(true);
    try {
      const migrated = await migrateStoredPdfs(library, fileStorageSettings, nextSettings, (progress) => {
        setStatus(`Moving PDFs (${progress.done}/${progress.total}): ${progress.fileName}`);
      });
      setLibrary(migrated);
      setFileStorageSettings(nextSettings);
      setFileStorageModalOpen(false);
      setStatus(`PDF storage folder set to ${nextSettings.directory}.`);
    } catch (error) {
      setStatus(`File storage migration failed: ${error}`);
    } finally {
      setFileStorageBusy(false);
    }
  }

  async function handleCleanupDuplicates(): Promise<CleanupDuplicateSummary | undefined> {
    if (!fileStorageSettings.directory) {
      setStatus("No file storage folder configured.");
      return undefined;
    }
    setFileStorageBusy(true);
    try {
      const scan = await scanDuplicateDownloads(fileStorageSettings);
      if (scan.errors.some((error) => error.includes("No file storage folder"))) {
        setStatus("No file storage folder configured.");
        return scan;
      }
      if (scan.duplicateGroups.length === 0) {
        setStatus(`Scanned ${scan.totalFilesScanned} PDFs — no duplicate files found.`);
        return scan;
      }
      const confirmed = window.confirm(
        `Found ${scan.duplicateGroups.length} duplicate group(s) with ${scan.filesRemoved} excess file(s) (${formatFileSize(scan.bytesFreed)}).\n\nRemove the extra copies and update library records?`
      );
      if (!confirmed) {
        return scan;
      }
      const result = await cleanupDuplicateDownloads(fileStorageSettings);
      setStatus(
        `Removed ${result.filesRemoved} duplicate file(s), freed ${formatFileSize(result.bytesFreed)}, updated ${result.libraryRecordsUpdated} library record(s).`
      );
      return result;
    } catch (error) {
      setStatus(`Duplicate cleanup failed: ${error}`);
      return undefined;
    } finally {
      setFileStorageBusy(false);
    }
  }

  function handleStartResize(event: React.PointerEvent, left: MainPanelKey, right: MainPanelKey) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizeDrag({
      left,
      right,
      startX: event.clientX,
      startLeftWidth: workspaceLayout.widths[left],
      startRightWidth: workspaceLayout.widths[right]
    });
  }

  function handleRestorePanel(panel: MainPanelKey) {
    setWorkspaceLayout((current) => ({
      widths: {
        ...current.widths,
        [panel]: Math.max(current.widths[panel], defaultWorkspaceLayout.widths[panel])
      },
      visible: {
        ...current.visible,
        [panel]: true
      }
    }));
  }

  return (
    <main className="app-frame">
      <AppToolbar
        search={searchMode === "library" ? search : pdfSearchQuery}
        searchMode={searchMode}
        status={status}
        onSearchChange={searchMode === "library" ? setSearch : setPdfSearchQuery}
        pdfSearchTotalMatches={pdfSearchState.totalMatches}
        pdfSearchActiveMatchIndex={pdfSearchState.activeMatchIndex}
        onPdfSearchNext={() => pdfSearchNavRef.current?.goToNextFindMatch()}
        onPdfSearchPrev={() => pdfSearchNavRef.current?.goToPrevFindMatch()}
        onPdfSearchClose={() => {
          setPdfSearchQuery("");
          setPdfSearchState({ totalMatches: 0, activeMatchIndex: -1 });
        }}
      />

      <section className={resizeDrag ? "app-shell resizing" : "app-shell"}>
      {panelOrder.map((panel, index) => (
        <PanelFragment
          key={panel}
          panel={panel}
          width={workspaceLayout.widths[panel]}
          visible={workspaceLayout.visible[panel]}
          nextPanel={panelOrder[index + 1]}
          nextPanelVisible={panelOrder[index + 1] ? workspaceLayout.visible[panelOrder[index + 1]] : false}
          onStartResize={handleStartResize}
          onRestorePanel={handleRestorePanel}
        >
          {panel === "library" && (
            <LibrarySidebar
              state={library}
              collectionPaperCounts={collectionPaperCounts}
              dragOverCollectionId={paperDrag?.overCollectionId}
              selectedCollectionId={selectedCollectionId}
              selectedPaperId={selectedPaperId}
              selectedAuthor={selectedAuthor}
              selectedTag={selectedTag}
              onSelectCollection={handleSelectCollection}
              onSelectAuthor={setSelectedAuthor}
              onSelectTag={setSelectedTag}
              onCreateCollection={handleCreateCollection}
              onRenameCollection={handleRequestRenameCollection}
              onDeleteCollection={handleRequestDeleteCollection}
              onAddPaperToCollection={handleAddPaperToCollection}
              onAddPdfToCollection={handleAddPdfToCollection}
              onEmptyTrash={() => void handleEmptyTrash()}
              onSync={cloudSync.sync}
              syncBusy={cloudSync.activity?.state === "running"}
              cloudSyncActivity={cloudSync.activity}
              mendeleySyncActivity={mendeleySync.activity}
              onCancelMendeleySync={mendeleySync.cancelSync}
              onCancelCloudSync={cloudSync.cancelSync}
              onDismissCloudSync={cloudSync.dismissActivity}
            />
          )}

          {panel === "workspace" && (
            <WorkspaceTabs
              tabs={workspaceTabs}
              activeTabId={activeWorkspaceTabId}
              onSelectTab={handleActivateWorkspaceTab}
              onCloseTab={handleCloseWorkspaceTab}
            >
              {workspaceTabs
                // Restored background readers mount lazily on first activation,
                // avoiding a startup burst when the previous session had many
                // PDFs open. Once hydrated, paper tabs stay warm to preserve
                // their renderer session and visible page cache.
                .filter((tab) => tab.kind === "paper"
                  ? hydratedPaperTabIds.has(tab.id)
                  : tab.id === activeWorkspaceTabId)
                .map((tab) => {
                  const tabActive = tab.id === activeWorkspaceTabId;
                  return (
                    <div
                      key={tab.id}
                      className={tabActive ? "workspace-tab-pane active" : "workspace-tab-pane"}
                      aria-hidden={!tabActive}
                      role="tabpanel"
                    >
                      <WorkspaceTabContent
                        active={tabActive}
                        tab={tab}
                        library={library}
                        filteredPapers={displayedPapers}
                        searchMeta={searchMetaByPaperId}
                        selectedPaperId={selectedPaperId}
                        selectedCollectionId={selectedCollectionId}
                        fileDataById={fileDataById}
                        fileStorageDirectory={fileStorageSettings.directory}
                        pdfViewStates={pdfViewStates}
                        pdfSearchQuery={tabActive && tab.kind === "paper" ? pdfSearchQuery : undefined}
                        onPdfSearchUpdate={tabActive ? setPdfSearchState : undefined}
                        pdfSearchNavRef={pdfSearchNavRef}
                        onSelectPaper={handleSelectPaper}
                        onOpenPaper={handleOpenPaperTab}
                        onUpdatePaper={handleUpdatePaper}
                        onPaperDragStart={handlePaperDragStart}
                        onPaperDragMove={handlePaperDragMove}
                        onPaperDragEnd={handlePaperDragEnd}
                        onRemovePaperFromCollection={handleRemovePaperFromSelectedCollection}
                        onDeletePaper={handleDeletePaper}
                        onRestorePaper={handleRestorePaper}
                        onPermanentlyDeletePaper={(paperId) => void handlePermanentlyDeletePaper(paperId)}
                        onBindLocalPdf={handleRequestBindLocalPdf}
                        onUpdatePdfViewState={handleUpdatePdfViewState}
                        onCreateAnnotation={handleCreateAnnotation}
                        onDeleteAnnotation={handleDeleteAnnotation}
                      />
                    </div>
                  );
                })}
            </WorkspaceTabs>
          )}

          {panel === "sync" && (
            <SyncPanel
              settings={cloudSync.settings}
              paper={selectedPaper}
              fileAsset={selectedFile}
              fileData={selectedFileData}
              onRequestFileData={requestSelectedFileData}
              hasLocalPdf={selectedHasLocalPdf}
              annotations={selectedAnnotations}
              fileStorageSettings={fileStorageSettings}
              onUpdatePaper={handleUpdatePaper}
              arxivDownloadBusy={arxivDownloads.downloadBusy}
              onDownloadArxiv={(paperId, onProgress) => arxivDownloads.download(paperId, onProgress)}
              onDeleteAnnotation={handleDeleteAnnotation}
            />
          )}
        </PanelFragment>
      ))}

      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          const targetCollectionId = importTargetCollectionIdRef.current;
          importTargetCollectionIdRef.current = undefined;
          void handleImportPdf(event.target.files?.[0], targetCollectionId);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={referenceInputRef}
        className="hidden-input"
        type="file"
        accept=".ris,.bib,.bibtex,text/plain"
        onChange={(event) => {
          void handleImportReferenceFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={bindPdfInputRef}
        className="hidden-input"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          void handleBindLocalPdf(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      </section>

      {arxivDownloads.batchProgress && (
        <ArxivDownloadToast
          progress={arxivDownloads.batchProgress}
          onDismiss={arxivDownloads.dismissBatchToast}
        />
      )}

      <ManualReferenceModal
        open={manualModalOpen}
        onClose={() => setManualModalOpen(false)}
        onSave={handleCreateManualReference}
      />
      <ShortcutsHelpModal open={shortcutsHelpOpen} onClose={() => setShortcutsHelpOpen(false)} />
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <UpdateModal
        state={appUpdateState}
        onClose={() => void appUpdaterRef.current!.dismiss()}
        onInstall={() => void appUpdaterRef.current!.downloadAndInstall()}
        onRetry={() => void appUpdaterRef.current!.retry(proxySettings)}
        onRestart={() => void appUpdaterRef.current!.restart()}
      />
      <SyncSettingsModal
        open={syncSettingsOpen}
        settings={cloudSync.settings}
        autoSync={cloudSync.autoSyncSettings}
        busy={cloudSync.settingsBusy}
        syncing={cloudSync.activity?.state === "running"}
        status={cloudSync.activity?.state === "running" ? cloudSync.activity.message : status}
        onClose={() => setSyncSettingsOpen(false)}
        onSave={(nextSettings) => void cloudSync.saveSettings(nextSettings)}
        onSync={() => void cloudSync.sync()}
        onAutoSyncChange={cloudSync.setAutoSyncSettings}
      />
      <FileStorageSettingsModal
        open={fileStorageModalOpen}
        settings={fileStorageSettings}
        previewPaper={selectedPaper ?? library.papers.find((paper) => !paper.deletedAt)}
        busy={fileStorageBusy}
        onClose={() => setFileStorageModalOpen(false)}
        onSave={(nextSettings) => void handleSaveFileStorageSettings(nextSettings)}
        onCleanupDuplicates={() => handleCleanupDuplicates()}
      />
      <MendeleySyncModal
        open={mendeleySyncOpen}
        settings={mendeleySync.settings}
        connection={mendeleySync.connection}
        busy={mendeleySync.connectionBusy}
        syncing={mendeleySync.syncBusy}
        status={status}
        onSettingsChange={mendeleySync.setSettings}
        onConnect={() => void mendeleySync.connect()}
        onDisconnect={() => void mendeleySync.disconnect()}
        onSync={() => void mendeleySync.sync()}
        onClose={() => setMendeleySyncOpen(false)}
      />
      <ProxySettingsModal
        open={proxySettingsOpen}
        settings={proxySettings}
        busy={proxySettingsBusy}
        error={proxySettingsError}
        onClose={() => setProxySettingsOpen(false)}
        onSave={(settings) => void handleSaveProxySettings(settings)}
      />
      <DuplicateDocumentsModal
        open={duplicateDocumentsOpen}
        state={library}
        onClose={() => setDuplicateDocumentsOpen(false)}
        onDelete={(paperIds) => {
          for (const paperId of paperIds) handleDeletePaper(paperId);
          setDuplicateDocumentsOpen(false);
          setStatus(`Moved ${paperIds.length} duplicate document${paperIds.length === 1 ? "" : "s"} to Trash.`);
        }}
      />
      <CollectionModal
        open={collectionModalOpen}
        parentName={library.collections.find((collection) => collection.id === collectionModalParentId)?.name}
        onClose={() => {
          setCollectionModalOpen(false);
          setCollectionModalParentId(undefined);
        }}
        onSave={handleSaveCollection}
      />
      <DeleteCollectionModal
        open={Boolean(deleteCollectionId)}
        collectionName={library.collections.find((collection) => collection.id === deleteCollectionId)?.name}
        parentName={library.collections.find((collection) =>
          collection.id === library.collections.find((item) => item.id === deleteCollectionId)?.parentId
        )?.name}
        onClose={() => setDeleteCollectionId(undefined)}
        onDelete={handleDeleteCollection}
      />
      <RenameCollectionModal
        open={Boolean(renameCollectionId)}
        currentName={library.collections.find((collection) => collection.id === renameCollectionId)?.name}
        onClose={() => setRenameCollectionId(undefined)}
        onSave={handleRenameCollection}
      />
    </main>
  );
}

function PanelFragment({
  panel,
  width,
  visible,
  nextPanel,
  nextPanelVisible,
  onStartResize,
  onRestorePanel,
  children
}: {
  panel: MainPanelKey;
  width: number;
  visible: boolean;
  nextPanel?: MainPanelKey;
  nextPanelVisible: boolean;
  onStartResize: (event: React.PointerEvent, left: MainPanelKey, right: MainPanelKey) => void;
  onRestorePanel: (panel: MainPanelKey) => void;
  children: React.ReactNode;
}) {
  const flex = panel === "workspace" ? `1 1 ${width}px` : `0 0 ${width}px`;

  return (
    <>
      {visible ? (
        <section className={`workspace-panel panel-${panel}`} style={{ flex }}>
          {children}
        </section>
      ) : (
        <CollapsedPanelGutter panel={panel} onRestorePanel={onRestorePanel} />
      )}
      {visible && nextPanel && nextPanelVisible && (
        <div
          className="panel-resizer"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={(event) => onStartResize(event, panel, nextPanel)}
        />
      )}
    </>
  );
}

function WorkspaceTabs({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  children
}: {
  tabs: WorkspaceTab[];
  activeTabId: string;
  onSelectTab: (tab: WorkspaceTab) => void;
  onCloseTab: (tabId: string) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="workspace-tabs">
      <div className="workspace-tab-bar" role="tablist" aria-label="Open documents">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.id === activeTabId ? "workspace-tab active" : "workspace-tab"}
            title={tab.title}
          >
            <button
              type="button"
              className="workspace-tab-select"
              onClick={() => onSelectTab(tab)}
              role="tab"
              aria-selected={tab.id === activeTabId}
            >
              {tab.kind === "paper" && <FileText size={14} />}
              <span>{tab.title}</span>
            </button>
            {tab.id !== documentsTab.id && (
              <button
                type="button"
                className="workspace-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="workspace-tab-content">
        {children}
      </div>
    </section>
  );
}

function WorkspaceTabContent({
  active,
  tab,
  library,
  filteredPapers,
  searchMeta,
  selectedPaperId,
  selectedCollectionId,
  fileDataById,
  fileStorageDirectory,
  pdfViewStates,
  pdfSearchQuery,
  onPdfSearchUpdate,
  pdfSearchNavRef,
  onSelectPaper,
  onOpenPaper,
  onUpdatePaper,
  onPaperDragStart,
  onPaperDragMove,
  onPaperDragEnd,
  onRemovePaperFromCollection,
  onDeletePaper,
  onRestorePaper,
  onPermanentlyDeletePaper,
  onBindLocalPdf,
  onUpdatePdfViewState,
  onCreateAnnotation,
  onDeleteAnnotation
}: {
  active: boolean;
  tab: WorkspaceTab;
  library: LibraryState;
  filteredPapers: Paper[];
  searchMeta?: Map<string, PaperSearchMeta>;
  selectedPaperId?: string;
  selectedCollectionId: string;
  fileDataById: Record<string, Uint8Array>;
  fileStorageDirectory?: string;
  pdfViewStates: Record<string, PdfReaderViewState>;
  pdfSearchQuery?: string;
  onPdfSearchUpdate?: (state: { totalMatches: number; activeMatchIndex: number }) => void;
  pdfSearchNavRef?: React.MutableRefObject<PdfSearchNavHandle | null>;
  onSelectPaper: (paperId: string) => void;
  onOpenPaper: (paperId: string) => void;
  onUpdatePaper: (paper: Paper) => void;
  onPaperDragStart: (paperId: string) => void;
  onPaperDragMove: (paperId: string, collectionId?: string) => void;
  onPaperDragEnd: (paperId: string, collectionId?: string) => void;
  onRemovePaperFromCollection: (paperId: string) => void;
  onDeletePaper: (paperId: string) => void;
  onRestorePaper: (paperId: string) => void;
  onPermanentlyDeletePaper: (paperId: string) => void;
  onBindLocalPdf: (paperId: string) => void;
  onUpdatePdfViewState: (paperId: string, viewState: PdfReaderViewState) => void;
  onCreateAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
}) {
  if (tab.kind === "documents") {
    return (
      <PaperList
        state={library}
        papers={filteredPapers}
        searchMeta={searchMeta}
        selectedPaperId={selectedPaperId}
        selectedCollectionId={selectedCollectionId}
        onSelectPaper={onSelectPaper}
        onOpenPaper={onOpenPaper}
        onUpdatePaper={onUpdatePaper}
        onPaperDragStart={onPaperDragStart}
        onPaperDragMove={onPaperDragMove}
        onPaperDragEnd={onPaperDragEnd}
        onRemovePaperFromCollection={onRemovePaperFromCollection}
        onDeletePaper={onDeletePaper}
        onRestorePaper={onRestorePaper}
        onPermanentlyDeletePaper={onPermanentlyDeletePaper}
        onBindLocalPdf={onBindLocalPdf}
      />
    );
  }

  if (tab.kind === "notebook") {
    return (
      <NotebookPanel
        papers={library.papers.filter((paper) => !paper.deletedAt)}
        annotations={library.annotations}
        onOpenPaper={onOpenPaper}
      />
    );
  }

  const paper = library.papers.find((item) => item.id === tab.paperId && !item.deletedAt);
  const fileAsset = paper
    ? library.fileAssets.find((item) => item.paperId === paper.id && !item.deletedAt && isLocalPdfFile(item))
      ?? library.fileAssets.find((item) => item.paperId === paper.id && !item.deletedAt && isPdfFile(item))
    : undefined;
  const fileData = fileAsset ? fileDataById[fileAsset.id] : undefined;
  const annotations = paper
    ? library.annotations.filter((annotation) => annotation.paperId === paper.id)
    : [];

  return (
    <PdfReader
      paper={paper}
      fileAsset={fileAsset}
      fileData={fileData}
      fileStorageDirectory={fileStorageDirectory}
      annotations={annotations}
      active={active}
      viewState={pdfViewStates[tab.paperId]}
      onViewStateChange={(viewState) => onUpdatePdfViewState(tab.paperId, viewState)}
      onCreateAnnotation={onCreateAnnotation}
      onDeleteAnnotation={onDeleteAnnotation}
      pdfSearchQuery={pdfSearchQuery}
      onPdfSearchUpdate={onPdfSearchUpdate}
      searchNavRef={pdfSearchNavRef}
    />
  );
}

function CollapsedPanelGutter({
  panel,
  onRestorePanel
}: {
  panel: MainPanelKey;
  onRestorePanel: (panel: MainPanelKey) => void;
}) {
  const arrow = panel === "sync" ? "◀" : "▶";
  return (
    <button
      type="button"
      className={`collapsed-gutter panel-${panel}`}
      onClick={() => onRestorePanel(panel)}
      aria-label={`Restore ${panel} panel`}
      title={`Restore ${panel}`}
    >
      <span>{arrow}</span>
    </button>
  );
}

function loadWorkspaceLayout(): WorkspaceLayout {
  const raw = localStorage.getItem(workspaceLayoutKey);
  if (!raw) {
    return defaultWorkspaceLayout;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceLayout>;
    const layout = {
      widths: {
        ...defaultWorkspaceLayout.widths,
        ...parsed.widths
      },
      visible: {
        ...defaultWorkspaceLayout.visible,
        ...parsed.visible
      }
    };
    localStorage.setItem(workspaceLayoutKey, JSON.stringify(layout));
    return layout;
  } catch {
    return defaultWorkspaceLayout;
  }
}

// Single-pass version of the per-collection count: the naive form rebuilt the
// active-paper set and rescanned every membership row once per collection,
// which is O(collections × (papers + memberships)) on every library change.
// Here the lookup tables are built once and each collection only unions the
// member lists of its subtree.
function getCollectionPaperCounts(state: LibraryState) {
  const activeCollections = state.collections.filter((collection) => !collection.deletedAt);
  const activePaperIds = new Set(
    state.papers.filter((paper) => !paper.deletedAt).map((paper) => paper.id)
  );

  const directMemberIdsByCollection = new Map<string, string[]>();
  for (const item of state.paperCollections) {
    if (item.deletedAt || !activePaperIds.has(item.paperId)) {
      continue;
    }
    const members = directMemberIdsByCollection.get(item.collectionId);
    if (members) {
      members.push(item.paperId);
    } else {
      directMemberIdsByCollection.set(item.collectionId, [item.paperId]);
    }
  }

  const childIdsByParent = new Map<string, string[]>();
  for (const collection of activeCollections) {
    if (!collection.parentId) {
      continue;
    }
    const children = childIdsByParent.get(collection.parentId);
    if (children) {
      children.push(collection.id);
    } else {
      childIdsByParent.set(collection.parentId, [collection.id]);
    }
  }

  return Object.fromEntries(
    activeCollections.map((collection) => {
      // Walk the subtree iteratively; the visited set also guards against
      // accidental parentId cycles.
      const subtree = [collection.id];
      const visited = new Set(subtree);
      for (let cursor = 0; cursor < subtree.length; cursor += 1) {
        for (const childId of childIdsByParent.get(subtree[cursor]) ?? []) {
          if (!visited.has(childId)) {
            visited.add(childId);
            subtree.push(childId);
          }
        }
      }
      const countedPaperIds = new Set<string>();
      for (const collectionId of subtree) {
        for (const paperId of directMemberIdsByCollection.get(collectionId) ?? []) {
          countedPaperIds.add(paperId);
        }
      }
      return [collection.id, countedPaperIds.size];
    })
  );
}
