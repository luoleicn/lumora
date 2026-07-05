import type {
  Annotation,
  Collection,
  FileAsset,
  LibraryState,
  Paper,
  PaperCollection
} from "@lumora/shared";
import { createId } from "./id";

const libraryKey = "lumora:library-state";
const legacyLibraryKey = "paper-reader:library-state";
const clientIdKey = "lumora:client-id";
const legacyClientIdKey = "paper-reader:client-id";
const dbName = "lumora-files";
const legacyDbName = "paper-reader-files";
const dbVersion = 1;
const fileStoreName = "files";

export type ImportedPdf = {
  state: LibraryState;
  paper: Paper;
  fileAsset: FileAsset;
};

export function getClientId() {
  const existing = localStorage.getItem(clientIdKey);
  if (existing) {
    return existing;
  }

  const legacy = localStorage.getItem(legacyClientIdKey);
  if (legacy) {
    localStorage.setItem(clientIdKey, legacy);
    return legacy;
  }

  const id = createId("client");
  localStorage.setItem(clientIdKey, id);
  return id;
}

export function createDefaultState(): LibraryState {
  const now = new Date().toISOString();
  const inbox: Collection = {
    id: "collection_inbox",
    name: "Inbox",
    sortOrder: 0,
    createdAt: now,
    updatedAt: now
  };

  return {
    papers: [],
    fileAssets: [],
    collections: [inbox],
    paperCollections: [],
    annotations: [],
    lastSyncCursor: 0
  };
}

export function loadLibraryState(): LibraryState {
  const raw = localStorage.getItem(libraryKey) ?? localStorage.getItem(legacyLibraryKey);
  if (!raw) {
    return createDefaultState();
  }

  try {
    const parsed = JSON.parse(raw) as LibraryState;
    const state = {
      ...createDefaultState(),
      ...parsed
    };
    localStorage.setItem(libraryKey, JSON.stringify(state));
    return state;
  } catch {
    return createDefaultState();
  }
}

export function saveLibraryState(state: LibraryState) {
  localStorage.setItem(libraryKey, JSON.stringify(state));
}

export async function importPdfFile(current: LibraryState, file: File): Promise<ImportedPdf> {
  const now = new Date().toISOString();
  const paperId = createId("paper");
  const fileAssetId = createId("file");
  const title = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "Untitled paper";
  const sha256 = await hashFile(file);

  const paper: Paper = {
    id: paperId,
    title,
    authors: [],
    source: "manual",
    documentType: "journalArticle",
    tags: [],
    keywords: [],
    favorite: false,
    needsReview: true,
    unread: true,
    createdAt: now,
    updatedAt: now
  };

  const fileAsset: FileAsset = {
    id: fileAssetId,
    paperId,
    sha256,
    size: file.size,
    mime: file.type || "application/pdf",
    fileName: file.name,
    downloadState: "local",
    createdAt: now,
    updatedAt: now
  };

  const paperCollection: PaperCollection = {
    id: createId("paper_collection"),
    paperId,
    collectionId: "collection_inbox",
    createdAt: now,
    updatedAt: now
  };

  await putFileBlob(fileAssetId, file);

  return {
    paper,
    fileAsset,
    state: {
      ...current,
      papers: [paper, ...current.papers],
      fileAssets: [fileAsset, ...current.fileAssets],
      paperCollections: [paperCollection, ...current.paperCollections]
    }
  };
}

export function upsertById<T extends { id: string; updatedAt?: string }>(items: T[], next: T): T[] {
  const existing = items.find((item) => item.id === next.id);
  if (!existing) {
    return [next, ...items];
  }

  const shouldReplace = !existing.updatedAt || !next.updatedAt || next.updatedAt >= existing.updatedAt;
  return items.map((item) => (item.id === next.id && shouldReplace ? next : item));
}

export function markAnnotationDeleted(state: LibraryState, annotation: Annotation): LibraryState {
  const now = new Date().toISOString();
  return {
    ...state,
    annotations: state.annotations.map((item) =>
      item.id === annotation.id ? { ...item, updatedAt: now, deletedAt: now } : item
    )
  };
}

async function openFilesDb(name = dbName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, dbVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(fileStoreName)) {
        request.result.createObjectStore(fileStoreName);
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

export async function putFileBlob(fileAssetId: string, file: Blob): Promise<void> {
  const db = await openFilesDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(fileStoreName, "readwrite");
    transaction.objectStore(fileStoreName).put(file, fileAssetId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function getFileBlob(fileAssetId: string): Promise<Blob | undefined> {
  return await getFileBlobFromDb(dbName, fileAssetId) ?? await getFileBlobFromDb(legacyDbName, fileAssetId);
}

async function getFileBlobFromDb(name: string, fileAssetId: string): Promise<Blob | undefined> {
  const db = await openFilesDb(name);
  const blob = await new Promise<Blob | undefined>((resolve, reject) => {
    const transaction = db.transaction(fileStoreName, "readonly");
    const request = transaction.objectStore(fileStoreName).get(fileAssetId);
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return blob;
}

export async function getFileObjectUrl(fileAssetId: string): Promise<string | undefined> {
  const blob = await getFileBlob(fileAssetId);
  return blob ? URL.createObjectURL(blob) : undefined;
}

export async function getFileBytes(fileAssetId: string): Promise<Uint8Array | undefined> {
  const blob = await getFileBlob(fileAssetId);
  if (!blob) {
    return undefined;
  }

  return new Uint8Array(await blob.arrayBuffer());
}

async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
