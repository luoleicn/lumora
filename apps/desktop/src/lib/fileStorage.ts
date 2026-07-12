import { invoke } from "@tauri-apps/api/core";
import type { FileAsset, LibraryState, Paper } from "@lumora/shared";
import { deleteFileBlob, getFileBytes, importPdfFile, putFileBlob, type ImportedPdf } from "./localStore";
import { createId } from "./id";
import { persistEntities } from "./libraryDb";

export type FileStorageSettings = {
  directory?: string;
  nameTemplate: string;
};

const fileStorageSettingsKey = "lumora:file-storage-settings";

export const defaultNameTemplate = "{title}-{year}-{author}";

const maxFileNameLength = 120;
const illegalFileNameCharacters = /[/\\:*?"<>|]/g;

export function loadFileStorageSettings(): FileStorageSettings {
  const fallback: FileStorageSettings = { nameTemplate: defaultNameTemplate };
  const raw = localStorage.getItem(fileStorageSettingsKey);
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<FileStorageSettings>;
    return {
      ...fallback,
      ...parsed,
      nameTemplate: parsed.nameTemplate?.trim() || defaultNameTemplate
    };
  } catch {
    return fallback;
  }
}

export function saveFileStorageSettings(settings: FileStorageSettings) {
  localStorage.setItem(fileStorageSettingsKey, JSON.stringify(settings));
}

export function buildPdfFileName(paper: Paper, template: string): string {
  const firstAuthor = paper.authors[0];
  const author = firstAuthor?.lastName?.trim() || firstAuthor?.fullName?.trim() || "";
  const replacements: Record<string, string> = {
    title: paper.title.trim(),
    year: paper.year ? String(paper.year) : "",
    author
  };

  const substituted = (template.trim() || defaultNameTemplate)
    .replace(/\{(title|year|author)\}/g, (_, key: string) => replacements[key] ?? "");

  let name = sanitizeFileNameSegment(substituted);
  if (!name) {
    name = sanitizeFileNameSegment(paper.title) || "paper";
  }
  if (name.length > maxFileNameLength) {
    name = name.slice(0, maxFileNameLength).replace(/[-_. ]+$/g, "");
  }

  return `${name}.pdf`;
}

function sanitizeFileNameSegment(value: string): string {
  return value
    .replace(illegalFileNameCharacters, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    // collapse separator runs left behind by empty template fields, e.g. "title--author"
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_. ]+|[-_. ]+$/g, "")
    .trim();
}

// True when `fileName` already matches the template output, allowing for the
// collision suffix the Rust side may have appended (name-2.pdf, name-3.pdf).
export function fileNameMatchesTarget(fileName: string, targetFileName: string): boolean {
  if (fileName === targetFileName) {
    return true;
  }

  const targetStem = targetFileName.replace(/\.pdf$/i, "");
  const stem = fileName.replace(/\.pdf$/i, "");
  return new RegExp(`^${escapeRegExp(targetStem)}-\\d+$`).test(stem);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function storePdfToDisk(directory: string, fileName: string, bytes: Uint8Array): Promise<string> {
  const body = new Uint8Array(bytes).buffer as ArrayBuffer;
  return invoke<string>("store_pdf", body, {
    headers: {
      "x-lumora-dir": encodeURIComponent(directory),
      "x-lumora-file-name": encodeURIComponent(fileName)
    }
  });
}

export async function readPdfFromDisk(directory: string, fileName: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_stored_pdf", { dir: directory, fileName });
  return new Uint8Array(buffer);
}

export type StoredFileMetadata = { size: number; modifiedMs: number };

export async function getStoredPdfMetadata(directory: string, fileName: string): Promise<StoredFileMetadata> {
  return invoke<StoredFileMetadata>("stored_pdf_metadata", { dir: directory, fileName });
}

export async function listStoredPdfs(directory: string): Promise<string[]> {
  return invoke<string[]>("list_stored_pdfs", { dir: directory });
}

export async function deleteStoredPdf(directory: string, fileName: string): Promise<void> {
  await invoke("delete_stored_pdf", { dir: directory, fileName });
}

export async function movePdfOnDisk(directory: string, fileName: string, newDirectory: string, newFileName: string): Promise<string> {
  return invoke<string>("move_stored_pdf", {
    dir: directory,
    fileName,
    newDir: newDirectory,
    newFileName
  });
}

// Dual read path: files migrated to disk carry `localPath` (the relative file
// name inside the configured folder); everything else still lives in IndexedDB.
export async function readFileBytes(fileAsset: FileAsset, settings: FileStorageSettings): Promise<Uint8Array | undefined> {
  if (fileAsset.localPath && settings.directory) {
    try {
      return await readPdfFromDisk(settings.directory, fileAsset.localPath);
    } catch {
      // fall through to IndexedDB in case the blob was never cleaned up
    }
  }

  return getFileBytes(fileAsset.id);
}

// Storage-aware import: with a folder configured the PDF goes straight to disk
// (template-named) and IndexedDB is skipped; otherwise the legacy path runs.
export async function importPdf(current: LibraryState, file: File, settings: FileStorageSettings): Promise<ImportedPdf> {
  if (!settings.directory) {
    return importPdfFile(current, file);
  }

  const imported = await importPdfFile(current, file, { skipBlobStore: true });
  const targetName = buildPdfFileName(imported.paper, settings.nameTemplate);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const storedName = await storePdfToDisk(settings.directory, targetName, bytes);
  const fileAsset: FileAsset = { ...imported.fileAsset, fileName: storedName, localPath: storedName };

  return {
    paper: imported.paper,
    fileAsset,
    state: {
      ...imported.state,
      fileAssets: imported.state.fileAssets.map((item) => (item.id === fileAsset.id ? fileAsset : item))
    }
  };
}

export async function bindPdfToPaper(
  current: LibraryState,
  paperId: string,
  file: File,
  settings: FileStorageSettings
): Promise<{ state: LibraryState; fileAsset: FileAsset }> {
  const paper = current.papers.find((item) => item.id === paperId && !item.deletedAt);
  if (!paper) throw new Error("The selected document no longer exists.");
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") throw new Error("Select a PDF file.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const existing = current.fileAssets.find((item) =>
    item.paperId === paperId && !item.deletedAt && (item.mime === "application/pdf" || /\.pdf$/i.test(item.fileName))
  );
  const id = existing?.id ?? createId("file");
  const targetName = buildPdfFileName(paper, settings.nameTemplate);
  let fileName = targetName;
  let localPath: string | undefined;

  if (settings.directory) {
    fileName = await storePdfToDisk(settings.directory, targetName, bytes);
    localPath = fileName;
    await deleteFileBlob(id);
  } else {
    await putFileBlob(id, file);
  }

  const now = new Date().toISOString();
  const fileAsset: FileAsset = {
    ...existing,
    id,
    paperId,
    sha256,
    size: bytes.length,
    mime: "application/pdf",
    fileName,
    contentRef: paper.arxiv
      ? { kind: "arxiv", arxivId: paper.arxiv }
      : { kind: "object", sha256 },
    localPath,
    downloadState: "local",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    deletedAt: undefined
  };
  return {
    fileAsset,
    state: {
      ...current,
      fileAssets: existing
        ? current.fileAssets.map((item) => item.id === existing.id ? fileAsset : item)
        : [fileAsset, ...current.fileAssets]
    }
  };
}

export type MigrationProgress = {
  done: number;
  total: number;
  fileName: string;
};

// Moves every active stored PDF into `nextSettings.directory` with template
// naming. Crash-safe ordering per file: write/move on disk -> persist library
// state synchronously -> only then delete the IndexedDB blob. Re-runs are
// idempotent: files already on disk are moved (same-file guard makes matching
// names a no-op), blobs are only deleted after a successful write.
export async function migrateStoredPdfs(
  current: LibraryState,
  previousSettings: FileStorageSettings,
  nextSettings: FileStorageSettings,
  onProgress?: (progress: MigrationProgress) => void
): Promise<LibraryState> {
  const directory = nextSettings.directory;
  if (!directory) {
    return current;
  }

  const paperById = new Map(current.papers.map((paper) => [paper.id, paper]));
  const candidates = current.fileAssets.filter((fileAsset) => {
    if (fileAsset.deletedAt) {
      return false;
    }
    const paper = paperById.get(fileAsset.paperId);
    return Boolean(paper && !paper.deletedAt);
  });

  let state = current;
  let done = 0;

  for (const fileAsset of candidates) {
    done += 1;
    const paper = paperById.get(fileAsset.paperId);
    if (!paper) {
      continue;
    }

    const targetName = buildPdfFileName(paper, nextSettings.nameTemplate);
    onProgress?.({ done, total: candidates.length, fileName: targetName });

    let storedName: string;
    let cameFromIndexedDb = false;

    if (fileAsset.localPath && previousSettings.directory) {
      if (previousSettings.directory === directory && fileNameMatchesTarget(fileAsset.localPath, targetName)) {
        continue;
      }
      storedName = await movePdfOnDisk(previousSettings.directory, fileAsset.localPath, directory, targetName);
    } else {
      const bytes = await getFileBytes(fileAsset.id);
      if (!bytes) {
        continue;
      }
      storedName = await storePdfToDisk(directory, targetName, bytes);
      cameFromIndexedDb = true;
    }

    const now = new Date().toISOString();
    const nextFileAsset: FileAsset = { ...fileAsset, fileName: storedName, localPath: storedName, updatedAt: now };
    state = {
      ...state,
      fileAssets: state.fileAssets.map((item) => (item.id === fileAsset.id ? nextFileAsset : item))
    };
    // Crash-safe ordering: the row is durably persisted before the blob is
    // deleted, so a crash mid-migration never orphans a file.
    await persistEntities([{ entityType: "fileAsset", entity: nextFileAsset }]);

    if (cameFromIndexedDb) {
      await deleteFileBlob(fileAsset.id);
    }
  }

  return state;
}

// Picks the on-disk file that belongs to `fileAsset` out of the still-available
// names. A record's own localPath/fileName wins outright; otherwise the template
// name (and its `-N` collision variants) is matched so a record that only
// carries metadata — e.g. synced from another device — still binds to the PDF a
// prior device wrote. The chosen name is consumed by the caller so two records
// can never claim the same file.
function resolveDiskName(
  fileAsset: FileAsset,
  paper: Paper,
  template: string,
  available: Set<string>
): string | undefined {
  for (const candidate of [fileAsset.localPath, fileAsset.fileName]) {
    if (candidate && /\.pdf$/i.test(candidate) && available.has(candidate)) {
      return candidate;
    }
  }

  const targetName = buildPdfFileName(paper, template);
  if (available.has(targetName)) {
    return targetName;
  }
  for (const name of available) {
    if (fileNameMatchesTarget(name, targetName)) {
      return name;
    }
  }

  return undefined;
}

// Reconciles library file records against the actual storage directory, making
// the folder the single source of truth for "does this paper have a local PDF".
// Idempotent; safe to run on every startup. Three jobs:
//   1. Drains leftover IndexedDB blobs to disk (post-migration cleanup) so the
//      browser store never retains PDFs once a folder is configured.
//   2. Re-links records whose PDF sits in the folder but lost its `localPath`
//      (cross-device cloud/Mendeley sync, interrupted migrations) — this is what
//      pulls a paper out of "No PDF" and lets it open again.
//   3. Clears stale `localPath`/local flags whose file is genuinely gone, so the
//      paper correctly falls into "No PDF" instead of failing to open.
export async function reconcileFileStorage(
  current: LibraryState,
  settings: FileStorageSettings
): Promise<LibraryState> {
  const directory = settings.directory;
  if (!directory) {
    return current;
  }

  let available: Set<string>;
  try {
    available = new Set(await listStoredPdfs(directory));
  } catch {
    return current; // folder unreadable this run; retried on the next startup
  }

  const paperById = new Map(current.papers.map((paper) => [paper.id, paper]));
  const changed = new Map<string, FileAsset>();
  const now = () => new Date().toISOString();

  // Pass 1: drain any bytes still living in IndexedDB onto disk. Crash-safe
  // ordering — write to disk, then delete the blob only after.
  for (const fileAsset of current.fileAssets) {
    if (fileAsset.deletedAt) continue;
    const paper = paperById.get(fileAsset.paperId);
    if (!paper || paper.deletedAt) continue;

    const blob = await getFileBytes(fileAsset.id);
    if (!blob) continue;

    const storedName = await storePdfToDisk(directory, buildPdfFileName(paper, settings.nameTemplate), blob);
    await deleteFileBlob(fileAsset.id);
    available.add(storedName);
    changed.set(fileAsset.id, {
      ...fileAsset,
      fileName: storedName,
      localPath: storedName,
      downloadState: "local",
      updatedAt: now()
    });
  }

  // Pass 2: bind each remaining record to its file on disk, consuming the name
  // so no two records claim the same file.
  for (const fileAsset of current.fileAssets) {
    if (fileAsset.deletedAt || changed.has(fileAsset.id)) continue;
    const paper = paperById.get(fileAsset.paperId);
    if (!paper || paper.deletedAt) continue;

    const onDisk = resolveDiskName(fileAsset, paper, settings.nameTemplate, available);
    if (onDisk) {
      available.delete(onDisk);
      if (fileAsset.localPath !== onDisk || fileAsset.fileName !== onDisk || fileAsset.downloadState !== "local") {
        changed.set(fileAsset.id, {
          ...fileAsset,
          fileName: onDisk,
          localPath: onDisk,
          downloadState: "local",
          updatedAt: now()
        });
      }
      continue;
    }

    // No file on disk and no blob: a record still claiming to be local is stale.
    // Demote it to "remote" and drop the dangling localPath so it reads as
    // "No PDF" rather than trying to open a file that isn't there.
    if (fileAsset.localPath || fileAsset.downloadState === "local") {
      changed.set(fileAsset.id, {
        ...fileAsset,
        localPath: undefined,
        downloadState: "remote",
        updatedAt: now()
      });
    }
  }

  if (changed.size === 0) {
    return current;
  }

  await persistEntities([...changed.values()].map((entity) => ({ entityType: "fileAsset" as const, entity })));
  return {
    ...current,
    fileAssets: current.fileAssets.map((item) => changed.get(item.id) ?? item)
  };
}
