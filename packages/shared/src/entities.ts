export type EntityId = string;

export type SyncEntity =
  | "paper"
  | "fileAsset"
  | "collection"
  | "paperCollection"
  | "annotation";

export type SyncOperation = "upsert" | "delete";

export type Author = {
  firstName?: string;
  lastName?: string;
  fullName: string;
};

export type Paper = {
  id: EntityId;
  title: string;
  authors: Author[];
  year?: number;
  venue?: string;
  doi?: string;
  arxiv?: string;
  pmid?: string;
  isbn?: string;
  issn?: string;
  scopus?: string;
  ssrn?: string;
  mendeleyId?: string;
  abstract?: string;
  source?: "manual" | "mendeley" | "import";
  documentType?: string;
  tags?: string[];
  keywords?: string[];
  url?: string;
  pages?: string;
  volume?: string;
  issue?: string;
  publisher?: string;
  month?: number;
  day?: number;
  revision?: string;
  websites?: string[];
  city?: string;
  edition?: string;
  institution?: string;
  series?: string;
  chapter?: string;
  editors?: Author[];
  accessedAt?: string;
  authored?: boolean;
  hidden?: boolean;
  fileAttached?: boolean;
  citationKey?: string;
  sourceType?: string;
  language?: string;
  shortTitle?: string;
  reprintEdition?: string;
  genre?: string;
  country?: string;
  translators?: Author[];
  seriesEditor?: string;
  code?: string;
  medium?: string;
  userContext?: string;
  department?: string;
  patentOwner?: string;
  patentApplicationNumber?: string;
  patentLegalStatus?: string;
  favorite?: boolean;
  needsReview?: boolean;
  unread?: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type ArxivMetadata = {
  arxivId: string;
  title: string;
  authors: Author[];
  year?: number;
  abstract?: string;
  doi?: string;
  url?: string;
  publishedAt?: string;
  updatedAt?: string;
  venue?: string;
  categories?: string[];
  score?: number;
};

export type FileAsset = {
  id: EntityId;
  paperId: EntityId;
  sha256: string;
  /** Mendeley exposes a SHA-1 filehash rather than SHA-256. */
  mendeleyFileHash?: string;
  mendeleyId?: string;
  size: number;
  mime: string;
  fileName: string;
  localPath?: string;
  objectKey?: string;
  downloadState: "local" | "remote" | "missing";
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type Collection = {
  id: EntityId;
  name: string;
  parentId?: EntityId;
  sortOrder: number;
  mendeleyId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type PaperCollection = {
  id: EntityId;
  paperId: EntityId;
  collectionId: EntityId;
  mendeleyId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type NormalizedPoint = {
  x: number;
  y: number;
};

export type AnnotationKind = "highlight" | "note";

export type Annotation = {
  id: EntityId;
  paperId: EntityId;
  fileId: EntityId;
  pageIndex: number;
  kind: AnnotationKind;
  color: string;
  rects: NormalizedRect[];
  notePosition?: NormalizedPoint;
  quote?: string;
  comment?: string;
  mendeleyId?: string;
  mendeleyFileHash?: string;
  mendeleyPrivacyLevel?: "private" | "group" | "public";
  /** Original PDF-point boxes (bottom-left origin), retained for lossless Mendeley round-trips. */
  mendeleyPositions?: Array<{
    page: number;
    topLeft: NormalizedPoint;
    bottomRight: NormalizedPoint;
  }>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type EntityPayloadMap = {
  paper: Paper;
  fileAsset: FileAsset;
  collection: Collection;
  paperCollection: PaperCollection;
  annotation: Annotation;
};

export type LibraryState = {
  papers: Paper[];
  fileAssets: FileAsset[];
  collections: Collection[];
  paperCollections: PaperCollection[];
  annotations: Annotation[];
  lastSyncCursor?: number;
};

export type LibraryEntity =
  | Paper
  | FileAsset
  | Collection
  | PaperCollection
  | Annotation;
