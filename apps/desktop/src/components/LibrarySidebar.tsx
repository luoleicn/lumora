import {
  AlertCircle,
  Archive,
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
import lumoraLogoUrl from "../assets/lumora-logo-64.png";

type LibrarySidebarProps = {
  state: LibraryState;
  selectedCollectionId: string;
  selectedAuthor?: string;
  selectedTag?: string;
  onSelectCollection: (id: string) => void;
  onSelectAuthor: (author?: string) => void;
  onSelectTag: (tag?: string) => void;
  onCreateCollection: () => void;
};

export function LibrarySidebar({
  state,
  selectedCollectionId,
  selectedAuthor,
  selectedTag,
  onSelectCollection,
  onSelectAuthor,
  onSelectTag,
  onCreateCollection
}: LibrarySidebarProps) {
  const collections = state.collections
    .filter((collection) => !collection.deletedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
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
          <h1>Lumora</h1>
          <p>Lumora — light up your literature.</p>
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
            icon={AlertCircle}
            label="Needs Review"
            active={selectedCollectionId === "needs_review"}
            count={activePapers.filter((paper) => paper.needsReview).length}
            onClick={() => onSelectCollection("needs_review")}
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
        {collections.map((collection) => (
          <CollectionButton
            key={collection.id}
            collection={collection}
            active={selectedCollectionId === collection.id}
            count={state.paperCollections.filter((item) => item.collectionId === collection.id && !item.deletedAt).length}
            onClick={() => onSelectCollection(collection.id)}
          />
        ))}
          <button className="new-folder-button inline" type="button" onClick={onCreateCollection}>
            <FolderPlus size={16} />
            Create Folder...
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

      <section className="author-filter">
        <header>
          <UserRound size={15} />
          <span>Filter by Authors</span>
        </header>
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
      </section>

      <section className="tag-filter">
        <header>
          <Tags size={15} />
          <span>Filter by Tags</span>
        </header>
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
      </section>
    </aside>
  );
}

function CollectionButton({
  collection,
  active,
  count,
  onClick
}: {
  collection: Collection;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button className={active ? "collection-button active" : "collection-button"} type="button" onClick={onClick}>
      <Folder size={16} />
      <span>{collection.name}</span>
      <strong>{count}</strong>
    </button>
  );
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
