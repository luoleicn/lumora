// PdfReader stores its find-navigation callbacks on the reader-body DOM element
// so the parent can drive next/prev from toolbar buttons without threading refs
// through the React memo comparison.
declare global {
  interface HTMLDivElement {
    __pdfSearchNav?: {
      goToNextFindMatch: () => void;
      goToPrevFindMatch: () => void;
    };
  }
}

import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import type { Annotation, Collection, FileAsset, LibraryState, Paper } from "@lumora/shared";
import { FileText, X } from "lucide-react";
import { AppToolbar } from "./components/AppToolbar";
import { CollectionModal, DeleteCollectionModal, RenameCollectionModal } from "./components/CollectionModal";
import { LibrarySidebar, type LibrarySyncActivity } from "./components/LibrarySidebar";
import { ManualReferenceModal, type ManualReferenceDraft } from "./components/ManualReferenceModal";
import { ShortcutsHelpModal } from "./components/ShortcutsHelpModal";
import { AboutModal } from "./components/AboutModal";
import { NotebookPanel } from "./components/NotebookPanel";
import { PaperList } from "./components/PaperList";
import { PdfReader, type PdfReaderViewState } from "./components/PdfReader";
import { SyncPanel } from "./components/SyncPanel";
import { createId } from "./lib/id";
import {
  addPaperToCollection,
  deleteCollectionAndReassignPapers,
  deletePaperFromLibrary,
  getCollectionAndDescendantIds,
  getCollectionPaperCount,
  removePaperFromCollectionTree,
  renameCollection,
  restorePaperFromTrash,
  permanentlyDeletePaperFromTrash
} from "./lib/libraryActions";
import {
  loadLibraryState,
  deleteFileBlob,
  markAnnotationDeleted,
  saveLibraryState,
  upsertById
} from "./lib/localStore";
import { deletePersistedEntities, enqueueLibraryPersist, importStateToDb, loadLibraryFromDb } from "./lib/libraryDb";
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
  saveFileStorageSettings,
  type FileStorageSettings
} from "./lib/fileStorage";
import { FileStorageSettingsModal } from "./components/FileStorageSettingsModal";
import { MendeleySyncModal } from "./components/MendeleySyncModal";
import { ProxySettingsModal } from "./components/ProxySettingsModal";
import { DuplicateDocumentsModal } from "./components/DuplicateDocumentsModal";
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
import { downloadMissingArxivFiles, formatFileSize, type ArxivDownloadProgress } from "./lib/arxivFiles";
import { defaultProxySettings, loadProxySettings, saveProxySettings, type ProxySettings } from "./lib/proxySettings";
import {
  login,
  syncLibrary,
  type SyncSettings
} from "./lib/syncClient";
import {
  connectMendeley,
  disconnectMendeley,
  getMendeleyConnection,
  loadMendeleySettings,
  mergeBackgroundSyncState,
  saveMendeleySettings,
  syncWithMendeley,
  MendeleySyncCancelledError,
  type MendeleyConnection,
  type MendeleySyncProgress,
  type MendeleySettings
} from "./lib/mendeleyClient";

const settingsKey = "lumora:sync-settings";
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

type WorkspaceTab =
  | { id: "documents"; kind: "documents"; title: "Documents" }
  | { id: "notebook"; kind: "notebook"; title: "Notebook" }
  | { id: string; kind: "paper"; paperId: string; title: string };

const documentsTab: WorkspaceTab = { id: "documents", kind: "documents", title: "Documents" };

function isPdfFile(fileAsset: FileAsset) {
  return fileAsset.mime === "application/pdf" || /\.pdf$/i.test(fileAsset.fileName);
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const bindPdfInputRef = useRef<HTMLInputElement>(null);
  const bindPdfPaperIdRef = useRef<string | undefined>(undefined);
  const importTargetCollectionIdRef = useRef<string | undefined>(undefined);
  const pdfRenameInFlightRef = useRef(false);
  const mendeleyCancelRequestedRef = useRef(false);
  const arxivDownloadInFlightRef = useRef(false);
  const libraryRef = useRef<LibraryState | undefined>(undefined);
  const lastPersistedLibraryRef = useRef<LibraryState | undefined>(undefined);
  const libraryLoadedRef = useRef(false);
  const localStorageFallbackRef = useRef(false);
  const [library, setLibrary] = useState<LibraryState>(() => loadLibraryState());
  const [selectedCollectionId, setSelectedCollectionId] = useState("all");
  const [selectedAuthor, setSelectedAuthor] = useState<string>();
  const [selectedTag, setSelectedTag] = useState<string>();
  const [selectedPaperId, setSelectedPaperId] = useState<string>();
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([documentsTab]);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState(documentsTab.id);
  const [pdfViewStates, setPdfViewStates] = useState<Record<string, PdfReaderViewState>>({});
  const [search, setSearch] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>();
  const [pdfSearchQuery, setPdfSearchQuery] = useState("");
  const [pdfSearchState, setPdfSearchState] = useState({ totalMatches: 0, activeMatchIndex: -1 });
  const backfillRunningRef = useRef(false);
  const [fileDataById, setFileDataById] = useState<Record<string, Uint8Array>>({});
  const [settings, setSettings] = useState<SyncSettings>(() => loadSyncSettings());
  const [fileStorageSettings, setFileStorageSettings] = useState<FileStorageSettings>(() => loadFileStorageSettings());
  const [fileStorageModalOpen, setFileStorageModalOpen] = useState(false);
  const [mendeleySyncOpen, setMendeleySyncOpen] = useState(false);
  const [proxySettingsOpen, setProxySettingsOpen] = useState(false);
  const [duplicateDocumentsOpen, setDuplicateDocumentsOpen] = useState(false);
  const [proxySettings, setProxySettings] = useState<ProxySettings>(defaultProxySettings);
  const [proxySettingsBusy, setProxySettingsBusy] = useState(false);
  const [proxySettingsError, setProxySettingsError] = useState<string>();
  const [mendeleySettings, setMendeleySettings] = useState<MendeleySettings>(() => loadMendeleySettings());
  const [mendeleyConnection, setMendeleyConnection] = useState<MendeleyConnection>();
  const [mendeleySyncBusy, setMendeleySyncBusy] = useState(false);
  const [arxivDownloadBusy, setArxivDownloadBusy] = useState(false);
  const [mendeleySyncActivity, setMendeleySyncActivity] = useState<LibrarySyncActivity>();
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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const collectionPaperCounts = useMemo(() => getCollectionPaperCounts(library), [library]);

  useEffect(() => {
    libraryRef.current = library;
  }, [library]);

  useEffect(() => {
    void loadProxySettings().then(setProxySettings).catch((error) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  }, []);

  // Startup: SQLite is the source of truth. When it is empty this is a first
  // run on the new storage layer, so the legacy localStorage state (already in
  // React state) is imported once; localStorage is kept untouched as a backup
  // but never written again.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { state: dbState, empty } = await loadLibraryFromDb();
        if (cancelled) {
          return;
        }

        if (!empty) {
          lastPersistedLibraryRef.current = dbState;
          libraryLoadedRef.current = true;
          setLibrary(dbState);
          return;
        }

        const legacyState = libraryRef.current ?? library;
        await importStateToDb(legacyState);
        if (cancelled) {
          return;
        }
        lastPersistedLibraryRef.current = legacyState;
        libraryLoadedRef.current = true;
      } catch (error) {
        // Without a working database, fall back to the legacy localStorage
        // persistence for this session rather than silently losing edits.
        localStorageFallbackRef.current = true;
        setStatus(`Library database unavailable, falling back to browser storage: ${error}`);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!libraryLoadedRef.current) {
      if (localStorageFallbackRef.current) {
        saveLibraryState(library);
      }
      return;
    }

    const previous = lastPersistedLibraryRef.current;
    if (!previous || previous === library) {
      return;
    }

    lastPersistedLibraryRef.current = library;
    void enqueueLibraryPersist(previous, library, (error) => {
      setStatus(`Failed to save library: ${error}`);
    });
  }, [library]);

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify({ ...settings, password: settings.password ? settings.password : "" }));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(workspaceLayoutKey, JSON.stringify(workspaceLayout));
  }, [workspaceLayout]);

  useEffect(() => {
    saveFileStorageSettings(fileStorageSettings);
  }, [fileStorageSettings]);

  useEffect(() => {
    saveMendeleySettings(mendeleySettings);
  }, [mendeleySettings]);

  useEffect(() => {
    if (!mendeleySyncOpen) {
      return;
    }

    void getMendeleyConnection().then(setMendeleyConnection).catch(() => setMendeleyConnection(undefined));
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

      // Cmd+F / Ctrl+F on a paper tab: focus the global search bar which acts as
      // the find-in-document bar. WKWebView may intercept this on macOS before
      // the DOM sees it; the contextual toolbar (auto-switch to PDF find mode)
      // covers the macOS case.
      const isFindShortcut = event.key.toLowerCase() === "f"
        && usesPrimaryModifier
        && !event.altKey
        && !event.shiftKey;
      if (isFindShortcut) {
        const activeTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId);
        if (activeTab?.kind === "paper") {
          event.preventDefault();
          const toolbarInput = document.querySelector<HTMLInputElement>(".app-toolbar input[type='text']");
          toolbarInput?.focus();
          toolbarInput?.select();
          return;
        }
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

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<string>(workspaceCommandEvent, (event) => {
      if (event.payload === "close-active-tab") {
        handleCloseActiveWorkspaceTab();
      } else if (event.payload === "show-shortcuts-help") {
        setShortcutsHelpOpen(true);
      } else if (event.payload === "show-about") {
        setAboutOpen(true);
      } else if (event.payload === "show-file-storage-settings") {
        setFileStorageModalOpen(true);
      } else if (event.payload === "show-mendeley-sync") {
        setMendeleySyncOpen(true);
      } else if (event.payload === "show-proxy-settings") {
        setProxySettingsError(undefined);
        setProxySettingsOpen(true);
      } else if (event.payload === "show-duplicate-documents") {
        setDuplicateDocumentsOpen(true);
      } else if (event.payload === "download-arxiv-files") {
        void handleDownloadArxivFiles();
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
  }, [activeWorkspaceTabId, workspaceTabs, fileStorageSettings]);

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

    return library.papers
      .filter((paper) => isTrash ? Boolean(paper.deletedAt) : !paper.deletedAt)
      .filter((paper) => {
        switch (selectedCollectionId) {
          case "all":
            return true;
          case "recently_added":
            return true;
          case "favorites":
            return Boolean(paper.favorite);
          case "unsorted":
            return !library.paperCollections.some((item) => item.paperId === paper.id && !item.deletedAt);
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
    ? library.fileAssets.find((fileAsset) => fileAsset.paperId === selectedPaper.id && !fileAsset.deletedAt)
    : undefined;
  const selectedAnnotations = selectedPaper
    ? library.annotations.filter((annotation) => annotation.paperId === selectedPaper.id)
    : [];
  const selectedFileData = selectedFile ? fileDataById[selectedFile.id] : undefined;
  const selectedHasLocalPdf = selectedPaper
    ? library.fileAssets.some((fileAsset) =>
      fileAsset.paperId === selectedPaper.id
      && !fileAsset.deletedAt
      && isPdfFile(fileAsset)
      && Boolean(fileDataById[fileAsset.id]?.length)
    )
    : false;
  const activeWorkspaceTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? documentsTab;
  const searchMode = activeWorkspaceTab.kind === "paper" ? "pdf" as const : "library" as const;

  // Clear PDF search when switching away from a paper tab.
  useEffect(() => {
    if (activeWorkspaceTab.kind !== "paper") {
      setPdfSearchQuery("");
      setPdfSearchState({ totalMatches: 0, activeMatchIndex: -1 });
    }
  }, [activeWorkspaceTabId]);

  const openPaperFileIds = useMemo(() => {
    const fileIds = workspaceTabs.flatMap((tab) => {
      if (tab.kind !== "paper") {
        return [];
      }

      const paper = library.papers.find((item) => item.id === tab.paperId && !item.deletedAt);
      const fileAsset = paper
        ? library.fileAssets.find((item) => item.paperId === paper.id && !item.deletedAt)
        : undefined;
      return fileAsset ? [fileAsset.id] : [];
    });

    // The Details panel (Extract PDF, metadata preview) needs bytes for the
    // selected paper even when its reader tab isn't open.
    const selectedFileIds = selectedPaperId
      ? library.fileAssets
        .filter((item) => item.paperId === selectedPaperId && !item.deletedAt && isPdfFile(item))
        .map((item) => item.id)
      : [];
    for (const selectedFileId of selectedFileIds) {
      if (!fileIds.includes(selectedFileId)) {
        fileIds.push(selectedFileId);
      }
    }

    return fileIds;
  }, [library.fileAssets, library.papers, selectedPaperId, workspaceTabs]);

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
        const next = { ...current };
        for (const loadedFile of loadedFiles) {
          if (loadedFile?.bytes) {
            next[loadedFile.fileId] = loadedFile.bytes;
          }
        }
        return next;
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

    return library.fileAssets
      .filter((fileAsset) => !fileAsset.deletedAt && fileAsset.localPath)
      .map((fileAsset) => {
        const paper = library.papers.find((item) => item.id === fileAsset.paperId && !item.deletedAt);
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

  function handleOpenPaperTab(paperId: string) {
    const paper = library.papers.find((item) => item.id === paperId && !item.deletedAt);
    if (!paper) {
      return;
    }

    handleSelectPaper(paperId);
    const tabId = `paper:${paperId}`;
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
      handleSelectPaper(tab.paperId);
    }
  }

  function handleUpdatePdfViewState(paperId: string, viewState: PdfReaderViewState) {
    setPdfViewStates((current) => {
      const previous = current[paperId];
      if (previous?.scrollTop === viewState.scrollTop && previous.zoom === viewState.zoom) {
        return current;
      }

      return {
        ...current,
        [paperId]: viewState
      };
    });
  }

  function handleUpdatePaper(paper: Paper) {
    setWorkspaceTabs((current) => current.map((tab) =>
      tab.kind === "paper" && tab.paperId === paper.id ? { ...tab, title: paper.title } : tab
    ));
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

  async function handleDownloadArxivFiles(
    paperId?: string,
    detailProgress?: (progress: ArxivDownloadProgress) => void
  ): Promise<string> {
    if (arxivDownloadInFlightRef.current) {
      const message = "arXiv file download is already running.";
      setStatus(message);
      return message;
    }
    arxivDownloadInFlightRef.current = true;
    setArxivDownloadBusy(true);
    const startingState = libraryRef.current ?? library;
    const startingFiles = new Map(startingState.fileAssets.map((file) => [file.id, file]));
    try {
      const result = await downloadMissingArxivFiles(startingState, fileStorageSettings, {
        paperIds: paperId ? [paperId] : undefined,
        onProgress: (progress) => {
          detailProgress?.(progress);
          const position = Math.min(progress.total, progress.done + (progress.phase === "downloading" ? 1 : 0));
          const byteProgress = progress.downloadedBytes !== undefined
            ? ` — ${formatFileSize(progress.downloadedBytes)}${progress.totalBytes ? ` / ${formatFileSize(progress.totalBytes)}` : ""}`
            : "";
          setStatus(progress.total === 0
            ? "No missing arXiv PDFs found."
            : `${progress.phase === "checking" ? "Checking" : progress.phase === "waiting" ? "Waiting for arXiv" : "Downloading arXiv PDF"} `
              + `(${position}/${progress.total})${progress.arxivId ? `: ${progress.arxivId}` : ""}${byteProgress}`);
        },
        onStateUpdate: (partialState) => {
          const downloadedFiles = partialState.fileAssets.filter((file) => {
            const before = startingFiles.get(file.id);
            return !before || before.sha256 !== file.sha256 || before.downloadState !== file.downloadState || before.localPath !== file.localPath;
          });
          setLibrary((current) => ({
            ...current,
            fileAssets: downloadedFiles.reduce((items, file) => upsertById(items, file), current.fileAssets)
          }));
        }
      });
      const message =
        `arXiv files: ${result.downloaded} downloaded, ${result.alreadyPresent} already present`
        + (result.failed.length ? `, ${result.failed.length} failed (${result.failed.map((item) => item.arxivId).join(", ")}).` : ".");
      setStatus(message);
      return message;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      return message;
    } finally {
      arxivDownloadInFlightRef.current = false;
      setArxivDownloadBusy(false);
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

  async function handleLogin() {
    await runBusy("Logged in.", async () => {
      const response = await login(settings);
      setSettings((current) => ({ ...current, token: response.accessToken }));
    });
  }

  async function handleSync() {
    await runBusy("Sync complete.", async () => {
      const nextState = await syncLibrary(settings, library);
      setLibrary(nextState);
    });
  }

  async function handleMendeleyConnect() {
    setBusy(true);
    setStatus("Waiting for Mendeley authorization in the browser...");
    try {
      const connection = await connectMendeley(mendeleySettings);
      setMendeleyConnection(connection);
      setStatus(connection.displayName ? `Connected to Mendeley as ${connection.displayName}.` : "Connected to Mendeley.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleMendeleyDisconnect() {
    await runBusy("Disconnected from Mendeley.", async () => {
      await disconnectMendeley();
      setMendeleyConnection({ connected: false });
    });
  }

  async function handleMendeleySync() {
    if (mendeleySyncBusy) {
      return;
    }
    const syncStartedAt = new Date().toISOString();
    const baseState = libraryRef.current ?? library;
    let mergeBaseState = baseState;
    mendeleyCancelRequestedRef.current = false;
    setMendeleySyncBusy(true);
    setMendeleySyncActivity({ state: "running", message: "Starting Mendeley sync…", completed: 0, total: 8 });
    setStatus("Syncing with Mendeley...");
    try {
      const { state: nextState, summary } = await syncWithMendeley(
        baseState,
        mendeleySettings,
        fileStorageSettings,
        (progress: MendeleySyncProgress) => {
          setMendeleySyncActivity({
            state: "running",
            message: progress.message,
            completed: progress.completed,
            total: progress.total
          });
        },
        {
          isCancelled: () => mendeleyCancelRequestedRef.current,
          onStateUpdate: (partialState) => {
            const previousMergeBase = mergeBaseState;
            mergeBaseState = partialState;
            setLibrary((current) => mergeBackgroundSyncState(previousMergeBase, partialState, current, syncStartedAt));
          }
        }
      );
      setLibrary((current) => mergeBackgroundSyncState(mergeBaseState, nextState, current, syncStartedAt));
      const completionMessage =
        `Mendeley sync complete: ${summary.pulled} pulled, ${summary.pushed} pushed, `
        + `${summary.folders} folders, ${summary.folderLinks} folder links, ${summary.files} files, `
        + `${summary.annotations} annotations; ${summary.deletedLocally} deleted locally, `
        + `${summary.deletedRemotely} deleted remotely.`
        + (summary.unavailableResources.length
          ? ` Mendeley did not expose: ${summary.unavailableResources.join(", ")}.`
          : "");
      setStatus(completionMessage);
      setMendeleySyncActivity({
        state: "success",
        message: `${summary.pulled} papers, ${summary.folders} folders, ${summary.files} files, ${summary.annotations} annotations`,
        completed: 8,
        total: 8
      });
    } catch (error) {
      if (error instanceof MendeleySyncCancelledError) {
        setStatus("Mendeley sync cancelled.");
        setMendeleySyncActivity((current) => ({
          state: "cancelled",
          message: "Sync cancelled",
          completed: current?.completed ?? 0,
          total: current?.total ?? 8
        }));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      setMendeleySyncActivity({ state: "error", message, completed: 0, total: 8 });
    } finally {
      setMendeleySyncBusy(false);
    }
  }

  function handleCancelMendeleySync() {
    if (!mendeleySyncBusy) return;
    mendeleyCancelRequestedRef.current = true;
    setMendeleySyncActivity((current) => current ? {
      ...current,
      message: "Cancelling after the current request…"
    } : current);
  }

  async function runBusy(successMessage: string, task: () => Promise<void>) {
    setBusy(true);
    setStatus(undefined);
    try {
      await task();
      setStatus(successMessage);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusy(false);
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
        onPdfSearchNext={() => {
          const el = document.querySelector<HTMLDivElement>(".reader-body");
          el?.__pdfSearchNav?.goToNextFindMatch();
        }}
        onPdfSearchPrev={() => {
          const el = document.querySelector<HTMLDivElement>(".reader-body");
          el?.__pdfSearchNav?.goToPrevFindMatch();
        }}
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
              onSelectCollection={setSelectedCollectionId}
              onSelectAuthor={setSelectedAuthor}
              onSelectTag={setSelectedTag}
              onCreateCollection={handleCreateCollection}
              onRenameCollection={handleRequestRenameCollection}
              onDeleteCollection={handleRequestDeleteCollection}
              onAddPaperToCollection={handleAddPaperToCollection}
              onAddPdfToCollection={handleAddPdfToCollection}
              onSync={handleSync}
              syncBusy={busy}
              mendeleySyncActivity={mendeleySyncActivity}
              onCancelMendeleySync={handleCancelMendeleySync}
            />
          )}

          {panel === "workspace" && (
            <WorkspaceTabs
              tabs={workspaceTabs}
              activeTabId={activeWorkspaceTabId}
              onSelectTab={handleActivateWorkspaceTab}
              onCloseTab={handleCloseWorkspaceTab}
            >
              {workspaceTabs.map((tab) => (
                <div
                  key={tab.id}
                  className={tab.id === activeWorkspaceTabId ? "workspace-tab-pane active" : "workspace-tab-pane"}
                  aria-hidden={tab.id !== activeWorkspaceTabId}
                  role="tabpanel"
                >
                  <WorkspaceTabContent
                    active={tab.id === activeWorkspaceTabId}
                    tab={tab}
                    library={library}
                    filteredPapers={displayedPapers}
                    searchMeta={searchMetaByPaperId}
                    selectedPaperId={selectedPaperId}
                    selectedCollectionId={selectedCollectionId}
                    fileDataById={fileDataById}
                    pdfViewStates={pdfViewStates}
                    pdfSearchQuery={searchMode === "pdf" ? pdfSearchQuery : undefined}
                    onPdfSearchUpdate={setPdfSearchState}
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
              ))}
            </WorkspaceTabs>
          )}

          {panel === "sync" && (
            <SyncPanel
              settings={settings}
              busy={busy}
              status={status}
              paper={selectedPaper}
              fileAsset={selectedFile}
              fileData={selectedFileData}
              hasLocalPdf={selectedHasLocalPdf}
              annotations={selectedAnnotations}
              onSettingsChange={setSettings}
              onLogin={handleLogin}
              onSync={handleSync}
              onUpdatePaper={handleUpdatePaper}
              arxivDownloadBusy={arxivDownloadBusy}
              onDownloadArxiv={(paperId, onProgress) => handleDownloadArxivFiles(paperId, onProgress)}
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

      <ManualReferenceModal
        open={manualModalOpen}
        onClose={() => setManualModalOpen(false)}
        onSave={handleCreateManualReference}
      />
      <ShortcutsHelpModal open={shortcutsHelpOpen} onClose={() => setShortcutsHelpOpen(false)} />
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <FileStorageSettingsModal
        open={fileStorageModalOpen}
        settings={fileStorageSettings}
        previewPaper={selectedPaper ?? library.papers.find((paper) => !paper.deletedAt)}
        busy={fileStorageBusy}
        onClose={() => setFileStorageModalOpen(false)}
        onSave={(nextSettings) => void handleSaveFileStorageSettings(nextSettings)}
      />
      <MendeleySyncModal
        open={mendeleySyncOpen}
        settings={mendeleySettings}
        connection={mendeleyConnection}
        busy={busy}
        syncing={mendeleySyncBusy}
        status={status}
        onSettingsChange={setMendeleySettings}
        onConnect={() => void handleMendeleyConnect()}
        onDisconnect={() => void handleMendeleyDisconnect()}
        onSync={() => void handleMendeleySync()}
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
  pdfViewStates,
  pdfSearchQuery,
  onPdfSearchUpdate,
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
  pdfViewStates: Record<string, PdfReaderViewState>;
  pdfSearchQuery?: string;
  onPdfSearchUpdate?: (state: { totalMatches: number; activeMatchIndex: number }) => void;
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
    ? library.fileAssets.find((item) => item.paperId === paper.id && !item.deletedAt)
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
      annotations={annotations}
      active={active}
      viewState={pdfViewStates[tab.paperId]}
      onViewStateChange={(viewState) => onUpdatePdfViewState(tab.paperId, viewState)}
      onCreateAnnotation={onCreateAnnotation}
      onDeleteAnnotation={onDeleteAnnotation}
      pdfSearchQuery={pdfSearchQuery}
      onPdfSearchUpdate={onPdfSearchUpdate}
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

function loadSyncSettings(): SyncSettings {
  const fallback = {
    serverUrl: "http://localhost:3838",
    email: "reader@example.com",
    password: "change-me"
  };

  const raw = localStorage.getItem(settingsKey);
  if (!raw) {
    return fallback;
  }

  try {
    const settings = { ...fallback, ...JSON.parse(raw) as SyncSettings };
    localStorage.setItem(settingsKey, JSON.stringify({ ...settings, password: settings.password ? settings.password : "" }));
    return settings;
  } catch {
    return fallback;
  }
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

function getCollectionPaperCounts(state: LibraryState) {
  const activeCollections = state.collections.filter((collection) => !collection.deletedAt);
  return Object.fromEntries(
    activeCollections.map((collection) => [collection.id, getCollectionPaperCount(state, activeCollections, collection.id)])
  );
}
