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
  favorite?: boolean;
  needsReview?: boolean;
  unread?: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type FileAsset = {
  id: EntityId;
  paperId: EntityId;
  sha256: string;
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
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type PaperCollection = {
  id: EntityId;
  paperId: EntityId;
  collectionId: EntityId;
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

export type AnnotationKind = "highlight" | "note";

export type Annotation = {
  id: EntityId;
  paperId: EntityId;
  fileId: EntityId;
  pageIndex: number;
  kind: AnnotationKind;
  color: string;
  rects: NormalizedRect[];
  quote?: string;
  comment?: string;
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
