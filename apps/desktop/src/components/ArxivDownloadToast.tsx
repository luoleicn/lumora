import { X } from "lucide-react";
import { formatFileSize, type ArxivDownloadProgress } from "../lib/arxivFiles";

export function ArxivDownloadToast({
  progress,
  onDismiss
}: {
  progress: ArxivDownloadProgress;
  onDismiss: () => void;
}) {
  const { phase, done, total, arxivId, downloadedBytes, totalBytes } = progress;
  const position = Math.min(total, done + (phase === "downloading" ? 1 : 0));
  // Fold the current file's byte progress into the overall bar so it moves
  // smoothly during large downloads instead of jumping once per file.
  const fileFraction = phase === "downloading" && totalBytes
    ? Math.min(1, (downloadedBytes ?? 0) / totalBytes)
    : 0;
  const overallPercent = total > 0 ? Math.min(100, ((done + fileFraction) / total) * 100) : 0;
  const title = phase === "checking"
    ? `Checking arXiv files (${position}/${total})`
    : phase === "waiting"
      ? `Waiting for arXiv (${position}/${total})`
      : `Downloading arXiv PDFs (${position}/${total})`;
  const byteText = phase === "downloading" && downloadedBytes !== undefined
    ? `${formatFileSize(downloadedBytes)}${totalBytes ? ` / ${formatFileSize(totalBytes)}` : ""}`
    : undefined;

  return (
    <div className="arxiv-download-toast" role="status" aria-label="arXiv batch download progress">
      <header>
        <strong>{title}</strong>
        <button type="button" onClick={onDismiss} aria-label="Hide download progress">
          <X size={14} />
        </button>
      </header>
      <div className="arxiv-download-progress">
        <div className={phase === "checking" ? "indeterminate" : "determinate"}>
          <span style={phase === "checking" ? undefined : { width: `${overallPercent}%` }} />
        </div>
        <small>
          {arxivId ? `arXiv:${arxivId}` : ""}
          {arxivId && byteText ? " — " : ""}
          {byteText ?? ""}
        </small>
      </div>
    </div>
  );
}
