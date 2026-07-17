import { useRef, useState } from "react";
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
  const inFlightRef = useRef(false);
  const toastDismissedRef = useRef(false);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  async function download(
    paperId?: string,
    detailProgress?: (progress: ArxivDownloadProgress) => void
  ): Promise<string> {
    if (inFlightRef.current) {
      const message = "arXiv file download is already running.";
      onStatusRef.current(message);
      return message;
    }
    inFlightRef.current = true;
    setDownloadBusy(true);
    toastDismissedRef.current = false;
    const isBatch = !paperId;
    const startingState = store.libraryRef.current ?? store.library;
    const startingFiles = new Map(startingState.fileAssets.map((file) => [file.id, file]));
    try {
      const result = await downloadMissingArxivFiles(startingState, fileStorageSettings, {
        paperIds: paperId ? [paperId] : undefined,
        onProgress: (progress) => {
          detailProgress?.(progress);
          if (isBatch && !toastDismissedRef.current) {
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
      inFlightRef.current = false;
      setDownloadBusy(false);
      setBatchProgress(undefined);
    }
  }

  function dismissBatchToast() {
    toastDismissedRef.current = true;
    setBatchProgress(undefined);
  }

  return {
    downloadBusy,
    batchProgress,
    download,
    dismissBatchToast
  };
}
