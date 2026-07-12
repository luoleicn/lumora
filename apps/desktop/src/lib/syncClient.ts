import { invoke } from "@tauri-apps/api/core";
import type { ArxivMetadata, CloudSyncConfig, CloudSyncSummary, LibraryState } from "@lumora/shared";
import { loadLibraryFromDb, persistEntities } from "./libraryDb";
import { getStoredPdfMetadata, loadFileStorageSettings, readFileBytes, storePdfToDisk } from "./fileStorage";
import { putFileBlob } from "./localStore";
import { normalizeArxivId } from "./arxivFiles";

export type SyncSettings = CloudSyncConfig & {
  /** Entered only while saving; Rust stores it in the system keychain. */
  secretKey?: string;
};

export const defaultSyncSettings: SyncSettings = {
  accessKey: "",
  bucket: "",
  region: "",
  privateDomain: "",
  prefix: "lumora/v1",
  configured: false
};

/** Device-local scheduling preference for the background periodic sync. */
export type AutoSyncSettings = {
  enabled: boolean;
  intervalMinutes: number;
};

const autoSyncSettingsKey = "lumora:auto-sync-settings";
export const defaultAutoSyncIntervalMinutes = 60;
const minAutoSyncIntervalMinutes = 1;
const maxAutoSyncIntervalMinutes = 24 * 60;

export const defaultAutoSyncSettings: AutoSyncSettings = {
  enabled: true,
  intervalMinutes: defaultAutoSyncIntervalMinutes
};

type QiniuObjectStat = { exists: boolean; size?: number };
type VerifiedLocalFile = {
  sha256: string;
  storage: "disk" | "indexedDb";
  path?: string;
  size: number;
  modifiedMs?: number;
};

const verifiedLocalFilesKey = "lumora:qiniu-verified-local-files-v1";
const sha256Pattern = /^[a-f0-9]{64}$/i;

function loadVerifiedLocalFiles(): Record<string, VerifiedLocalFile> {
  try {
    return JSON.parse(localStorage.getItem(verifiedLocalFilesKey) ?? "{}") as Record<string, VerifiedLocalFile>;
  } catch {
    return {};
  }
}

function saveVerifiedLocalFiles(files: Record<string, VerifiedLocalFile>) {
  try {
    localStorage.setItem(verifiedLocalFilesKey, JSON.stringify(files));
  } catch {
    // Verification is only an optimization. A full read next time is safe.
  }
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  }));
}

export function normalizeAutoSyncInterval(value: unknown): number {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return defaultAutoSyncIntervalMinutes;
  return Math.min(Math.max(minutes, minAutoSyncIntervalMinutes), maxAutoSyncIntervalMinutes);
}

export function loadAutoSyncSettings(): AutoSyncSettings {
  const raw = localStorage.getItem(autoSyncSettingsKey);
  if (!raw) return defaultAutoSyncSettings;
  try {
    const parsed = JSON.parse(raw) as Partial<AutoSyncSettings>;
    return {
      enabled: parsed.enabled ?? defaultAutoSyncSettings.enabled,
      intervalMinutes: normalizeAutoSyncInterval(parsed.intervalMinutes)
    };
  } catch {
    return defaultAutoSyncSettings;
  }
}

export function saveAutoSyncSettings(settings: AutoSyncSettings) {
  localStorage.setItem(autoSyncSettingsKey, JSON.stringify({
    enabled: settings.enabled,
    intervalMinutes: normalizeAutoSyncInterval(settings.intervalMinutes)
  }));
}

export async function loadSyncConfig(): Promise<SyncSettings> {
  return (await invoke<CloudSyncConfig | null>("qiniu_sync_config")) ?? defaultSyncSettings;
}

export async function saveSyncConfig(settings: SyncSettings): Promise<SyncSettings> {
  if (!settings.secretKey) throw new Error("Secret Key is required when saving Qiniu settings.");
  return invoke<CloudSyncConfig>("qiniu_save_sync_config", {
    request: {
      accessKey: settings.accessKey,
      secretKey: settings.secretKey,
      bucket: settings.bucket,
      region: settings.region,
      privateDomain: settings.privateDomain
    }
  });
}

export async function testSyncConnection(): Promise<void> {
  await invoke("qiniu_test_sync_connection");
}

export async function disconnectSync(): Promise<void> {
  await invoke("qiniu_disconnect_sync");
}

export async function syncLibrary(
  _settings: SyncSettings,
  _state: LibraryState,
  onStage?: (message: string, completed?: number, total?: number) => void
): Promise<{ state: LibraryState; summary: CloudSyncSummary }> {
  let prepared = _state;
  const storage = loadFileStorageSettings();
  const paperById = new Map(prepared.papers.map((paper) => [paper.id, paper]));
  const promotedObjectHashes = new Set<string>();
  const nextFiles = [] as typeof prepared.fileAssets;

  onStage?.("Preparing library…", 0, 5);
  const uploadableTotal = prepared.fileAssets.filter((file) => {
    if (file.deletedAt) return false;
    const paper = paperById.get(file.paperId);
    const arxivId = paper?.arxiv ? normalizeArxivId(paper.arxiv) : undefined;
    return !(arxivId && (file.mime === "application/pdf" || /\.pdf$/i.test(file.fileName)));
  }).length;
  let uploadedBlobs = 0;
  let uploadedFileOk = 0;
  let consecutiveFailures = 0;
  const uploadErrors: string[] = [];

  // A successful content hash is cached against device-local file metadata.
  // Only an unchanged local file may use its recorded SHA for the cheap cloud
  // Stat path; otherwise the full file is read and hashed below.
  const verifiedLocalFiles = loadVerifiedLocalFiles();
  const preflight = new Map<string, QiniuObjectStat>();
  const statPromises = new Map<string, Promise<QiniuObjectStat>>();
  const ordinaryFiles = prepared.fileAssets.filter((file) => {
    if (file.deletedAt) return false;
    const paper = paperById.get(file.paperId);
    const arxivId = paper?.arxiv ? normalizeArxivId(paper.arxiv) : undefined;
    return !(arxivId && (file.mime === "application/pdf" || /\.pdf$/i.test(file.fileName)));
  });
  await mapWithConcurrency(ordinaryFiles, 6, async (file) => {
    const sha256 = file.sha256.trim().toLowerCase();
    if (!sha256Pattern.test(sha256)
      || file.contentRef?.kind !== "object"
      || file.contentRef.sha256.toLowerCase() !== sha256) return;

    const verified = verifiedLocalFiles[file.id];
    if (!verified || verified.sha256 !== sha256 || verified.size !== file.size) return;
    if (file.localPath && storage.directory) {
      if (verified.storage !== "disk" || verified.path !== file.localPath) return;
      try {
        const metadata = await getStoredPdfMetadata(storage.directory, file.localPath);
        if (metadata.size !== verified.size || metadata.modifiedMs !== verified.modifiedMs) return;
      } catch {
        return;
      }
    } else if (verified.storage !== "indexedDb") {
      return;
    }

    let request = statPromises.get(sha256);
    if (!request) {
      request = invoke<QiniuObjectStat>("qiniu_object_exists", { sha256 });
      statPromises.set(sha256, request);
    }
    const stat = await request;
    if (stat.exists && stat.size !== file.size) {
      throw new Error(`Cloud blob ${sha256} has size ${stat.size ?? "unknown"}, expected ${file.size}; refusing to trust it.`);
    }
    preflight.set(file.id, stat);
  });

  for (const file of prepared.fileAssets) {
    if (file.deletedAt) {
      nextFiles.push(file);
      continue;
    }
    const paper = paperById.get(file.paperId);
    const arxivId = paper?.arxiv ? normalizeArxivId(paper.arxiv) : undefined;
    if (arxivId && (file.mime === "application/pdf" || /\.pdf$/i.test(file.fileName))) {
      if (file.contentRef?.kind === "object") promotedObjectHashes.add(file.contentRef.sha256);
      nextFiles.push(file.contentRef?.kind === "arxiv" && file.contentRef.arxivId === arxivId
        ? file
        : { ...file, contentRef: { kind: "arxiv" as const, arxivId }, updatedAt: new Date().toISOString() });
      continue;
    }

    if (preflight.get(file.id)?.exists) {
      nextFiles.push(file);
      continue;
    }

    const diskMetadataBefore = file.localPath && storage.directory
      ? await getStoredPdfMetadata(storage.directory, file.localPath).catch(() => undefined)
      : undefined;
    const bytes = await readFileBytes(file, storage);
    if (bytes?.length) {
      uploadedBlobs += 1;
      onStage?.(`Uploading files ${uploadedBlobs}/${uploadableTotal}: ${file.fileName}`, 1, 5);
      // Content-address the blob by the real hash of the actual bytes. Mendeley
      // imports carry a synthetic `sha256` ("mendeley-sha1:…"/"mendeley-note:…")
      // that never matches the content, so trusting file.sha256 here both keys
      // the blob wrong and trips the Rust integrity check. Heal the metadata to
      // the real hash so the upload succeeds and other devices can find it.
      const buffer = new Uint8Array(bytes).buffer as ArrayBuffer;
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
        (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (file.localPath && storage.directory && diskMetadataBefore) {
        const metadataAfter = await getStoredPdfMetadata(storage.directory, file.localPath).catch(() => undefined);
        if (metadataAfter
          && metadataAfter.size === diskMetadataBefore.size
          && metadataAfter.modifiedMs === diskMetadataBefore.modifiedMs) {
          verifiedLocalFiles[file.id] = {
            sha256, storage: "disk", path: file.localPath,
            size: metadataAfter.size, modifiedMs: metadataAfter.modifiedMs
          };
          saveVerifiedLocalFiles(verifiedLocalFiles);
        }
      } else if (!file.localPath || !storage.directory) {
        verifiedLocalFiles[file.id] = { sha256, storage: "indexedDb", size: bytes.length };
        saveVerifiedLocalFiles(verifiedLocalFiles);
      }
      try {
        await invoke<void>("qiniu_upload_blob", buffer, {
          headers: { "x-lumora-sha256": sha256 }
        });
      } catch (error) {
        // One bad file must not abort the whole library sync. Record it, keep
        // the file unchanged, and move on — but bail out fast if uploads fail
        // systemically (e.g. a wrong region) instead of grinding through
        // hundreds of doomed attempts.
        const detail = error instanceof Error ? error.message : String(error);
        uploadErrors.push(`${file.fileName}: ${detail}`);
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          throw new Error(`Cloud sync aborted after ${consecutiveFailures} consecutive upload failures. Latest — ${file.fileName}: ${detail}`);
        }
        nextFiles.push(file);
        continue;
      }
      consecutiveFailures = 0;
      uploadedFileOk += 1;
      const healed = file.sha256 === sha256 && file.contentRef?.kind === "object" && file.contentRef.sha256 === sha256
        ? file
        : { ...file, sha256, size: bytes.length, contentRef: { kind: "object" as const, sha256 }, updatedAt: new Date().toISOString() };
      // Persist each heal immediately so a crash or app close mid-sync keeps the
      // progress instead of re-uploading everything on the next run.
      if (healed !== file) await persistEntities([{ entityType: "fileAsset" as const, entity: healed }]);
      nextFiles.push(healed);
      continue;
    }
    nextFiles.push(file.contentRef?.kind === "object"
      ? file
      : { ...file, contentRef: { kind: "object" as const, sha256: file.sha256 }, updatedAt: new Date().toISOString() });
  }

  if (nextFiles.some((file, index) => file !== prepared.fileAssets[index])) {
    prepared = { ...prepared, fileAssets: nextFiles };
    await persistEntities(nextFiles
      .filter((file, index) => file !== _state.fileAssets[index])
      .map((entity) => ({ entityType: "fileAsset" as const, entity })));
  }

  onStage?.("Syncing changes with Qiniu…", 2, 5);
  const summary = await invoke<CloudSyncSummary>("qiniu_sync_library");
  summary.uploadedFiles += uploadedFileOk;
  summary.errors.push(...uploadErrors);
  let { state } = await loadLibraryFromDb();

  // macOS keeps a complete local mirror. Device-local path/status changes are
  // persisted as remote-source writes so they never enter the cloud outbox.
  const downloadedFiles = [...state.fileAssets];
  for (const [index, file] of downloadedFiles.entries()) {
    if (file.deletedAt || file.contentRef?.kind !== "object") continue;
    if ((await readFileBytes(file, storage))?.length) continue;
    onStage?.(`Downloading file from cloud: ${file.fileName}`, 3, 5);
    const buffer = await invoke<ArrayBuffer>("qiniu_download_blob", { sha256: file.contentRef.sha256 });
    const bytes = new Uint8Array(buffer);
    let localPath: string | undefined;
    if (storage.directory) {
      localPath = await storePdfToDisk(storage.directory, file.fileName, bytes);
    } else {
      await putFileBlob(file.id, new Blob([bytes], { type: file.mime }));
    }
    downloadedFiles[index] = { ...file, localPath, downloadState: "local" };
    summary.downloadedFiles += 1;
  }
  if (downloadedFiles.some((file, index) => file !== state.fileAssets[index])) {
    await persistEntities(downloadedFiles
      .filter((file, index) => file !== state.fileAssets[index])
      .map((entity) => ({ entityType: "fileAsset" as const, entity })), "remote");
    state = { ...state, fileAssets: downloadedFiles };
  }

  // Qiniu sync deliberately never contacts arXiv. Missing arXiv-backed PDFs
  // remain metadata-only until the user invokes the separate download action.
  onStage?.("Finalizing cloud references…", 4, 5);

  const referencedObjectHashes = new Set(state.fileAssets
    .filter((file) => !file.deletedAt && file.contentRef?.kind === "object")
    .map((file) => file.contentRef?.kind === "object" ? file.contentRef.sha256 : ""));
  for (const hash of promotedObjectHashes) {
    if (!referencedObjectHashes.has(hash)) await invoke("qiniu_delete_blob", { sha256: hash });
  }

  return { state, summary };
}

export async function searchArxivMetadata(_settings: SyncSettings, title: string): Promise<ArxivMetadata[]> {
  return invoke<ArxivMetadata[]>("search_arxiv_by_title", { title });
}
