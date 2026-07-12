import { invoke } from "@tauri-apps/api/core";
import type { ArxivMetadata, CloudSyncConfig, CloudSyncSummary, LibraryState } from "@lumora/shared";
import { loadLibraryFromDb, persistEntities } from "./libraryDb";
import { loadFileStorageSettings, readFileBytes, storePdfToDisk } from "./fileStorage";
import { putFileBlob } from "./localStore";
import { downloadMissingArxivFiles, normalizeArxivId } from "./arxivFiles";

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

export async function syncLibrary(_settings: SyncSettings, _state: LibraryState): Promise<{ state: LibraryState; summary: CloudSyncSummary }> {
  let prepared = _state;
  const storage = loadFileStorageSettings();
  const paperById = new Map(prepared.papers.map((paper) => [paper.id, paper]));
  const promotedObjectHashes = new Set<string>();
  const nextFiles = [] as typeof prepared.fileAssets;

  for (const file of prepared.fileAssets) {
    if (file.deletedAt) {
      nextFiles.push(file);
      continue;
    }
    const paper = paperById.get(file.paperId);
    const arxivId = paper?.arxiv ? normalizeArxivId(paper.arxiv) : undefined;
    if (arxivId && (file.mime === "application/pdf" || /\.pdf$/i.test(file.fileName))) {
      if (file.contentRef?.kind === "object") promotedObjectHashes.add(file.contentRef.sha256);
      let next = file;
      if (file.contentRef?.kind !== "arxiv" || file.contentRef.arxivId !== arxivId) {
        const arxivBuffer = await invoke<ArrayBuffer>("download_arxiv_pdf", { arxivId });
        const arxivBytes = new Uint8Array(arxivBuffer);
        const arxivSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", arxivBytes)),
          (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (arxivSha !== file.sha256) {
          const confirmed = window.confirm(
            `The local PDF for “${paper?.title ?? file.fileName}” differs from arXiv:${arxivId}. `
            + "Switching can detach existing highlight coordinates. Replace the local PDF and use arXiv anyway?"
          );
          if (!confirmed) {
            promotedObjectHashes.delete(file.contentRef?.kind === "object" ? file.contentRef.sha256 : "");
            nextFiles.push(file);
            continue;
          }
          let localPath: string | undefined;
          if (storage.directory) {
            localPath = await storePdfToDisk(storage.directory, file.fileName, arxivBytes);
          } else {
            await putFileBlob(file.id, new Blob([arxivBytes], { type: "application/pdf" }));
          }
          next = { ...file, sha256: arxivSha, size: arxivBytes.length, localPath, downloadState: "local" };
        }
        next = {
          ...next,
          contentRef: { kind: "arxiv" as const, arxivId },
          updatedAt: new Date().toISOString()
        };
      }
      nextFiles.push(next);
      continue;
    }

    const bytes = await readFileBytes(file, storage);
    if (bytes?.length) {
      await invoke<void>("qiniu_upload_blob", new Uint8Array(bytes).buffer as ArrayBuffer, {
        headers: { "x-lumora-sha256": file.sha256 }
      });
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

  const summary = await invoke<CloudSyncSummary>("qiniu_sync_library");
  let { state } = await loadLibraryFromDb();

  // macOS keeps a complete local mirror. Device-local path/status changes are
  // persisted as remote-source writes so they never enter the cloud outbox.
  const downloadedFiles = [...state.fileAssets];
  for (const [index, file] of downloadedFiles.entries()) {
    if (file.deletedAt || file.contentRef?.kind !== "object") continue;
    if ((await readFileBytes(file, storage))?.length) continue;
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

  const arxiv = await downloadMissingArxivFiles(state, storage, { sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
  if (arxiv.downloaded > 0) {
    await persistEntities(arxiv.state.fileAssets
      .filter((file) => state.fileAssets.find((existing) => existing.id === file.id) !== file)
      .map((entity) => ({ entityType: "fileAsset" as const, entity })), "remote");
    state = arxiv.state;
    summary.arxivDownloads += arxiv.downloaded;
    summary.errors.push(...arxiv.failed.map((failure) => `arXiv:${failure.arxivId}: ${failure.error}`));
  }

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
