import { useRef, useState } from "react";
import type { Paper } from "@lumora/shared";
import { downloadMissingArxivFiles, formatFileSize, type ArxivDownloadProgress } from "../lib/arxivFiles";
import type { FileStorageSettings } from "../lib/fileStorage";
import { upsertById } from "../lib/localStore";
import type { LibraryStore } from "./useLibraryStore";

export type UseArxivDownloadsOptions = {
  store: LibraryStore;
  fileStorageSettings: FileStorageSettings;
  onStatus: (message: string) => void;
};

/**
 * arXiv PDF download orchestration: single-paper and batch downloads, the
 * batch progress toast, and folding finished downloads into the library as
 * they land.
 */
export function useArxivDownloads({ store, fileStorageSettings, onStatus }: UseArxivDownloadsOptions) {
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<ArxivDownloadProgress>();
  const activeDownloadRef = useRef<Promise<string> | undefined>(undefined);
  const toastDismissedRef = useRef(false);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  async function runDownload(
    paperId?: string,
    detailProgress?: (progress: ArxivDownloadProgress) => void,
    importedPaper?: Paper
  ): Promise<string> {
    setDownloadBusy(true);
    toastDismissedRef.current = false;
    const showToast = !paperId || Boolean(importedPaper);
    const current = store.libraryRef.current ?? store.library;
    // Import starts the download before React necessarily commits the new paper.
    const startingState = importedPaper && !current.papers.some((paper) => paper.id === importedPaper.id)
      ? { ...current, papers: [importedPaper, ...current.papers] }
      : current;
    const startingFiles = new Map(startingState.fileAssets.map((file) => [file.id, file]));
    try {
      const result = await downloadMissingArxivFiles(startingState, fileStorageSettings, {
        paperIds: paperId ? [paperId] : undefined,
        onProgress: (progress) => {
          detailProgress?.(progress);
          if (showToast && !toastDismissedRef.current) {
            setBatchProgress(progress.total > 0 ? progress : undefined);
          }
          const position = Math.min(progress.total, progress.done + (progress.phase === "downloading" ? 1 : 0));
          const byteProgress = progress.downloadedBytes !== undefined
            ? ` — ${formatFileSize(progress.downloadedBytes)}${progress.totalBytes ? ` / ${formatFileSize(progress.totalBytes)}` : ""}`
            : "";
          onStatusRef.current(progress.total === 0
            ? "No missing arXiv PDFs found."
            : `${progress.phase === "checking" ? "Checking" : progress.phase === "waiting" ? "Waiting for arXiv" : "Downloading arXiv PDF"} `
              + `(${position}/${progress.total})${progress.arxivId ? `: ${progress.arxivId}` : ""}${byteProgress}`);
        },
        onStateUpdate: (partialState) => {
          const downloadedFiles = partialState.fileAssets.filter((file) => {
            const before = startingFiles.get(file.id);
            return !before || before.sha256 !== file.sha256 || before.downloadState !== file.downloadState || before.localPath !== file.localPath;
          });
          store.setLibrary((current) => ({
            ...current,
            fileAssets: downloadedFiles.reduce((items, file) => upsertById(items, file), current.fileAssets)
          }));
        }
      });
      const message =
        `arXiv files: ${result.downloaded} downloaded, ${result.alreadyPresent} already present`
        + (result.failed.length ? `, ${result.failed.length} failed (${result.failed.map((item) => item.arxivId).join(", ")}).` : ".");
      onStatusRef.current(message);
      return message;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onStatusRef.current(message);
      return message;
    } finally {
      setDownloadBusy(false);
      setBatchProgress(undefined);
    }
  }

  function startDownload(
    paperId?: string,
    detailProgress?: (progress: ArxivDownloadProgress) => void,
    importedPaper?: Paper
  ): Promise<string> {
    const pending = runDownload(paperId, detailProgress, importedPaper);
    activeDownloadRef.current = pending;
    void pending.then(() => {
      if (activeDownloadRef.current === pending) activeDownloadRef.current = undefined;
    });
    return pending;
  }

  function download(paperId?: string, detailProgress?: (progress: ArxivDownloadProgress) => void): Promise<string> {
    if (activeDownloadRef.current) {
      const message = "arXiv file download is already running.";
      onStatusRef.current(message);
      return Promise.resolve(message);
    }
    return startDownload(paperId, detailProgress);
  }

  async function downloadImportedPaper(paper: Paper): Promise<string> {
    // A running batch must not cause an automatically requested PDF to be skipped.
    while (activeDownloadRef.current) await activeDownloadRef.current;
    return startDownload(paper.id, undefined, paper);
  }

  function dismissBatchToast() {
    toastDismissedRef.current = true;
    setBatchProgress(undefined);
  }

  return {
    downloadBusy,
    batchProgress,
    download,
    downloadImportedPaper,
    dismissBatchToast
  };
}
