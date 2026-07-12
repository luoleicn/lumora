import { invoke } from "@tauri-apps/api/core";
import type { Annotation, Author, Collection, FileAsset, LibraryState, Paper, PaperCollection } from "@lumora/shared";
import { createId } from "./id";
import { deleteFileBlob, getFileBytes, putFileBlob } from "./localStore";
import { buildPdfFileName, storePdfToDisk, type FileStorageSettings } from "./fileStorage";

export type MendeleySettings = {
  clientId: string;
  clientSecret: string;
};

export type MendeleyConnection = {
  connected: boolean;
  displayName?: string;
};

export type MendeleySyncSummary = {
  pulled: number;
  pushed: number;
  deletedLocally: number;
  deletedRemotely: number;
  folders: number;
  files: number;
  annotations: number;
  folderLinks: number;
  unavailableResources: string[];
};

export type MendeleySyncProgress = {
  phase: "documents" | "trash" | "folders" | "files" | "annotations" | "memberships" | "push" | "complete";
  message: string;
  completed: number;
  total: number;
};

export type MendeleySyncOptions = {
  isCancelled?: () => boolean;
  onStateUpdate?: (state: LibraryState) => void;
};

export class MendeleySyncCancelledError extends Error {
  constructor() {
    super("Mendeley sync cancelled.");
    this.name = "MendeleySyncCancelledError";
  }
}

export type MendeleyDocument = {
  id?: string;
  title?: string;
  type?: string;
  authors?: Array<{ first_name?: string; last_name?: string }>;
  year?: number;
  source?: string;
  abstract?: string;
  identifiers?: { doi?: string; arxiv?: string; pmid?: string; isbn?: string; issn?: string; scopus?: string; ssrn?: string };
  keywords?: string[];
  tags?: string[];
  created?: string;
  last_modified?: string;
  month?: number;
  day?: number;
  revision?: string;
  pages?: string;
  volume?: string;
  issue?: string;
  websites?: string[];
  publisher?: string;
  city?: string;
  edition?: string;
  institution?: string;
  series?: string;
  chapter?: string;
  editors?: Array<{ first_name?: string; last_name?: string }>;
  accessed?: string;
  read?: boolean;
  starred?: boolean;
  authored?: boolean;
  confirmed?: boolean;
  hidden?: boolean;
  file_attached?: boolean;
  citation_key?: string;
  source_type?: string;
  language?: string;
  short_title?: string;
  reprint_edition?: string;
  genre?: string;
  country?: string;
  translators?: Array<{ first_name?: string; last_name?: string }>;
  series_editor?: string;
  code?: string;
  medium?: string;
  user_context?: string;
  department?: string;
  patent_owner?: string;
  patent_application_number?: string;
  patent_legal_status?: string;
};

export type MendeleyFolder = { id?: string; name: string; parent_id?: string; created?: string; modified?: string };
export type MendeleyFile = { id: string; document_id: string; file_name: string; mime_type: string; filehash: string; size: number };
export type MendeleyPosition = {
  page: number;
  top_left: { x: number; y: number };
  bottom_right: { x: number; y: number };
};
export type MendeleyAnnotation = {
  id?: string;
  created?: string;
  last_modified?: string;
  type?: "note" | "highlight" | "sticky_note";
  color?: { r: number; g: number; b: number };
  text?: string;
  positions?: MendeleyPosition[];
  privacy_level?: "private" | "group" | "public";
  document_id: string;
  profile_id?: string;
  filehash?: string;
};

const mendeleySettingsKey = "lumora:mendeley-settings";
const mendeleySyncedAtMetaKey = "mendeleySyncedAt";
const documentContentType = "application/vnd.mendeley-document.1+json";
const folderContentType = "application/vnd.mendeley-folder.1+json";
const annotationContentType = "application/vnd.mendeley-annotation.1+json";
const fileContentType = "application/vnd.mendeley-file.1+json";

export const mendeleyRedirectUri = "http://localhost:53682/mendeley/callback";

const documentTypeToMendeley: Record<string, string> = {
  journalArticle: "journal",
  conferencePaper: "conference_proceedings",
  preprint: "working_paper",
  book: "book",
  bookSection: "book_section",
  thesis: "thesis",
  report: "report"
};

const mendeleyTypeToDocumentType: Record<string, string> = Object.fromEntries(
  Object.entries(documentTypeToMendeley).map(([local, remote]) => [remote, local])
);

export function loadMendeleySettings(): MendeleySettings {
  const fallback: MendeleySettings = { clientId: "", clientSecret: "" };
  const raw = localStorage.getItem(mendeleySettingsKey);
  if (!raw) {
    return fallback;
  }

  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<MendeleySettings>) };
  } catch {
    return fallback;
  }
}

export function saveMendeleySettings(settings: MendeleySettings) {
  localStorage.setItem(mendeleySettingsKey, JSON.stringify(settings));
}

export async function connectMendeley(settings: MendeleySettings): Promise<MendeleyConnection> {
  return invoke<MendeleyConnection>("mendeley_connect", {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret
  });
}

export async function getMendeleyConnection(): Promise<MendeleyConnection> {
  return invoke<MendeleyConnection>("mendeley_status");
}

export async function disconnectMendeley(): Promise<void> {
  await invoke("mendeley_disconnect");
}

export function mendeleyDocumentToPaper(document: MendeleyDocument, existing?: Paper): Paper {
  const now = new Date().toISOString();
  const authors: Author[] = (document.authors ?? []).map((author) => ({
    firstName: author.first_name,
    lastName: author.last_name,
    fullName: [author.first_name, author.last_name].filter(Boolean).join(" ").trim() || "Unknown"
  }));

  return {
    ...(existing ?? { id: createId("paper"), createdAt: document.created ?? now }),
    title: document.title?.trim() || existing?.title || "Untitled",
    authors,
    year: document.year ?? existing?.year,
    venue: document.source ?? existing?.venue,
    abstract: document.abstract ?? existing?.abstract,
    doi: document.identifiers?.doi ?? existing?.doi,
    arxiv: document.identifiers?.arxiv ?? existing?.arxiv,
    pmid: document.identifiers?.pmid ?? existing?.pmid,
    isbn: document.identifiers?.isbn ?? existing?.isbn,
    issn: document.identifiers?.issn ?? existing?.issn,
    scopus: document.identifiers?.scopus ?? existing?.scopus,
    ssrn: document.identifiers?.ssrn ?? existing?.ssrn,
    tags: document.tags ?? existing?.tags ?? [],
    keywords: document.keywords ?? existing?.keywords ?? [],
    month: document.month ?? existing?.month,
    day: document.day ?? existing?.day,
    revision: document.revision ?? existing?.revision,
    pages: document.pages ?? existing?.pages,
    volume: document.volume ?? existing?.volume,
    issue: document.issue ?? existing?.issue,
    websites: document.websites ?? existing?.websites,
    url: document.websites?.[0] ?? existing?.url,
    publisher: document.publisher ?? existing?.publisher,
    city: document.city ?? existing?.city,
    edition: document.edition ?? existing?.edition,
    institution: document.institution ?? existing?.institution,
    series: document.series ?? existing?.series,
    chapter: document.chapter ?? existing?.chapter,
    editors: document.editors?.map(personToAuthor) ?? existing?.editors,
    accessedAt: document.accessed ?? existing?.accessedAt,
    favorite: document.starred ?? existing?.favorite,
    unread: document.read === undefined ? existing?.unread : !document.read,
    needsReview: document.confirmed === undefined ? existing?.needsReview : !document.confirmed,
    authored: document.authored ?? existing?.authored,
    hidden: document.hidden ?? existing?.hidden,
    fileAttached: document.file_attached ?? existing?.fileAttached,
    citationKey: document.citation_key ?? existing?.citationKey,
    sourceType: document.source_type ?? existing?.sourceType,
    language: document.language ?? existing?.language,
    shortTitle: document.short_title ?? existing?.shortTitle,
    reprintEdition: document.reprint_edition ?? existing?.reprintEdition,
    genre: document.genre ?? existing?.genre,
    country: document.country ?? existing?.country,
    translators: document.translators?.map(personToAuthor) ?? existing?.translators,
    seriesEditor: document.series_editor ?? existing?.seriesEditor,
    code: document.code ?? existing?.code,
    medium: document.medium ?? existing?.medium,
    userContext: document.user_context ?? existing?.userContext,
    department: document.department ?? existing?.department,
    patentOwner: document.patent_owner ?? existing?.patentOwner,
    patentApplicationNumber: document.patent_application_number ?? existing?.patentApplicationNumber,
    patentLegalStatus: document.patent_legal_status ?? existing?.patentLegalStatus,
    documentType: (document.type && mendeleyTypeToDocumentType[document.type]) ?? existing?.documentType ?? "journalArticle",
    source: "mendeley",
    mendeleyId: document.id ?? existing?.mendeleyId,
    updatedAt: document.last_modified ?? now,
    deletedAt: undefined
  };
}

export function paperToMendeleyDocument(paper: Paper): MendeleyDocument {
  const identifiers: MendeleyDocument["identifiers"] = {};
  if (paper.doi) {
    identifiers.doi = paper.doi;
  }
  if (paper.arxiv) {
    identifiers.arxiv = paper.arxiv;
  }
  if (paper.pmid) {
    identifiers.pmid = paper.pmid;
  }
  for (const [key, value] of Object.entries({ isbn: paper.isbn, issn: paper.issn, scopus: paper.scopus, ssrn: paper.ssrn })) {
    if (value) identifiers[key as "isbn" | "issn" | "scopus" | "ssrn"] = value;
  }

  return {
    title: paper.title || "Untitled",
    type: (paper.documentType && documentTypeToMendeley[paper.documentType]) ?? "generic",
    authors: paper.authors.map((author) => ({
      first_name: author.firstName ?? (author.fullName.split(" ").slice(0, -1).join(" ") || undefined),
      last_name: author.lastName ?? (author.fullName.split(" ").slice(-1)[0] || undefined)
    })),
    year: paper.year,
    source: paper.venue,
    abstract: paper.abstract,
    identifiers: Object.keys(identifiers).length > 0 ? identifiers : undefined,
    keywords: paper.keywords?.length ? paper.keywords : undefined,
    tags: paper.tags?.length ? paper.tags : undefined,
    month: paper.month,
    day: paper.day,
    revision: paper.revision,
    pages: paper.pages,
    volume: paper.volume,
    issue: paper.issue,
    websites: paper.websites?.length ? paper.websites : paper.url ? [paper.url] : undefined,
    publisher: paper.publisher,
    city: paper.city,
    edition: paper.edition,
    institution: paper.institution,
    series: paper.series,
    chapter: paper.chapter,
    editors: paper.editors?.map(authorToPerson),
    accessed: paper.accessedAt,
    read: paper.unread === undefined ? undefined : !paper.unread,
    starred: paper.favorite,
    authored: paper.authored,
    confirmed: paper.needsReview === undefined ? undefined : !paper.needsReview,
    hidden: paper.hidden,
    file_attached: paper.fileAttached,
    citation_key: paper.citationKey,
    source_type: paper.sourceType,
    language: paper.language,
    short_title: paper.shortTitle,
    reprint_edition: paper.reprintEdition,
    genre: paper.genre,
    country: paper.country,
    translators: paper.translators?.map(authorToPerson),
    series_editor: paper.seriesEditor,
    code: paper.code,
    medium: paper.medium,
    user_context: paper.userContext,
    department: paper.department,
    patent_owner: paper.patentOwner,
    patent_application_number: paper.patentApplicationNumber,
    patent_legal_status: paper.patentLegalStatus
  };
}

function personToAuthor(person: { first_name?: string; last_name?: string }): Author {
  return {
    firstName: person.first_name,
    lastName: person.last_name,
    fullName: [person.first_name, person.last_name].filter(Boolean).join(" ").trim() || "Unknown"
  };
}

function authorToPerson(author: Author) {
  return {
    first_name: author.firstName ?? (author.fullName.split(" ").slice(0, -1).join(" ") || undefined),
    last_name: author.lastName ?? (author.fullName.split(" ").slice(-1)[0] || undefined)
  };
}

const fallbackPdfWidth = 612;
const fallbackPdfHeight = 792;

export function mendeleyAnnotationToLocal(
  annotation: MendeleyAnnotation,
  paperId: string,
  fileId: string,
  existing?: Annotation
): Annotation {
  const now = new Date().toISOString();
  const positions = annotation.positions ?? [];
  const page = positions[0]?.page ?? 1;
  // Positions are PDF points with a bottom-left origin, but Mendeley's own
  // clients store the smaller y in top_left while older Lumora pushes stored
  // the larger one, so take min/max instead of trusting the corner names.
  const rects = positions.filter((position) => position.page === page).map((position) => {
    const left = Math.min(position.top_left.x, position.bottom_right.x);
    const top = Math.max(position.top_left.y, position.bottom_right.y);
    return {
      x: left / fallbackPdfWidth,
      y: 1 - top / fallbackPdfHeight,
      width: Math.max(0.002, Math.abs(position.bottom_right.x - position.top_left.x) / fallbackPdfWidth),
      height: Math.max(0.002, Math.abs(position.top_left.y - position.bottom_right.y) / fallbackPdfHeight)
    };
  });
  const rgb = annotation.color ?? { r: 255, g: 235, b: 59 };
  const color = `#${[rgb.r, rgb.g, rgb.b].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
  const sticky = annotation.type === "sticky_note" || (positions.length > 0 && positions.every((position) =>
    position.top_left.x === position.bottom_right.x && position.top_left.y === position.bottom_right.y
  ));

  return {
    ...(existing ?? { id: createId("annotation"), createdAt: annotation.created ?? now }),
    paperId,
    fileId,
    pageIndex: Math.max(0, page - 1),
    kind: annotation.type === "note" || sticky ? "note" : "highlight",
    color,
    rects,
    notePosition: sticky && rects[0] ? { x: rects[0].x, y: rects[0].y } : existing?.notePosition,
    comment: annotation.text || undefined,
    mendeleyId: annotation.id ?? existing?.mendeleyId,
    mendeleyFileHash: annotation.filehash,
    mendeleyPrivacyLevel: annotation.privacy_level ?? "private",
    mendeleyPositions: positions.map((position) => ({
      page: position.page,
      topLeft: position.top_left,
      bottomRight: position.bottom_right
    })),
    updatedAt: annotation.last_modified ?? now,
    deletedAt: undefined
  };
}

export function localAnnotationToMendeley(annotation: Annotation, paper: Paper, file?: FileAsset): MendeleyAnnotation {
  const positions: MendeleyPosition[] = annotation.mendeleyPositions?.length
    ? annotation.mendeleyPositions.map((position) => ({
      page: position.page,
      top_left: position.topLeft,
      bottom_right: position.bottomRight
    }))
    : annotation.rects.map((rect) => ({
      // Mendeley's own clients put the smaller y in top_left (PDF y grows
      // upward), so mirror that ordering for annotations created here.
      page: annotation.pageIndex + 1,
      top_left: { x: rect.x * fallbackPdfWidth, y: (1 - rect.y - rect.height) * fallbackPdfHeight },
      bottom_right: {
        x: (rect.x + rect.width) * fallbackPdfWidth,
        y: (1 - rect.y) * fallbackPdfHeight
      }
    }));
  return {
    type: annotation.kind === "highlight" ? "highlight" : positions.length ? "sticky_note" : "note",
    color: hexToRgb(annotation.color),
    text: annotation.comment,
    positions,
    privacy_level: annotation.mendeleyPrivacyLevel ?? "private",
    document_id: paper.mendeleyId ?? "",
    filehash: annotation.mendeleyFileHash ?? file?.mendeleyFileHash
  };
}

function hexToRgb(color: string) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  return match
    ? { r: Number.parseInt(match[1], 16), g: Number.parseInt(match[2], 16), b: Number.parseInt(match[3], 16) }
    : { r: 255, g: 235, b: 59 };
}

type ProxyResponse = { status: number; body: string; linkNext?: string };

async function mendeleyRequest(
  settings: MendeleySettings,
  method: string,
  path: string,
  body?: unknown,
  contentType = documentContentType
): Promise<ProxyResponse> {
  return invoke<ProxyResponse>("mendeley_request", {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    method,
    path,
    body: body === undefined ? undefined : JSON.stringify(body),
    contentType
  });
}

async function fetchAll<T>(
  settings: MendeleySettings,
  path: string,
  contentType: string,
  options?: { allowNotFound?: boolean; onNotFound?: () => void; isCancelled?: () => boolean }
): Promise<T[]> {
  const output: T[] = [];
  let next: string | undefined = path;
  while (next) {
    if (options?.isCancelled?.()) throw new MendeleySyncCancelledError();
    const response: ProxyResponse = await mendeleyRequest(settings, "GET", next, undefined, contentType);
    if (options?.isCancelled?.()) throw new MendeleySyncCancelledError();
    if (response.status !== 200) {
      if (response.status === 404 && options?.allowNotFound) {
        options.onNotFound?.();
        return output;
      }
      if (response.status === 400 && /page size is too large/i.test(response.body)) {
        const smallerPage = reducePageSize(next);
        if (smallerPage) {
          next = smallerPage;
          continue;
        }
      }
      throw new Error(`Mendeley pull failed for ${next} (${response.status}): ${response.body.slice(0, 200)}`);
    }
    const page = JSON.parse(response.body) as T[] | T;
    output.push(...(Array.isArray(page) ? page : [page]));
    next = response.linkNext;
  }
  return output;
}

function reducePageSize(path: string): string | undefined {
  const match = /([?&])limit=(\d+)/.exec(path);
  if (!match) return undefined;
  const current = Number.parseInt(match[2], 10);
  if (!Number.isFinite(current) || current <= 20) return undefined;
  const next = current > 200 ? 200 : Math.max(20, Math.floor(current / 2));
  return path.replace(/([?&])limit=\d+/, `$1limit=${next}`);
}

function relationId(folderId: string, documentId: string) {
  return `mendeley_relation_${folderId}_${documentId}`;
}

// Preserve edits made while a long-running attachment sync is in flight.
export function mergeBackgroundSyncState(
  base: LibraryState,
  synced: LibraryState,
  current: LibraryState,
  startedAt: string
): LibraryState {
  const merge = <T extends { id: string; updatedAt: string }>(baseItems: T[], syncedItems: T[], currentItems: T[]) => {
    const baseIds = new Set(baseItems.map((item) => item.id));
    const output = new Map(syncedItems.map((item) => [item.id, item]));
    for (const item of currentItems) {
      if (!baseIds.has(item.id) || item.updatedAt > startedAt) {
        output.set(item.id, item);
      }
    }
    return [...output.values()];
  };

  return {
    ...synced,
    papers: merge(base.papers, synced.papers, current.papers),
    fileAssets: merge(base.fileAssets, synced.fileAssets, current.fileAssets),
    collections: merge(base.collections, synced.collections, current.collections),
    paperCollections: merge(base.paperCollections, synced.paperCollections, current.paperCollections),
    annotations: merge(base.annotations, synced.annotations, current.annotations)
  };
}

// Synchronizes every personal-library resource represented by Lumora:
// documents and full metadata, folders and membership, file attachment
// metadata, and annotations. Pulling precedes pushing so server changes win
// when both sides changed since the previous cursor.
//
// After the first full sync, every pull is incremental against the stored
// cursor: documents, trash, and annotations via modified_since, files via
// added_since/deleted_since, and folder membership only for folders that
// changed. Folders themselves are always listed in full because the API has
// no deleted-folder feed, but that is a single request.
export async function syncWithMendeley(
  state: LibraryState,
  settings: MendeleySettings,
  storageSettings: FileStorageSettings,
  onProgress?: (progress: MendeleySyncProgress) => void,
  syncOptions?: MendeleySyncOptions
): Promise<{ state: LibraryState; summary: MendeleySyncSummary }> {
  const cursor = await invoke<string | null>("db_get_meta", { key: mendeleySyncedAtMetaKey });
  const startedAt = new Date().toISOString();
  const summary: MendeleySyncSummary = {
    pulled: 0, pushed: 0, deletedLocally: 0, deletedRemotely: 0,
    folders: 0, files: 0, annotations: 0, folderLinks: 0, unavailableResources: []
  };

  let papers = [...state.papers];
  let collections = [...state.collections];
  let paperCollections = [...state.paperCollections];
  let fileAssets = [...state.fileAssets];
  let annotations = [...state.annotations];
  const pulledPaperIds = new Set<string>();
  const pulledFolderIds = new Set<string>();
  const pulledAnnotationIds = new Set<string>();
  const pulledRelationIds = new Set<string>();
  const report = (phase: MendeleySyncProgress["phase"], message: string, completed: number, total = 8) => {
    onProgress?.({ phase, message, completed, total });
  };
  const publishState = () => {
    syncOptions?.onStateUpdate?.({ ...state, papers, collections, paperCollections, fileAssets, annotations });
  };
  const ensureActive = () => {
    if (syncOptions?.isCancelled?.()) {
      publishState();
      throw new MendeleySyncCancelledError();
    }
  };
  const fetchResource = async <T,>(path: string, contentType: string, options?: { allowNotFound?: boolean; onNotFound?: () => void }) => {
    try {
      return await fetchAll<T>(settings, path, contentType, { ...options, isCancelled: syncOptions?.isCancelled });
    } catch (error) {
      if (error instanceof MendeleySyncCancelledError) publishState();
      throw error;
    }
  };

  const findLocal = (document: MendeleyDocument) =>
    papers.find((paper) =>
      (document.id && paper.mendeleyId === document.id)
      || (document.identifiers?.doi && paper.doi && paper.doi.toLowerCase() === document.identifiers.doi.toLowerCase())
      || (document.identifiers?.arxiv && paper.arxiv && paper.arxiv === document.identifiers.arxiv)
    );

  report("documents", "Syncing document metadata…", 0);
  const documents = await fetchResource<MendeleyDocument>(
    `/documents?limit=500&view=all${cursor ? `&modified_since=${encodeURIComponent(cursor)}` : ""}`,
    documentContentType
  );
  for (const document of documents) {
      const existing = findLocal(document);
      if (existing) {
        const remoteNewer = !existing.updatedAt
          || (document.last_modified ?? "") > existing.updatedAt
          || !existing.mendeleyId;
        if (remoteNewer) {
          const merged = mendeleyDocumentToPaper(document, existing);
          papers = papers.map((paper) => (paper.id === existing.id ? merged : paper));
          pulledPaperIds.add(existing.id);
          summary.pulled += 1;
        } else {
          pulledPaperIds.add(existing.id);
        }
      } else {
        const created = mendeleyDocumentToPaper(document);
        papers = [created, ...papers];
        pulledPaperIds.add(created.id);
        summary.pulled += 1;
      }
  }

  report("trash", "Checking Mendeley trash…", 1);
  // Trash is a separate Mendeley collection and is not returned by /documents.
  const fetchTrash = (since?: string | null) => fetchResource<MendeleyDocument>(
    `/trash?limit=500&view=all${since ? `&modified_since=${encodeURIComponent(since)}` : ""}`,
    documentContentType,
    {
      allowNotFound: true,
      onNotFound: () => summary.unavailableResources.push("trash")
    }
  );
  let trashedDocuments: MendeleyDocument[];
  try {
    trashedDocuments = await fetchTrash(cursor);
  } catch (error) {
    // Older deployments reject modified_since on /trash; refetch in full.
    if (!cursor || error instanceof MendeleySyncCancelledError) throw error;
    trashedDocuments = await fetchTrash();
  }
  for (const document of trashedDocuments) {
    const existing = findLocal(document);
    if (existing) {
      papers = papers.map((paper) => paper.id === existing.id
        ? { ...mendeleyDocumentToPaper(document, existing), deletedAt: existing.deletedAt ?? startedAt }
        : paper);
      pulledPaperIds.add(existing.id);
    } else {
      const created = { ...mendeleyDocumentToPaper(document), deletedAt: startedAt };
      papers = [created, ...papers];
      pulledPaperIds.add(created.id);
    }
  }

  if (cursor) {
    const deleted = await fetchResource<{ id: string }>(
      `/deleted_documents?limit=500&since=${encodeURIComponent(cursor)}`,
      "application/vnd.mendeley-deleted-document.1+json",
      {
        allowNotFound: true,
        onNotFound: () => summary.unavailableResources.push("deleted documents")
      }
    );
    const deletedIds = new Set(deleted.map((entry) => entry.id));
    papers = papers.map((paper) => {
      if (paper.mendeleyId && deletedIds.has(paper.mendeleyId) && !paper.deletedAt) {
        pulledPaperIds.add(paper.id);
        summary.deletedLocally += 1;
        return { ...paper, deletedAt: startedAt, updatedAt: startedAt };
      }
      return paper;
    });
  }

  report("documents", "Sending document changes…", 1.5);
  // Push local changes the pull did not supersede.
  for (const paper of [...papers]) {
    if (pulledPaperIds.has(paper.id)) {
      continue;
    }
    const changedSinceCursor = !cursor || paper.updatedAt > cursor;
    if (!changedSinceCursor) {
      continue;
    }

    if (paper.deletedAt) {
      if (paper.mendeleyId) {
        let response = await mendeleyRequest(settings, "POST", `/documents/${paper.mendeleyId}/trash`);
        if (response.status === 404) {
          response = await mendeleyRequest(settings, "DELETE", `/documents/${paper.mendeleyId}`);
        }
        if (response.status === 204 || response.status === 404) {
          summary.deletedRemotely += 1;
        }
      }
      continue;
    }

    if (paper.mendeleyId) {
      const response = await mendeleyRequest(settings, "PATCH", `/documents/${paper.mendeleyId}`, paperToMendeleyDocument(paper));
      if (response.status >= 400) {
        throw new Error(`Mendeley update failed (${response.status}): ${response.body.slice(0, 200)}`);
      }
      summary.pushed += 1;
    } else {
      const response = await mendeleyRequest(settings, "POST", "/documents", paperToMendeleyDocument(paper));
      if (response.status !== 201) {
        throw new Error(`Mendeley create failed (${response.status}): ${response.body.slice(0, 200)}`);
      }
      const created = JSON.parse(response.body) as MendeleyDocument;
      papers = papers.map((item) => (item.id === paper.id ? { ...item, mendeleyId: created.id, updatedAt: startedAt } : item));
      summary.pushed += 1;
    }
  }

  report("folders", "Syncing folders…", 2);
  // Folders are fetched in full because the API does not expose a deleted-folder feed.
  ensureActive();
  const remoteFolders = await fetchResource<MendeleyFolder>("/folders?limit=500", folderContentType);
  const remoteFolderIds = new Set(remoteFolders.flatMap((folder) => folder.id ? [folder.id] : []));
  const localByRemoteFolder = new Map(collections.flatMap((item) => item.mendeleyId ? [[item.mendeleyId, item] as const] : []));
  for (const folder of remoteFolders) {
    if (!folder.id) continue;
    const existing = localByRemoteFolder.get(folder.id);
    const parent = folder.parent_id ? localByRemoteFolder.get(folder.parent_id) : undefined;
    const mapped: Collection = {
      ...(existing ?? { id: createId("collection"), sortOrder: collections.length }),
      name: folder.name,
      parentId: parent?.id,
      mendeleyId: folder.id,
      createdAt: existing?.createdAt ?? folder.created ?? startedAt,
      updatedAt: folder.modified ?? existing?.updatedAt ?? startedAt,
      deletedAt: undefined
    };
    collections = existing
      ? collections.map((item) => item.id === existing.id ? mapped : item)
      : [...collections, mapped];
    localByRemoteFolder.set(folder.id, mapped);
    pulledFolderIds.add(mapped.id);
    summary.folders += 1;
  }
  collections = collections.map((item) => {
    if (item.mendeleyId && !remoteFolderIds.has(item.mendeleyId)) {
      pulledFolderIds.add(item.id);
      return { ...item, deletedAt: item.deletedAt ?? startedAt, updatedAt: startedAt };
    }
    return item;
  });

  // A second parent pass resolves children returned before their parents.
  collections = collections.map((item) => {
    const remote = item.mendeleyId ? remoteFolders.find((folder) => folder.id === item.mendeleyId) : undefined;
    const parent = remote?.parent_id ? collections.find((candidate) => candidate.mendeleyId === remote.parent_id) : undefined;
    return remote ? { ...item, parentId: parent?.id } : item;
  });
  publishState();

  report("files", "Reading attachment list…", 3);
  ensureActive();
  // Files are immutable in Mendeley, so added_since covers every change.
  const remoteFiles = await fetchResource<MendeleyFile>(
    `/files?limit=500${cursor ? `&added_since=${encodeURIComponent(cursor)}` : ""}`,
    fileContentType
  );
  for (const file of remoteFiles) {
    ensureActive();
    const paper = papers.find((item) => item.mendeleyId === file.document_id);
    if (!paper) continue;
    const existing = fileAssets.find((item) => item.mendeleyId === file.id || item.mendeleyFileHash === file.filehash);
    const extension = file.mime_type === "application/pdf" && !/\.pdf$/i.test(file.file_name) ? ".pdf" : "";
    const mapped: FileAsset = {
      ...(existing ?? { id: createId("file"), createdAt: startedAt }),
      paperId: paper.id,
      sha256: existing?.sha256 ?? `mendeley-sha1:${file.filehash}`,
      mendeleyFileHash: file.filehash,
      mendeleyId: file.id,
      size: file.size,
      mime: file.mime_type,
      fileName: `${file.file_name}${extension}`,
      downloadState: existing?.downloadState === "local" ? "local" : "remote",
      updatedAt: startedAt,
      deletedAt: undefined
    };
    fileAssets = existing ? fileAssets.map((item) => item.id === existing.id ? mapped : item) : [mapped, ...fileAssets];
    summary.files += 1;
  }
  if (cursor) {
    const deletedFiles = await fetchResource<{ id: string }>(
      `/files?limit=500&deleted_since=${encodeURIComponent(cursor)}`, fileContentType,
      {
        allowNotFound: true,
        onNotFound: () => summary.unavailableResources.push("deleted files")
      }
    );
    const deletedFileIds = new Set(deletedFiles.map((file) => file.id));
    fileAssets = fileAssets.map((item) => item.mendeleyId && deletedFileIds.has(item.mendeleyId)
      ? { ...item, deletedAt: item.deletedAt ?? startedAt, updatedAt: startedAt }
      : item);
  } else {
    const remoteFileIds = new Set(remoteFiles.map((file) => file.id));
    fileAssets = fileAssets.map((item) => item.mendeleyId && !remoteFileIds.has(item.mendeleyId)
      ? { ...item, deletedAt: item.deletedAt ?? startedAt, updatedAt: startedAt }
      : item);
  }

  report("annotations", "Syncing highlights and notes…", 4);
  const remoteAnnotations = await fetchResource<MendeleyAnnotation>(
    `/annotations?limit=200${cursor ? `&modified_since=${encodeURIComponent(cursor)}` : ""}`,
    annotationContentType
  );
  for (const remote of remoteAnnotations) {
    const paper = papers.find((item) => item.mendeleyId === remote.document_id);
    if (!paper) continue;
    let file = fileAssets.find((item) => item.paperId === paper.id && (!remote.filehash || item.mendeleyFileHash === remote.filehash));
    if (!file) {
      file = {
        id: createId("file"), paperId: paper.id, sha256: `mendeley-note:${remote.document_id}`,
        size: 0, mime: "application/octet-stream", fileName: "Mendeley document note",
        downloadState: "missing", createdAt: startedAt, updatedAt: startedAt
      };
      fileAssets = [file, ...fileAssets];
    }
    const existing = annotations.find((item) => item.mendeleyId === remote.id);
    const mapped = mendeleyAnnotationToLocal(remote, paper.id, file.id, existing);
    annotations = existing ? annotations.map((item) => item.id === existing.id ? mapped : item) : [mapped, ...annotations];
    pulledAnnotationIds.add(mapped.id);
    summary.annotations += 1;
  }
  if (cursor) {
    const deletedAnnotations = await fetchResource<{ id: string }>(
      `/annotations?limit=200&deleted_since=${encodeURIComponent(cursor)}`, annotationContentType,
      {
        allowNotFound: true,
        onNotFound: () => summary.unavailableResources.push("deleted annotations")
      }
    );
    const ids = new Set(deletedAnnotations.map((item) => item.id));
    annotations = annotations.map((item) => {
      if (item.mendeleyId && ids.has(item.mendeleyId)) {
        pulledAnnotationIds.add(item.id);
        return { ...item, deletedAt: item.deletedAt ?? startedAt, updatedAt: startedAt };
      }
      return item;
    });
  }

  report("memberships", "Syncing folder membership…", 5);
  // The API exposes no membership change feed, so membership is re-pulled
  // per folder — but only for folders whose timestamp passed the cursor, or
  // for every folder when documents changed (moving a document between
  // folders does not touch the folder's modified timestamp).
  const remoteDocumentsChanged = documents.length > 0 || trashedDocuments.length > 0 || summary.deletedLocally > 0;
  const remoteRelationIds = new Set<string>();
  // Relations of remotely deleted folders still need their removals applied.
  const refreshedCollectionIds = new Set(
    collections.flatMap((item) => item.mendeleyId && !remoteFolderIds.has(item.mendeleyId) ? [item.id] : [])
  );
  for (const folder of remoteFolders) {
    ensureActive();
    if (!folder.id) continue;
    if (cursor && !remoteDocumentsChanged && (folder.modified ?? folder.created ?? startedAt) <= cursor) continue;
    const collection = collections.find((item) => item.mendeleyId === folder.id);
    if (!collection) continue;
    refreshedCollectionIds.add(collection.id);
    const entries = await fetchResource<{ id: string }>(
      `/folders/${folder.id}/documents?limit=500`, documentContentType
    );
    for (const entry of entries) {
      const paper = papers.find((item) => item.mendeleyId === entry.id);
      if (!paper) continue;
      const id = relationId(folder.id, entry.id);
      remoteRelationIds.add(id);
      const existing = paperCollections.find((item) =>
        item.mendeleyId === id || (item.paperId === paper.id && item.collectionId === collection.id)
      );
      const mapped: PaperCollection = {
        ...(existing ?? { id: createId("paper_collection"), createdAt: startedAt }),
        paperId: paper.id, collectionId: collection.id, mendeleyId: id, updatedAt: startedAt, deletedAt: undefined
      };
      paperCollections = existing
        ? paperCollections.map((item) => item.id === existing.id ? mapped : item)
        : [mapped, ...paperCollections];
      pulledRelationIds.add(mapped.id);
      summary.folderLinks += 1;
    }
  }
  paperCollections = paperCollections.map((item) => {
    if (item.mendeleyId && refreshedCollectionIds.has(item.collectionId) && !remoteRelationIds.has(item.mendeleyId)) {
      pulledRelationIds.add(item.id);
      return { ...item, deletedAt: item.deletedAt ?? startedAt, updatedAt: startedAt };
    }
    return item;
  });

  // Publish structure immediately. PDF content is deliberately deferred so
  // folders and membership become visible even for very large libraries.
  publishState();

  report("push", "Sending local changes to Mendeley…", 6);
  // Push local folders in parent-first order, then memberships and annotations.
  const pendingFolders = collections.filter((item) =>
    item.id !== "collection_inbox" && !pulledFolderIds.has(item.id) && (!cursor || item.updatedAt > cursor)
  );
  for (let pass = 0; pass <= pendingFolders.length; pass += 1) {
    for (const folder of pendingFolders) {
      ensureActive();
      if (folder.parentId && !collections.find((item) => item.id === folder.parentId)?.mendeleyId) continue;
      const parentRemoteId = folder.parentId ? collections.find((item) => item.id === folder.parentId)?.mendeleyId : undefined;
      if (folder.deletedAt && folder.mendeleyId) {
        await mendeleyRequest(settings, "DELETE", `/folders/${folder.mendeleyId}`, undefined, folderContentType);
      } else if (folder.mendeleyId) {
        await mendeleyRequest(settings, "PATCH", `/folders/${folder.mendeleyId}`, { name: folder.name, parent_id: parentRemoteId }, folderContentType);
      } else if (!folder.deletedAt) {
        const response = await mendeleyRequest(settings, "POST", "/folders", { name: folder.name, parent_id: parentRemoteId }, folderContentType);
        if (response.status === 201) {
          const created = JSON.parse(response.body) as MendeleyFolder;
          collections = collections.map((item) => item.id === folder.id ? { ...item, mendeleyId: created.id } : item);
        }
      }
    }
  }

  for (const relation of paperCollections.filter((item) =>
    !pulledRelationIds.has(item.id) && (!cursor || item.updatedAt > cursor)
  )) {
    ensureActive();
    const folder = collections.find((item) => item.id === relation.collectionId);
    const paper = papers.find((item) => item.id === relation.paperId);
    if (!folder?.mendeleyId || !paper?.mendeleyId) continue;
    const path = `/folders/${folder.mendeleyId}/documents${relation.deletedAt ? `/${paper.mendeleyId}` : ""}`;
    await mendeleyRequest(settings, relation.deletedAt ? "DELETE" : "POST", path, relation.deletedAt ? undefined : { id: paper.mendeleyId }, documentContentType);
  }

  for (const annotation of annotations.filter((item) =>
    !pulledAnnotationIds.has(item.id) && (!cursor || item.updatedAt > cursor)
  )) {
    ensureActive();
    const paper = papers.find((item) => item.id === annotation.paperId);
    const file = fileAssets.find((item) => item.id === annotation.fileId);
    if (!paper?.mendeleyId) continue;
    if (annotation.deletedAt && annotation.mendeleyId) {
      await mendeleyRequest(settings, "DELETE", `/annotations/${annotation.mendeleyId}`, undefined, annotationContentType);
    } else if (annotation.mendeleyId) {
      await mendeleyRequest(settings, "PATCH", `/annotations/${annotation.mendeleyId}`, localAnnotationToMendeley(annotation, paper, file), annotationContentType);
    } else if (!annotation.deletedAt) {
      const response = await mendeleyRequest(settings, "POST", "/annotations", localAnnotationToMendeley(annotation, paper, file), annotationContentType);
      if (response.status === 201) {
        const created = JSON.parse(response.body) as MendeleyAnnotation;
        annotations = annotations.map((item) => item.id === annotation.id ? { ...item, mendeleyId: created.id } : item);
      }
    }
  }

  report("files", "Downloading PDF files…", 7);
  // Download every attachment still pending locally, not just the ones listed
  // by this pull: files that failed on a previous run would otherwise never be
  // retried once the cursor advances past their added_since window. A single
  // failed download is recorded and skipped so it cannot abort the whole sync.
  const pendingDownloads = fileAssets.filter((item) => item.mendeleyId && !item.deletedAt && item.downloadState === "remote");
  for (const [fileIndex, file] of pendingDownloads.entries()) {
    ensureActive();

    // When the paper already has a locally available PDF from another source
    // (e.g. manually bound or downloaded from arXiv), mirror the existing
    // local file so the Mendeley download is skipped and never re-queued.
    const alreadyLocal = fileAssets.find(
      (f) => f.paperId === file.paperId && !f.deletedAt && f.downloadState === "local"
        && (f.mime === "application/pdf" || /\.pdf$/i.test(f.fileName))
    );
    if (alreadyLocal) {
      fileAssets = fileAssets.map((item) => item.id === file.id
        ? { ...item, sha256: alreadyLocal.sha256, downloadState: "local", localPath: alreadyLocal.localPath, fileName: alreadyLocal.fileName }
        : item);
      publishState();
      continue;
    }

    report("files", `Downloading PDF files ${fileIndex + 1}/${pendingDownloads.length}…`, 7 + (pendingDownloads.length ? (fileIndex + 1) / pendingDownloads.length : 1));
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const buffer = await invoke<ArrayBuffer>("mendeley_download_file", {
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        fileId: file.mendeleyId
      });
      bytes = new Uint8Array(buffer);
    } catch (error) {
      summary.unavailableResources.push(`file ${file.fileName}: ${String(error)}`);
      continue;
    }
    ensureActive();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    let localPath: string | undefined;
    if (storageSettings.directory) {
      const paper = papers.find((item) => item.id === file.paperId && !item.deletedAt);
      const targetName = paper ? buildPdfFileName(paper, storageSettings.nameTemplate) : file.fileName;
      const storedName = await storePdfToDisk(storageSettings.directory, targetName, bytes);
      localPath = storedName;
    } else {
      await putFileBlob(file.id, new Blob([bytes], { type: file.mime }));
    }
    fileAssets = fileAssets.map((item) => item.id === file.id
      ? { ...item, sha256, downloadState: "local", localPath, fileName: localPath || item.fileName }
      : item);
    publishState();
  }

  // Migrate existing IndexedDB-only files to disk when a storage directory is configured.
  if (storageSettings.directory) {
    const paperById = new Map(papers.filter((item) => !item.deletedAt).map((item) => [item.id, item]));
    for (const fileAsset of fileAssets) {
      ensureActive();
      if (fileAsset.deletedAt || fileAsset.localPath || fileAsset.downloadState !== "local") continue;
      const paper = paperById.get(fileAsset.paperId);
      if (!paper) continue;
      const blobBytes = await getFileBytes(fileAsset.id);
      if (!blobBytes) continue;
      const targetName = buildPdfFileName(paper, storageSettings.nameTemplate);
      const storedName = await storePdfToDisk(storageSettings.directory, targetName, blobBytes);
      await deleteFileBlob(fileAsset.id);
      fileAssets = fileAssets.map((item) => item.id === fileAsset.id
        ? { ...item, fileName: storedName, localPath: storedName, updatedAt: startedAt }
        : item);
    }
  }

  ensureActive();
  await invoke("db_set_meta", { key: mendeleySyncedAtMetaKey, value: startedAt });
  report("complete", "Mendeley sync complete", 8);
  return { state: { ...state, papers, collections, paperCollections, fileAssets, annotations }, summary };
}
