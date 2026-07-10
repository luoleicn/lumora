import {
  Archive,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  Star,
  Tags,
  Trash2,
  UserRound,
  type LucideIcon
} from "lucide-react";
import type { Collection, LibraryState } from "@lumora/shared";
import { useEffect, useState } from "react";
import lumoraLogoUrl from "../assets/lumora-logo-64.png";

type LibrarySidebarProps = {
  state: LibraryState;
  collectionPaperCounts: Record<string, number>;
  dragOverCollectionId?: string;
  selectedCollectionId: string;
  selectedAuthor?: string;
  selectedTag?: string;
  onSelectCollection: (id: string) => void;
  onSelectAuthor: (author?: string) => void;
  onSelectTag: (tag?: string) => void;
  onCreateCollection: (parentId?: string) => void;
  onRenameCollection: (collectionId: string) => void;
  onDeleteCollection: (collectionId: string) => void;
  onAddPaperToCollection: (paperId: string, collectionId: string) => void;
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
  selectedAuthor,
  selectedTag,
  onSelectCollection,
  onSelectAuthor,
  onSelectTag,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onAddPaperToCollection
}: LibrarySidebarProps) {
  const [authorsExpanded, setAuthorsExpanded] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>({});
  const [nativeDragOverCollectionId, setNativeDragOverCollectionId] = useState<string>();
  const [contextMenu, setContextMenu] = useState<CollectionContextMenu>();

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
  const visibleDragOverCollectionId = dragOverCollectionId ?? nativeDragOverCollectionId;
  const collections = state.collections
    .filter((collection) => !collection.deletedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const collectionTree = buildCollectionTree(collections);
  const activePapers = state.papers.filter((paper) => !paper.deletedAt);
  const deletedPapers = state.papers.filter((paper) => paper.deletedAt);
  const unfiledPaperCount = activePapers.filter(
    (paper) => !state.paperCollections.some((item) => item.paperId === paper.id && !item.deletedAt)
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
          className={selectedCollectionId === collection.id ? "collection-button active" : "collection-button"}
          type="button"
          onClick={() => onSelectCollection(collection.id)}
          title={collection.name}
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
  onClick
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button className={active ? "collection-button active" : "collection-button"} type="button" onClick={onClick}>
      <Icon size={16} />
      <span>{label}</span>
      <strong>{count}</strong>
    </button>
  );
}
