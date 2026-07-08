import {
  Archive,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Folder,
  FolderPlus,
  Star,
  Tags,
  Trash2,
  UserRound,
  type LucideIcon
} from "lucide-react";
import type { Collection, LibraryState } from "@lumora/shared";
import { useState } from "react";
import { getCollectionPaperCount } from "../lib/libraryActions";
import lumoraLogoUrl from "../assets/lumora-logo-64.png";

type LibrarySidebarProps = {
  state: LibraryState;
  selectedCollectionId: string;
  selectedAuthor?: string;
  selectedTag?: string;
  onSelectCollection: (id: string) => void;
  onSelectAuthor: (author?: string) => void;
  onSelectTag: (tag?: string) => void;
  onCreateCollection: (parentId?: string) => void;
  onDeleteCollection: (collectionId: string) => void;
  onAddPaperToCollection: (paperId: string, collectionId: string) => void;
};

export function LibrarySidebar({
  state,
  selectedCollectionId,
  selectedAuthor,
  selectedTag,
  onSelectCollection,
  onSelectAuthor,
  onSelectTag,
  onCreateCollection,
  onDeleteCollection,
  onAddPaperToCollection
}: LibrarySidebarProps) {
  const [authorsExpanded, setAuthorsExpanded] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>({});
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
                collapsedCollections={collapsedCollections}
                getCount={(collectionId) => getCollectionPaperCount(state, collections, collectionId)}
                onToggle={(collectionId) => {
                  setCollapsedCollections((current) => ({ ...current, [collectionId]: !current[collectionId] }));
                }}
                onSelectCollection={onSelectCollection}
                onCreateCollection={onCreateCollection}
                onDeleteCollection={onDeleteCollection}
                onAddPaperToCollection={onAddPaperToCollection}
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
  collapsedCollections,
  getCount,
  onToggle,
  onSelectCollection,
  onCreateCollection,
  onDeleteCollection,
  onAddPaperToCollection
}: {
  node: CollectionNode;
  depth: number;
  selectedCollectionId: string;
  collapsedCollections: Record<string, boolean>;
  getCount: (collectionId: string) => number;
  onToggle: (collectionId: string) => void;
  onSelectCollection: (id: string) => void;
  onCreateCollection: (parentId?: string) => void;
  onDeleteCollection: (collectionId: string) => void;
  onAddPaperToCollection: (paperId: string, collectionId: string) => void;
}) {
  const { collection, children } = node;
  const collapsed = Boolean(collapsedCollections[collection.id]);
  const hasChildren = children.length > 0;
  const [dragOver, setDragOver] = useState(false);

  return (
    <>
      <div
        className={dragOver ? "collection-tree-row drag-over" : "collection-tree-row"}
        style={{ paddingLeft: `${depth * 14}px` }}
        data-collection-drop-id={collection.id}
        onDragOver={(event) => {
          if (hasPaperDragData(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          const paperId = readDraggedPaperId(event.dataTransfer);
          setDragOver(false);
          if (!paperId) {
            return;
          }

          event.preventDefault();
          onAddPaperToCollection(paperId, collection.id);
          onSelectCollection(collection.id);
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
          data-collection-drop-id={collection.id}
          onClick={() => onSelectCollection(collection.id)}
          title={collection.name}
        >
          <Folder size={16} />
          <span>{collection.name}</span>
          <strong>{getCount(collection.id)}</strong>
        </button>
        <button
          className="collection-child-button"
          type="button"
          onClick={() => onCreateCollection(collection.id)}
          aria-label={`Create folder under ${collection.name}`}
          title={`Create folder under ${collection.name}`}
        >
          <FolderPlus size={14} />
        </button>
        {collection.id !== "collection_inbox" ? (
          <button
            className="collection-delete-button"
            type="button"
            onClick={() => onDeleteCollection(collection.id)}
            aria-label={`Delete ${collection.name}`}
            title={`Delete ${collection.name}`}
          >
            <Trash2 size={14} />
          </button>
        ) : (
          <span className="collection-action-spacer" />
        )}
      </div>
      {hasChildren && !collapsed && children.map((child) => (
        <CollectionTreeNode
          key={child.collection.id}
          node={child}
          depth={depth + 1}
          selectedCollectionId={selectedCollectionId}
          collapsedCollections={collapsedCollections}
          getCount={getCount}
          onToggle={onToggle}
          onSelectCollection={onSelectCollection}
          onCreateCollection={onCreateCollection}
          onDeleteCollection={onDeleteCollection}
          onAddPaperToCollection={onAddPaperToCollection}
        />
      ))}
    </>
  );
}

function hasPaperDragData(dataTransfer: DataTransfer) {
  const types = Array.from(dataTransfer.types);
  return types.includes("application/x-lumora-paper-id") || types.includes("text/plain");
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
