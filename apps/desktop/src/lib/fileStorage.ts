import { invoke } from "@tauri-apps/api/core";
import type { FileAsset, LibraryState, Paper } from "@lumora/shared";
import { deleteFileBlob, getFileBytes, importPdfFile, type ImportedPdf } from "./localStore";
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
