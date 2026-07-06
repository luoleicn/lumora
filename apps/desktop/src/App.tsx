import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, Collection, FileAsset, LibraryState, Paper } from "@lumora/shared";
import { FileText, X } from "lucide-react";
import { AppToolbar } from "./components/AppToolbar";
import { CollectionModal, DeleteCollectionModal } from "./components/CollectionModal";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { ManualReferenceModal, type ManualReferenceDraft } from "./components/ManualReferenceModal";
import { NotebookPanel } from "./components/NotebookPanel";
import { PaperList } from "./components/PaperList";
import { PdfReader } from "./components/PdfReader";
import { SyncPanel } from "./components/SyncPanel";
import { createId } from "./lib/id";
import { addPaperToCollection, deleteCollectionAndReassignPapers, getCollectionAndDescendantIds } from "./lib/libraryActions";
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
  const [search, setSearch] = useState("");
  const [fileData, setFileData] = useState<Uint8Array>();
  const [settings, setSettings] = useState<SyncSettings>(() => loadSyncSettings());
  const [workspaceLayout, setWorkspaceLayout] = useState<WorkspaceLayout>(() => loadWorkspaceLayout());
  const [resizeDrag, setResizeDrag] = useState<ResizeDrag>();
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [collectionModalParentId, setCollectionModalParentId] = useState<string | undefined>();
  const [collectionModalOpen, setCollectionModalOpen] = useState(false);
  const [deleteCollectionId, setDeleteCollectionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();

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
      const detailsShortcut = event.key.toLowerCase() === "i"
        && (isApplePlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
        && !event.altKey
        && !event.shiftKey;

      if (!detailsShortcut) {
        return;
      }

      event.preventDefault();
      setWorkspaceLayout((current) => ({
        ...current,
        visible: {
          ...current.visible,
          sync: !current.visible.sync
        }
      }));
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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

  useEffect(() => {
    let cancelled = false;
    setFileData(undefined);

    if (!selectedFile) {
      return;
    }

    getFileBytes(selectedFile.id).then((bytes) => {
      if (!cancelled) {
        setFileData(bytes);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedFile?.id]);

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
    const nextLibrary = addPaperToCollection(library, paperId, collectionId);
    const added = nextLibrary !== library;
    setLibrary(nextLibrary);
    const paper = library.papers.find((item) => item.id === paperId);
    const collection = library.collections.find((item) => item.id === collectionId);
    setStatus(added
      ? `Added ${paper?.title ?? "paper"} to ${collection?.name ?? "folder"}.`
      : "Paper is already in that folder."
    );
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
              selectedCollectionId={selectedCollectionId}
              selectedAuthor={selectedAuthor}
              selectedTag={selectedTag}
              onSelectCollection={setSelectedCollectionId}
              onSelectAuthor={setSelectedAuthor}
              onSelectTag={setSelectedTag}
              onCreateCollection={handleCreateCollection}
              onDeleteCollection={handleRequestDeleteCollection}
              onAddPaperToCollection={handleAddPaperToCollection}
            />
          )}

          {panel === "workspace" && (
            <WorkspaceTabs
              tabs={workspaceTabs}
              activeTabId={activeWorkspaceTabId}
              onSelectTab={(tab) => {
                setActiveWorkspaceTabId(tab.id);
                if (tab.kind === "paper") {
                  handleSelectPaper(tab.paperId);
                }
              }}
              onCloseTab={handleCloseWorkspaceTab}
            >
              <WorkspaceTabContent
                activeTab={workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? documentsTab}
                library={library}
                filteredPapers={filteredPapers}
                selectedPaperId={selectedPaperId}
                selectedPaper={selectedPaper}
                selectedFile={selectedFile}
                fileData={fileData}
                selectedAnnotations={selectedAnnotations}
                onSelectPaper={handleSelectPaper}
                onOpenPaper={handleOpenPaperTab}
                onUpdatePaper={handleUpdatePaper}
                onCreateAnnotation={handleCreateAnnotation}
                onDeleteAnnotation={handleDeleteAnnotation}
              />
            </WorkspaceTabs>
          )}

          {panel === "sync" && (
            <SyncPanel
              settings={settings}
              busy={busy}
              status={status}
              paper={selectedPaper}
              fileAsset={selectedFile}
              fileData={fileData}
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
  activeTab,
  library,
  filteredPapers,
  selectedPaperId,
  selectedPaper,
  selectedFile,
  fileData,
  selectedAnnotations,
  onSelectPaper,
  onOpenPaper,
  onUpdatePaper,
  onCreateAnnotation,
  onDeleteAnnotation
}: {
  activeTab: WorkspaceTab;
  library: LibraryState;
  filteredPapers: Paper[];
  selectedPaperId?: string;
  selectedPaper?: Paper;
  selectedFile?: FileAsset;
  fileData?: Uint8Array;
  selectedAnnotations: Annotation[];
  onSelectPaper: (paperId: string) => void;
  onOpenPaper: (paperId: string) => void;
  onUpdatePaper: (paper: Paper) => void;
  onCreateAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
}) {
  if (activeTab.kind === "documents") {
    return (
      <PaperList
        state={library}
        papers={filteredPapers}
        selectedPaperId={selectedPaperId}
        onSelectPaper={onSelectPaper}
        onOpenPaper={onOpenPaper}
        onUpdatePaper={onUpdatePaper}
      />
    );
  }

  if (activeTab.kind === "notebook") {
    return (
      <NotebookPanel
        papers={library.papers.filter((paper) => !paper.deletedAt)}
        annotations={library.annotations}
        onOpenPaper={onOpenPaper}
      />
    );
  }

  return (
    <PdfReader
      paper={selectedPaper}
      fileAsset={selectedFile}
      fileData={fileData}
      annotations={selectedAnnotations}
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
