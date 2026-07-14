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

type QiniuNetworkStats = Pick<CloudSyncSummary,
  "requestCount" | "putRequests" | "getRequests" | "headRequests" | "deleteRequests" | "uploadedBytes" | "downloadedBytes">;
type QiniuObjectStat = { exists: boolean; size?: number; stats: QiniuNetworkStats };
type QiniuBlobUploadResult = {
  uploaded: boolean;
  stats: QiniuNetworkStats;
  error?: { kind: "file" | "fatal"; message: string };
};
type VerifiedLocalFile = {
  sha256: string;
  storage: "disk" | "indexedDb";
  path?: string;
  size: number;
  modifiedMs?: number;
  cloudTarget?: string;
  cloudVerifiedAt?: number;
};

const verifiedLocalFilesKey = "lumora:qiniu-verified-local-files-v1";
const cloudVerificationTtlMs = 24 * 60 * 60 * 1_000;
const sha256Pattern = /^[a-f0-9]{64}$/i;

function emptyNetworkStats(): QiniuNetworkStats {
  return {
    requestCount: 0,
    putRequests: 0,
    getRequests: 0,
    headRequests: 0,
    deleteRequests: 0,
    uploadedBytes: 0,
    downloadedBytes: 0
  };
}

function addNetworkStats(target: QiniuNetworkStats, source: Partial<QiniuNetworkStats>) {
  target.requestCount += source.requestCount ?? 0;
  target.putRequests += source.putRequests ?? 0;
  target.getRequests += source.getRequests ?? 0;
  target.headRequests += source.headRequests ?? 0;
  target.deleteRequests += source.deleteRequests ?? 0;
  target.uploadedBytes += source.uploadedBytes ?? 0;
  target.downloadedBytes += source.downloadedBytes ?? 0;
}

function cloudTargetKey(settings: SyncSettings): string {
  return JSON.stringify([
    settings.accessKey,
    settings.bucket,
    settings.region ?? "",
    settings.privateDomain,
    settings.prefix
  ]);
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
  let fileUploadFailures = 0;
  let uploadsSuspended = false;
  const uploadErrors: string[] = [];
  const preSyncNetworkStats = emptyNetworkStats();
  const cloudTarget = cloudTargetKey(_settings);
  const cloudVerificationCutoff = Date.now() - cloudVerificationTtlMs;

  // A successful content hash is cached against device-local file metadata.
  // Only an unchanged local file may use its recorded SHA for the cheap cloud
  // Stat path; otherwise the full file is read and hashed below.
  const verifiedLocalFiles = loadVerifiedLocalFiles();
  const preflight = new Map<string, QiniuObjectStat>();
  const statPromises = new Map<string, Promise<QiniuObjectStat>>();
  const ensuredCloudHashes = new Set<string>();
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

    if (verified.cloudTarget === cloudTarget
      && (verified.cloudVerifiedAt ?? 0) >= cloudVerificationCutoff) {
      preflight.set(file.id, { exists: true, size: file.size, stats: emptyNetworkStats() });
      return;
    }

    let request = statPromises.get(sha256);
    if (!request) {
      request = invoke<QiniuObjectStat>("qiniu_object_exists", { sha256 }).then((stat) => {
        addNetworkStats(preSyncNetworkStats, stat.stats);
        return stat;
      });
      statPromises.set(sha256, request);
    }
    const stat = await request;
    if (stat.exists && stat.size !== file.size) {
      throw new Error(`Cloud blob ${sha256} has size ${stat.size ?? "unknown"}, expected ${file.size}; refusing to trust it.`);
    }
    if (stat.exists) {
      verifiedLocalFiles[file.id] = {
        ...verified,
        cloudTarget,
        cloudVerifiedAt: Date.now()
      };
    }
    preflight.set(file.id, stat);
  });
  saveVerifiedLocalFiles(verifiedLocalFiles);

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
      ensuredCloudHashes.add(file.sha256.trim().toLowerCase());
      nextFiles.push(file);
      continue;
    }

    if (uploadsSuspended) {
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
      const sha256 = await sha256Hex(buffer);
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
        const uploadResult: QiniuBlobUploadResult = ensuredCloudHashes.has(sha256)
          ? { uploaded: false, stats: emptyNetworkStats() }
          : await invoke<QiniuBlobUploadResult>("qiniu_upload_blob", buffer, {
            headers: { "x-lumora-sha256": sha256 }
          });
        addNetworkStats(preSyncNetworkStats, uploadResult.stats);
        if (uploadResult.error?.kind === "fatal") {
          throw new Error(uploadResult.error.message);
        }
        if (uploadResult.error) {
          uploadErrors.push(`${file.fileName}: ${uploadResult.error.message}`);
          fileUploadFailures += 1;
          if (fileUploadFailures >= 5) {
            uploadsSuspended = true;
            uploadErrors.push("Further file uploads were skipped after 5 file-specific failures; metadata sync continued.");
          }
          nextFiles.push(file);
          continue;
        }
        ensuredCloudHashes.add(sha256);
        const localVerification = verifiedLocalFiles[file.id];
        if (localVerification?.sha256 === sha256) {
          verifiedLocalFiles[file.id] = {
            ...localVerification,
            cloudTarget,
            cloudVerifiedAt: Date.now()
          };
          saveVerifiedLocalFiles(verifiedLocalFiles);
        }
        if (uploadResult.uploaded) uploadedFileOk += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Cloud upload failed for ${file.fileName}: ${detail}`);
      }
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
  addNetworkStats(summary, preSyncNetworkStats);
  summary.uploadedFiles += uploadedFileOk;
  summary.errors.push(...uploadErrors);
  let { state } = await loadLibraryFromDb();

  // macOS keeps a complete local mirror. Device-local path/status changes are
  // persisted as remote-source writes so they never enter the cloud outbox.
  const downloadedFiles = [...state.fileAssets];
  const downloadErrors: string[] = [];
  let consecutiveDownloadFailures = 0;
  const indicesBySha256 = new Map<string, number[]>();
  for (const [index, file] of downloadedFiles.entries()) {
    if (file.deletedAt || file.contentRef?.kind !== "object") continue;
    // A synthetic Mendeley hash ("mendeley-sha1:…"/"mendeley-note:…") is a
    // placeholder for a file whose real bytes were never available to upload.
    if (file.contentRef.sha256.startsWith("mendeley-")) continue;
    const sha256 = file.contentRef.sha256.toLowerCase();
    const indices = indicesBySha256.get(sha256) ?? [];
    indices.push(index);
    indicesBySha256.set(sha256, indices);
  }

  for (const [sha256, indices] of indicesBySha256) {
    const missingIndices: number[] = [];
    let sharedBytes: Uint8Array | undefined;
    for (const index of indices) {
      const localBytes = await readFileBytes(downloadedFiles[index], storage);
      if (localBytes?.length) {
        sharedBytes ??= localBytes;
      } else {
        missingIndices.push(index);
      }
    }
    if (missingIndices.length === 0) continue;

    if (sharedBytes) {
      const localBuffer = new Uint8Array(sharedBytes).buffer as ArrayBuffer;
      const localSha256 = await sha256Hex(localBuffer);
      if (localSha256 !== sha256) sharedBytes = undefined;
    }

    if (!sharedBytes) {
      const firstMissing = downloadedFiles[missingIndices[0]];
      onStage?.(`Downloading file from cloud: ${firstMissing.fileName}`, 3, 5);
      try {
        const buffer = await invoke<ArrayBuffer>("qiniu_download_blob", { sha256 });
        sharedBytes = new Uint8Array(buffer);
        addNetworkStats(summary, {
          requestCount: 1,
          getRequests: 1,
          downloadedBytes: sharedBytes.byteLength
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        downloadErrors.push(`${firstMissing.fileName}: ${detail}`);
        consecutiveDownloadFailures += 1;
        if (consecutiveDownloadFailures >= 5) {
          summary.errors.push(...downloadErrors);
          throw new Error(`Cloud sync aborted after ${consecutiveDownloadFailures} consecutive download failures. Latest — ${firstMissing.fileName}: ${detail}`);
        }
        continue;
      }
    }

    // Materialize every FileAsset that references this content, but retain only
    // one copy of the cloud response in memory and persist each success at once.
    for (const index of missingIndices) {
      const file = downloadedFiles[index];
      try {
        let localPath: string | undefined;
        if (storage.directory) {
          localPath = await storePdfToDisk(storage.directory, file.fileName, sharedBytes);
        } else {
          const blobBuffer = new Uint8Array(sharedBytes).buffer as ArrayBuffer;
          await putFileBlob(file.id, new Blob([blobBuffer], { type: file.mime }));
        }
        const downloaded = { ...file, localPath, downloadState: "local" as const };
        await persistEntities([{ entityType: "fileAsset" as const, entity: downloaded }], "remote");
        downloadedFiles[index] = downloaded;
        summary.downloadedFiles += 1;
        consecutiveDownloadFailures = 0;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        downloadErrors.push(`${file.fileName}: ${detail}`);
        consecutiveDownloadFailures += 1;
        if (consecutiveDownloadFailures >= 5) {
          summary.errors.push(...downloadErrors);
          throw new Error(`Cloud sync aborted after ${consecutiveDownloadFailures} consecutive download failures. Latest — ${file.fileName}: ${detail}`);
        }
      }
    }
  }
  summary.errors.push(...downloadErrors);
  if (downloadedFiles.some((file, index) => file !== state.fileAssets[index])) {
    state = { ...state, fileAssets: downloadedFiles };
  }

  // Qiniu sync deliberately never contacts arXiv. Missing arXiv-backed PDFs
  // remain metadata-only until the user invokes the separate download action.
  onStage?.("Finalizing cloud references…", 4, 5);

  const referencedObjectHashes = new Set(state.fileAssets
    .filter((file) => !file.deletedAt && file.contentRef?.kind === "object")
    .map((file) => file.contentRef?.kind === "object" ? file.contentRef.sha256 : ""));
  for (const hash of promotedObjectHashes) {
    if (!referencedObjectHashes.has(hash)) {
      const deleteStats = await invoke<QiniuNetworkStats>("qiniu_delete_blob", { sha256: hash });
      addNetworkStats(summary, deleteStats);
    }
  }

  return { state, summary };
}

export async function searchArxivMetadata(_settings: SyncSettings, title: string): Promise<ArxivMetadata[]> {
  return invoke<ArxivMetadata[]>("search_arxiv_by_title", { title });
}
