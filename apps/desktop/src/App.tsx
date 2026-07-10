import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import type { Annotation, Collection, FileAsset, LibraryState, Paper } from "@lumora/shared";
import { FileText, X } from "lucide-react";
import { AppToolbar } from "./components/AppToolbar";
import { CollectionModal, DeleteCollectionModal, RenameCollectionModal } from "./components/CollectionModal";
import { LibrarySidebar } from "./components/LibrarySidebar";
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
  renameCollection
} from "./lib/libraryActions";
import {
  getFileBytes,
  importPdfFile,
  loadLibraryState,
  markAnnotationDeleted,
  saveLibraryState,
  upsertById
} from "./lib/localStore";
import { parseReferenceFile } from "./lib/referenceImport";
import {
  login,
  mendeleyOAuthUrl,
  startMendeleyImport,
  syncLibrary,
  type SyncSettings
} from "./lib/syncClient";

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

export default function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [library, setLibrary] = useState<LibraryState>(() => loadLibraryState());
  const [selectedCollectionId, setSelectedCollectionId] = useState("all");
  const [selectedAuthor, setSelectedAuthor] = useState<string>();
  const [selectedTag, setSelectedTag] = useState<string>();
  const [selectedPaperId, setSelectedPaperId] = useState<string>();
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([documentsTab]);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState(documentsTab.id);
  const [pdfViewStates, setPdfViewStates] = useState<Record<string, PdfReaderViewState>>({});
  const [search, setSearch] = useState("");
  const [fileDataById, setFileDataById] = useState<Record<string, Uint8Array>>({});
  const [settings, setSettings] = useState<SyncSettings>(() => loadSyncSettings());
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
    saveLibraryState(library);
  }, [library]);

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify({ ...settings, password: settings.password ? settings.password : "" }));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(workspaceLayoutKey, JSON.stringify(workspaceLayout));
  }, [workspaceLayout]);

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
  }, [activeWorkspaceTabId, workspaceTabs]);

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
    const query = search.trim().toLowerCase();
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
      .filter((paper) => {
        if (!query) {
          return true;
        }

        const authors = paper.authors.map((author) => author.fullName).join(" ");
        const tags = paper.tags?.join(" ") ?? "";
        const keywords = paper.keywords?.join(" ") ?? "";
        return `${paper.title} ${authors} ${paper.venue ?? ""} ${paper.doi ?? ""} ${tags} ${keywords} ${paper.abstract ?? ""}`
          .toLowerCase()
          .includes(query);
      })
      .sort((a, b) => {
        if (selectedCollectionId === "recently_added") {
          return b.createdAt.localeCompare(a.createdAt);
        }

        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [library, search, selectedAuthor, selectedCollectionId, selectedTag]);

  const selectedPaper = library.papers.find((paper) => paper.id === selectedPaperId && !paper.deletedAt);
  const selectedFile = selectedPaper
    ? library.fileAssets.find((fileAsset) => fileAsset.paperId === selectedPaper.id && !fileAsset.deletedAt)
    : undefined;
  const selectedAnnotations = selectedPaper
    ? library.annotations.filter((annotation) => annotation.paperId === selectedPaper.id)
    : [];
  const selectedFileData = selectedFile ? fileDataById[selectedFile.id] : undefined;
  const activeWorkspaceTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? documentsTab;
  const openPaperFileIds = useMemo(() => workspaceTabs
    .flatMap((tab) => {
      if (tab.kind !== "paper") {
        return [];
      }

      const paper = library.papers.find((item) => item.id === tab.paperId && !item.deletedAt);
      const fileAsset = paper
        ? library.fileAssets.find((item) => item.paperId === paper.id && !item.deletedAt)
        : undefined;
      return fileAsset ? [fileAsset.id] : [];
    }), [library.fileAssets, library.papers, workspaceTabs]);

  useEffect(() => {
    let cancelled = false;

    const missingFileIds = openPaperFileIds.filter((fileId) => !fileDataById[fileId]);
    if (missingFileIds.length === 0) {
      return undefined;
    }

    void Promise.all(missingFileIds.map(async (fileId) => {
      const bytes = await getFileBytes(fileId);
      return bytes ? { fileId, bytes } : undefined;
    })).then((loadedFiles) => {
      if (cancelled) {
        return;
      }

      setFileDataById((current) => {
        const next = { ...current };
        for (const loadedFile of loadedFiles) {
          if (loadedFile) {
            next[loadedFile.fileId] = loadedFile.bytes;
          }
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [fileDataById, openPaperFileIds]);

  async function handleImportPdf(file?: File) {
    if (!file) {
      return;
    }

    const imported = await importPdfFile(library, file);
    setLibrary(imported.state);
    setSelectedPaperId(imported.paper.id);
    setSelectedCollectionId("all");
    setSelectedAuthor(undefined);
    setSelectedTag(undefined);
    setStatus(`Imported ${file.name}.`);
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

  function handleConnectMendeley() {
    try {
      window.open(mendeleyOAuthUrl(settings), "_blank", "noopener,noreferrer");
      setStatus("Opened Mendeley OAuth.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to open Mendeley OAuth.");
    }
  }

  async function handleImportMendeley() {
    await runBusy("Mendeley import started.", async () => {
      await startMendeleyImport(settings);
    });
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
        search={search}
        busy={busy}
        status={status}
        onSearchChange={setSearch}
        onAddPdf={() => fileInputRef.current?.click()}
        onAddManual={() => setManualModalOpen(true)}
        onImportReferences={() => referenceInputRef.current?.click()}
        onOpenNotebook={handleOpenNotebookTab}
        onCreateCollection={handleCreateCollection}
        onSync={handleSync}
        onConnectMendeley={handleConnectMendeley}
        onImportMendeley={handleImportMendeley}
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
              selectedAuthor={selectedAuthor}
              selectedTag={selectedTag}
              onSelectCollection={setSelectedCollectionId}
              onSelectAuthor={setSelectedAuthor}
              onSelectTag={setSelectedTag}
              onCreateCollection={handleCreateCollection}
              onRenameCollection={handleRequestRenameCollection}
              onDeleteCollection={handleRequestDeleteCollection}
              onAddPaperToCollection={handleAddPaperToCollection}
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
                    filteredPapers={filteredPapers}
                    selectedPaperId={selectedPaperId}
                    selectedCollectionId={selectedCollectionId}
                    fileDataById={fileDataById}
                    pdfViewStates={pdfViewStates}
                    onSelectPaper={handleSelectPaper}
                    onOpenPaper={handleOpenPaperTab}
                    onUpdatePaper={handleUpdatePaper}
                    onPaperDragStart={handlePaperDragStart}
                    onPaperDragMove={handlePaperDragMove}
                    onPaperDragEnd={handlePaperDragEnd}
                    onRemovePaperFromCollection={handleRemovePaperFromSelectedCollection}
                    onDeletePaper={handleDeletePaper}
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
              annotations={selectedAnnotations}
              onSettingsChange={setSettings}
              onLogin={handleLogin}
              onSync={handleSync}
              onConnectMendeley={handleConnectMendeley}
              onImportMendeley={handleImportMendeley}
              onUpdatePaper={handleUpdatePaper}
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
          void handleImportPdf(event.target.files?.[0]);
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
      </section>

      <ManualReferenceModal
        open={manualModalOpen}
        onClose={() => setManualModalOpen(false)}
        onSave={handleCreateManualReference}
      />
      <ShortcutsHelpModal open={shortcutsHelpOpen} onClose={() => setShortcutsHelpOpen(false)} />
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
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
  selectedPaperId,
  selectedCollectionId,
  fileDataById,
  pdfViewStates,
  onSelectPaper,
  onOpenPaper,
  onUpdatePaper,
  onPaperDragStart,
  onPaperDragMove,
  onPaperDragEnd,
  onRemovePaperFromCollection,
  onDeletePaper,
  onUpdatePdfViewState,
  onCreateAnnotation,
  onDeleteAnnotation
}: {
  active: boolean;
  tab: WorkspaceTab;
  library: LibraryState;
  filteredPapers: Paper[];
  selectedPaperId?: string;
  selectedCollectionId: string;
  fileDataById: Record<string, Uint8Array>;
  pdfViewStates: Record<string, PdfReaderViewState>;
  onSelectPaper: (paperId: string) => void;
  onOpenPaper: (paperId: string) => void;
  onUpdatePaper: (paper: Paper) => void;
  onPaperDragStart: (paperId: string) => void;
  onPaperDragMove: (paperId: string, collectionId?: string) => void;
  onPaperDragEnd: (paperId: string, collectionId?: string) => void;
  onRemovePaperFromCollection: (paperId: string) => void;
  onDeletePaper: (paperId: string) => void;
  onUpdatePdfViewState: (paperId: string, viewState: PdfReaderViewState) => void;
  onCreateAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
}) {
  if (tab.kind === "documents") {
    return (
      <PaperList
        state={library}
        papers={filteredPapers}
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
