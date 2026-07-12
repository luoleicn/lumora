import {
  AlertCircle,
  Archive,
  ChevronDown,
  ChevronRight,
  Clock,
  CircleCheck,
  CircleX,
  FilePlus,
  FileText,
  FileX,
  Folder,
  FolderPlus,
  Hash,
  Pencil,
  RefreshCw,
  Star,
  Tags,
  Trash2,
  UserRound,
  X,
  type LucideIcon
} from "lucide-react";
import type { Collection, LibraryState } from "@lumora/shared";
import { useEffect, useState } from "react";
import lumoraLogoUrl from "../assets/lumora-logo-64.png";
import { getActivePaperCollectionIds, sortCollectionsAlphabetically } from "../lib/libraryActions";

type LibrarySidebarProps = {
  state: LibraryState;
  collectionPaperCounts: Record<string, number>;
  dragOverCollectionId?: string;
  selectedCollectionId: string;
  selectedPaperId?: string;
  selectedAuthor?: string;
  selectedTag?: string;
  onSelectCollection: (id: string) => void;
  onSelectAuthor: (author?: string) => void;
  onSelectTag: (tag?: string) => void;
  onCreateCollection: (parentId?: string) => void;
  onRenameCollection: (collectionId: string) => void;
  onDeleteCollection: (collectionId: string) => void;
  onAddPaperToCollection: (paperId: string, collectionId: string) => void;
  onAddPdfToCollection: (collectionId: string) => void;
  onEmptyTrash: () => void;
  onSync: () => void;
  syncBusy: boolean;
  cloudSyncActivity?: LibrarySyncActivity;
  mendeleySyncActivity?: LibrarySyncActivity;
  onCancelMendeleySync: () => void;
  onCancelCloudSync: () => void;
  onDismissCloudSync: () => void;
};

export type LibrarySyncActivity = {
  state: "running" | "success" | "error" | "cancelled";
  message: string;
  completed: number;
  total: number;
};

type CollectionContextMenu = {
  x: number;
  y: number;
  collectionId: string;
  collectionName: string;
};

export function LibrarySidebar({
  state,
  collectionPaperCounts,
  dragOverCollectionId,
  selectedCollectionId,
  selectedPaperId,
  selectedAuthor,
  selectedTag,
  onSelectCollection,
  onSelectAuthor,
  onSelectTag,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onAddPaperToCollection,
  onAddPdfToCollection,
  onEmptyTrash,
  onSync,
  syncBusy,
  cloudSyncActivity,
  mendeleySyncActivity,
  onCancelMendeleySync,
  onCancelCloudSync,
  onDismissCloudSync
}: LibrarySidebarProps) {
  const [authorsExpanded, setAuthorsExpanded] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>({});
  const [nativeDragOverCollectionId, setNativeDragOverCollectionId] = useState<string>();
  const [contextMenu, setContextMenu] = useState<CollectionContextMenu>();
  const [trashContextMenu, setTrashContextMenu] = useState<{ x: number; y: number }>();

  useEffect(() => {
    if (!contextMenu && !trashContextMenu) {
      return;
    }

    const closeMenus = () => {
      setContextMenu(undefined);
      setTrashContextMenu(undefined);
    };
    window.addEventListener("click", closeMenus);
    window.addEventListener("keydown", closeMenus);
    window.addEventListener("scroll", closeMenus, true);
    return () => {
      window.removeEventListener("click", closeMenus);
      window.removeEventListener("keydown", closeMenus);
      window.removeEventListener("scroll", closeMenus, true);
    };
  }, [contextMenu, trashContextMenu]);
  const visibleDragOverCollectionId = dragOverCollectionId ?? nativeDragOverCollectionId;
  const collections = sortCollectionsAlphabetically(
    state.collections.filter((collection) => !collection.deletedAt)
  );
  const collectionTree = buildCollectionTree(collections);
  const selectedPaperCollectionIds = getActivePaperCollectionIds(state, selectedPaperId);
  const activePapers = state.papers.filter((paper) => !paper.deletedAt);
  const deletedPapers = state.papers.filter((paper) => paper.deletedAt);
  const unfiledPaperCount = activePapers.filter(
    (paper) => !state.paperCollections.some((item) => item.paperId === paper.id && !item.deletedAt)
  ).length;
  const noArxivCount = activePapers.filter((paper) => !paper.arxiv).length;
  const noPdfCount = activePapers.filter((paper) =>
    !state.fileAssets.some((file) => file.paperId === paper.id && !file.deletedAt
      && (file.mime === "application/pdf" || /\.pdf$/i.test(file.fileName))
      && file.downloadState === "local")
  ).length;
  const authors = [...new Set(activePapers.flatMap((paper) => paper.authors.map((author) => author.fullName)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const tags = [...new Set(activePapers.flatMap((paper) => paper.tags ?? []).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  return (
    <aside className="library-sidebar">
      <div className="app-title">
        <span className="brand-mark">
          <img src={lumoraLogoUrl} alt="" />
        </span>
        <div>
          <h1>lumora</h1>
          <p>lumora — light up your literature.</p>
          <small>{state.papers.filter((paper) => !paper.deletedAt).length} papers</small>
        </div>
      </div>

      <nav className="collection-nav" aria-label="Collections">
        <div className="nav-section">
          <h2>My Library</h2>
          <NavButton
            icon={FileText}
            label="All Documents"
            active={selectedCollectionId === "all"}
            count={activePapers.length}
            onClick={() => onSelectCollection("all")}
          />
          <NavButton
            icon={Clock}
            label="Recently Added"
            active={selectedCollectionId === "recently_added"}
            count={activePapers.length}
            onClick={() => onSelectCollection("recently_added")}
          />
          <NavButton
            icon={Hash}
            label="No arXiv ID"
            active={selectedCollectionId === "no_arxiv"}
            count={noArxivCount}
            onClick={() => onSelectCollection("no_arxiv")}
          />
          <NavButton
            icon={FileX}
            label="No PDF"
            active={selectedCollectionId === "no_pdf"}
            count={noPdfCount}
            onClick={() => onSelectCollection("no_pdf")}
          />
          <NavButton
            icon={Star}
            label="Favorites"
            active={selectedCollectionId === "favorites"}
            count={activePapers.filter((paper) => paper.favorite).length}
            onClick={() => onSelectCollection("favorites")}
          />
          <NavButton
            icon={Archive}
            label="Unsorted"
            active={selectedCollectionId === "unsorted"}
            count={unfiledPaperCount}
            onClick={() => onSelectCollection("unsorted")}
          />
        </div>

        <div className="nav-section">
          <h2>Folders</h2>
          <div className="collection-tree">
            {collectionTree.map((node) => (
              <CollectionTreeNode
                key={node.collection.id}
                node={node}
                depth={0}
                selectedCollectionId={selectedCollectionId}
                selectedPaperCollectionIds={selectedPaperCollectionIds}
                dragOverCollectionId={visibleDragOverCollectionId}
                collapsedCollections={collapsedCollections}
                getCount={(collectionId) => collectionPaperCounts[collectionId] ?? 0}
                onToggle={(collectionId) => {
                  setCollapsedCollections((current) => ({ ...current, [collectionId]: !current[collectionId] }));
                }}
                onSelectCollection={onSelectCollection}
                onAddPaperToCollection={onAddPaperToCollection}
                onDragOverCollection={setNativeDragOverCollectionId}
                onOpenContextMenu={setContextMenu}
              />
            ))}
          </div>
          <button className="new-folder-button inline" type="button" onClick={() => onCreateCollection()}>
            <FolderPlus size={16} />
            Create Top Folder...
          </button>
        </div>

        <div className="nav-section">
          <h2>Trash</h2>
          <NavButton
            icon={Trash2}
            label="All Deleted Documents"
            active={selectedCollectionId === "trash"}
            count={deletedPapers.length}
            onClick={() => onSelectCollection("trash")}
            onContextMenu={(event) => {
              if (deletedPapers.length === 0) return;
              event.preventDefault();
              setTrashContextMenu({ x: event.clientX, y: event.clientY });
            }}
          />
        </div>
      </nav>

      <section className={authorsExpanded ? "author-filter" : "author-filter collapsed"}>
        <button
          type="button"
          className="filter-header-button"
          onClick={() => setAuthorsExpanded((current) => !current)}
          aria-expanded={authorsExpanded}
        >
          {authorsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <UserRound size={15} />
          <span>Filter by Authors</span>
        </button>
        {authorsExpanded && (
          <>
            <button
              type="button"
              className={!selectedAuthor ? "author-filter-button active" : "author-filter-button"}
              onClick={() => onSelectAuthor(undefined)}
            >
              All
            </button>
            <div className="author-filter-list">
              {authors.map((author) => (
                <button
                  key={author}
                  type="button"
                  className={selectedAuthor === author ? "author-filter-button active" : "author-filter-button"}
                  onClick={() => onSelectAuthor(author)}
                >
                  {author}
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <section className={tagsExpanded ? "tag-filter" : "tag-filter collapsed"}>
        <button
          type="button"
          className="filter-header-button"
          onClick={() => setTagsExpanded((current) => !current)}
          aria-expanded={tagsExpanded}
        >
          {tagsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Tags size={15} />
          <span>Filter by Tags</span>
        </button>
        {tagsExpanded && (
          <>
            <button
              type="button"
              className={!selectedTag ? "author-filter-button active" : "author-filter-button"}
              onClick={() => onSelectTag(undefined)}
            >
              All
            </button>
            <div className="author-filter-list">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={selectedTag === tag ? "author-filter-button active" : "author-filter-button"}
                  onClick={() => onSelectTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <div className="library-sync-footer">
        {cloudSyncActivity && (
          <div
            className={`library-sync-activity ${cloudSyncActivity.state}`}
            role="status"
            aria-live="polite"
          >
            <div className="library-sync-activity-heading">
              {cloudSyncActivity.state === "running" && <RefreshCw className="spinning" size={14} />}
              {cloudSyncActivity.state === "success" && <CircleCheck size={14} />}
              {cloudSyncActivity.state === "error" && <AlertCircle size={14} />}
              {cloudSyncActivity.state === "cancelled" && <CircleX size={14} />}
              <span>{cloudSyncActivity.state === "running" ? "Cloud syncing" : cloudSyncActivity.state === "success" ? "Cloud synced" : cloudSyncActivity.state === "cancelled" ? "Cloud sync cancelled" : "Cloud sync failed"}</span>
              <small>{Math.round((cloudSyncActivity.completed / Math.max(1, cloudSyncActivity.total)) * 100)}%</small>
              <button
                type="button"
                className="library-sync-cancel"
                onClick={cloudSyncActivity.state === "running" ? onCancelCloudSync : onDismissCloudSync}
                aria-label={cloudSyncActivity.state === "running" ? "Cancel cloud sync" : "Dismiss"}
                title={cloudSyncActivity.state === "running" ? "Cancel sync" : "Dismiss"}
              >
                <X size={13} />
              </button>
            </div>
            <div className="library-sync-progress" aria-hidden>
              <span style={{ width: `${Math.min(100, (cloudSyncActivity.completed / Math.max(1, cloudSyncActivity.total)) * 100)}%` }} />
            </div>
            <p title={cloudSyncActivity.message}>{cloudSyncActivity.message}</p>
          </div>
        )}
        {mendeleySyncActivity && (
          <div
            className={`library-sync-activity ${mendeleySyncActivity.state}`}
            role="status"
            aria-live="polite"
          >
            <div className="library-sync-activity-heading">
              {mendeleySyncActivity.state === "running" && <RefreshCw className="spinning" size={14} />}
              {mendeleySyncActivity.state === "success" && <CircleCheck size={14} />}
              {mendeleySyncActivity.state === "error" && <AlertCircle size={14} />}
              {mendeleySyncActivity.state === "cancelled" && <CircleX size={14} />}
              <span>{mendeleySyncActivity.state === "running" ? "Mendeley syncing" : mendeleySyncActivity.state === "success" ? "Mendeley synced" : mendeleySyncActivity.state === "cancelled" ? "Mendeley sync cancelled" : "Mendeley sync failed"}</span>
              <small>{Math.round((mendeleySyncActivity.completed / Math.max(1, mendeleySyncActivity.total)) * 100)}%</small>
              {mendeleySyncActivity.state === "running" && (
                <button
                  type="button"
                  className="library-sync-cancel"
                  onClick={onCancelMendeleySync}
                  aria-label="Cancel Mendeley sync"
                  title="Cancel sync"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="library-sync-progress" aria-hidden>
              <span style={{ width: `${Math.min(100, (mendeleySyncActivity.completed / Math.max(1, mendeleySyncActivity.total)) * 100)}%` }} />
            </div>
            <p title={mendeleySyncActivity.message}>{mendeleySyncActivity.message}</p>
          </div>
        )}
        <button type="button" onClick={onSync} disabled={syncBusy}>
          <RefreshCw size={15} />
          {syncBusy ? "Syncing..." : "Sync"}
        </button>
      </div>

      {contextMenu && (
        <div
          className="paper-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(undefined);
              onAddPdfToCollection(contextMenu.collectionId);
            }}
          >
            <FilePlus size={15} />
            <span>Add PDF...</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(undefined);
              onRenameCollection(contextMenu.collectionId);
            }}
          >
            <Pencil size={15} />
            <span>Rename Folder</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(undefined);
              onCreateCollection(contextMenu.collectionId);
            }}
          >
            <FolderPlus size={15} />
            <span>New Subfolder...</span>
          </button>
          {contextMenu.collectionId !== "collection_inbox" && (
            <button
              type="button"
              className="danger"
              role="menuitem"
              onClick={() => {
                setContextMenu(undefined);
                onDeleteCollection(contextMenu.collectionId);
              }}
            >
              <Trash2 size={15} />
              <span>Delete Folder</span>
            </button>
          )}
        </div>
      )}

      {trashContextMenu && (
        <div
          className="paper-context-menu"
          style={{ left: trashContextMenu.x, top: trashContextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="danger"
            role="menuitem"
            onClick={() => {
              setTrashContextMenu(undefined);
              onEmptyTrash();
            }}
          >
            <Trash2 size={15} />
            <span>Empty Trash...</span>
          </button>
        </div>
      )}
    </aside>
  );
}

type CollectionNode = {
  collection: Collection;
  children: CollectionNode[];
};

function CollectionTreeNode({
  node,
  depth,
  selectedCollectionId,
  selectedPaperCollectionIds,
  dragOverCollectionId,
  collapsedCollections,
  getCount,
  onToggle,
  onSelectCollection,
  onAddPaperToCollection,
  onDragOverCollection,
  onOpenContextMenu
}: {
  node: CollectionNode;
  depth: number;
  selectedCollectionId: string;
  selectedPaperCollectionIds: Set<string>;
  dragOverCollectionId?: string;
  collapsedCollections: Record<string, boolean>;
  getCount: (collectionId: string) => number;
  onToggle: (collectionId: string) => void;
  onSelectCollection: (id: string) => void;
  onAddPaperToCollection: (paperId: string, collectionId: string) => void;
  onDragOverCollection: (collectionId?: string) => void;
  onOpenContextMenu: (menu: CollectionContextMenu) => void;
}) {
  const { collection, children } = node;
  const collapsed = Boolean(collapsedCollections[collection.id]);
  const hasChildren = children.length > 0;
  const dragOver = dragOverCollectionId === collection.id;
  const containsSelectedPaper = selectedPaperCollectionIds.has(collection.id);
  const selectedCollection = selectedCollectionId === collection.id;

  return (
    <>
      <div
        className={dragOver ? "collection-tree-row drag-over" : "collection-tree-row"}
        style={{ paddingLeft: `${depth * 14}px` }}
        data-collection-drop-id={collection.id}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenContextMenu({
            x: event.clientX,
            y: event.clientY,
            collectionId: collection.id,
            collectionName: collection.name
          });
        }}
        onDragOver={(event) => {
          if (hasPaperDragData(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            onDragOverCollection(collection.id);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            onDragOverCollection(undefined);
          }
        }}
        onDrop={(event) => {
          const paperId = readDraggedPaperId(event.dataTransfer);
          onDragOverCollection(undefined);
          document.body.classList.remove("paper-pointer-dragging");
          if (!paperId) {
            return;
          }

          event.preventDefault();
          onAddPaperToCollection(paperId, collection.id);
        }}
      >
        {hasChildren ? (
          <button
            className="collection-toggle"
            type="button"
            onClick={() => onToggle(collection.id)}
            aria-label={collapsed ? `Expand ${collection.name}` : `Collapse ${collection.name}`}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : (
          <span className="collection-toggle-spacer" />
        )}
        <button
          className={`collection-button${selectedCollection ? " active" : ""}${containsSelectedPaper ? " contains-selected-paper" : ""}`}
          type="button"
          onClick={() => onSelectCollection(collection.id)}
          title={containsSelectedPaper ? `${collection.name} — contains selected document` : collection.name}
        >
          <Folder size={16} />
          <span>{collection.name}</span>
          <strong>{getCount(collection.id)}</strong>
        </button>
      </div>
      {hasChildren && !collapsed && children.map((child) => (
        <CollectionTreeNode
          key={child.collection.id}
          node={child}
          depth={depth + 1}
          selectedCollectionId={selectedCollectionId}
          selectedPaperCollectionIds={selectedPaperCollectionIds}
          dragOverCollectionId={dragOverCollectionId}
          collapsedCollections={collapsedCollections}
          getCount={getCount}
          onToggle={onToggle}
          onSelectCollection={onSelectCollection}
          onAddPaperToCollection={onAddPaperToCollection}
          onDragOverCollection={onDragOverCollection}
          onOpenContextMenu={onOpenContextMenu}
        />
      ))}
    </>
  );
}

function hasPaperDragData(dataTransfer: DataTransfer) {
  const types = Array.from(dataTransfer.types);
  return document.body.classList.contains("paper-pointer-dragging")
    || types.includes("application/x-lumora-paper-id")
    || types.includes("text/plain");
}

function readDraggedPaperId(dataTransfer: DataTransfer) {
  const directValue = dataTransfer.getData("application/x-lumora-paper-id");
  if (directValue) {
    return directValue;
  }

  const textValue = dataTransfer.getData("text/plain");
  return textValue.startsWith("lumora-paper:") ? textValue.slice("lumora-paper:".length) : undefined;
}

function buildCollectionTree(collections: Collection[]): CollectionNode[] {
  const nodes = new Map(collections.map((collection) => [collection.id, { collection, children: [] as CollectionNode[] }]));
  const roots: CollectionNode[] = [];

  for (const collection of collections) {
    const node = nodes.get(collection.id);
    if (!node) {
      continue;
    }

    const parent = collection.parentId ? nodes.get(collection.parentId) : undefined;
    if (parent && parent.collection.id !== collection.id && !wouldCreateCollectionCycle(collections, collection.id, parent.collection.id)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function wouldCreateCollectionCycle(collections: Collection[], collectionId: string, parentId: string) {
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  let currentId: string | undefined = parentId;

  while (currentId) {
    if (currentId === collectionId) {
      return true;
    }

    currentId = collectionById.get(currentId)?.parentId;
  }

  return false;
}

function NavButton({
  icon: Icon,
  label,
  active,
  count,
  onClick,
  onContextMenu
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  count: number;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  return (
    <button className={active ? "collection-button active" : "collection-button"} type="button" onClick={onClick} onContextMenu={onContextMenu}>
      <Icon size={16} />
      <span>{label}</span>
      <strong>{count}</strong>
    </button>
  );
}
