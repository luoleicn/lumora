import { DatabaseZap, Download, ExternalLink, Files, FileSearch, FolderOpen, GraduationCap, Search, Send } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Annotation, ArxivMetadata, FileAsset, Paper } from "@lumora/shared";
import { invoke } from "@tauri-apps/api/core";
import { searchArxivMetadata, type SyncSettings } from "../lib/syncClient";
import { arxivMetadataToPaperPatch, formatFileSize, type ArxivDownloadProgress } from "../lib/arxivFiles";
import type { FileStorageSettings } from "../lib/fileStorage";
import { PaperNotesTab } from "./PaperNotesTab";

type SyncPanelProps = {
  settings: SyncSettings;
  paper?: Paper;
  selectedPaperCount: number;
  fileAsset?: FileAsset;
  fileData?: Uint8Array;
  onRequestFileData: () => Promise<Uint8Array | undefined>;
  hasLocalPdf: boolean;
  annotations: Annotation[];
  fileStorageSettings: FileStorageSettings;
  onUpdatePaper: (paper: Paper) => void;
  arxivDownloadBusy: boolean;
  onDownloadArxiv: (paperId: string, onProgress: (progress: ArxivDownloadProgress) => void) => Promise<string>;
  onDeleteAnnotation: (annotation: Annotation) => void;
};

export function SyncPanel({
  settings,
  paper,
  selectedPaperCount,
  fileAsset,
  fileData,
  onRequestFileData,
  hasLocalPdf,
  annotations,
  fileStorageSettings,
  onUpdatePaper,
  arxivDownloadBusy,
  onDownloadArxiv,
  onDeleteAnnotation
}: SyncPanelProps) {
  const [activeTab, setActiveTab] = useState<"details" | "notes" | "deepseek">("details");
  const visibleAnnotations = annotations.filter((annotation) => !annotation.deletedAt);
  const hasMultiplePapersSelected = selectedPaperCount > 1;
  const inspectedPaper = hasMultiplePapersSelected ? undefined : paper;

  return (
    <aside className="sync-panel">
      <div className="inspector-tabs" role="tablist" aria-label="Inspector">
        <button type="button" className={activeTab === "details" ? "active" : ""} onClick={() => setActiveTab("details")}>
          Details
        </button>
        <button type="button" className={activeTab === "notes" ? "active" : ""} onClick={() => setActiveTab("notes")}>
          Notes
        </button>
        <button type="button" className={activeTab === "deepseek" ? "active" : ""} onClick={() => setActiveTab("deepseek")}>
          Ask DeepSeek
        </button>
      </div>

      {activeTab === "details" && (
        hasMultiplePapersSelected
          ? <MultiplePaperSelection count={selectedPaperCount} />
          : (
              <DetailsTab
                settings={settings}
                paper={inspectedPaper}
                fileAsset={fileAsset}
                fileData={fileData}
                onRequestFileData={onRequestFileData}
                hasLocalPdf={hasLocalPdf}
                fileStorageSettings={fileStorageSettings}
                onUpdatePaper={onUpdatePaper}
                arxivDownloadBusy={arxivDownloadBusy}
                onDownloadArxiv={onDownloadArxiv}
              />
            )
      )}
      {activeTab === "notes" && (
        <PaperNotesTab
          paper={inspectedPaper}
          annotations={visibleAnnotations}
          onUpdatePaper={onUpdatePaper}
          onDeleteAnnotation={onDeleteAnnotation}
        />
      )}
      {activeTab === "deepseek" && <DeepSeekTab paper={inspectedPaper} />}
    </aside>
  );
}

function MultiplePaperSelection({ count }: { count: number }) {
  return (
    <div className="details-tab">
      <h3>Details</h3>
      <div className="multiple-paper-selection" role="status" aria-live="polite">
        <Files size={28} />
        <strong>{count} documents selected</strong>
        <p>Select a single document to view and edit its details.</p>
      </div>
    </div>
  );
}

function DetailsTab({
  settings,
  paper,
  fileAsset,
  fileData,
  onRequestFileData,
  hasLocalPdf,
  fileStorageSettings,
  onUpdatePaper,
  arxivDownloadBusy,
  onDownloadArxiv
}: {
  settings: SyncSettings;
  paper?: Paper;
  fileAsset?: FileAsset;
  fileData?: Uint8Array;
  onRequestFileData: () => Promise<Uint8Array | undefined>;
  hasLocalPdf: boolean;
  fileStorageSettings: FileStorageSettings;
  onUpdatePaper: (paper: Paper) => void;
  arxivDownloadBusy: boolean;
  onDownloadArxiv: (paperId: string, onProgress: (progress: ArxivDownloadProgress) => void) => Promise<string>;
}) {
  const [arxivLookupStatus, setArxivLookupStatus] = useState<string>();
  const [arxivLookupBusy, setArxivLookupBusy] = useState(false);
  const [arxivResults, setArxivResults] = useState<ArxivMetadata[]>([]);
  const [arxivResultsOpen, setArxivResultsOpen] = useState(false);
  const [arxivDownloadStatus, setArxivDownloadStatus] = useState<string>();
  const [arxivDownloadProgress, setArxivDownloadProgress] = useState<ArxivDownloadProgress>();
  const [pdfMetadataStatus, setPdfMetadataStatus] = useState<string>();
  const [pdfMetadataBusy, setPdfMetadataBusy] = useState(false);
  const [fileActionStatus, setFileActionStatus] = useState<string>();
  const [fileContextMenu, setFileContextMenu] = useState<{ x: number; y: number } | undefined>(undefined);
  const [fileContextMenuStyle, setFileContextMenuStyle] = useState<{ left: number; top: number } | undefined>(undefined);
  const fileContextMenuRef = useRef<HTMLDivElement>(null);

  // Clamp context menu position so it never overflows the viewport
  useLayoutEffect(() => {
    const menu = fileContextMenuRef.current;
    if (!menu || !fileContextMenu) {
      setFileContextMenuStyle(undefined);
      return;
    }
    const rect = menu.getBoundingClientRect();
    const pad = 4;
    const left = Math.min(fileContextMenu.x, window.innerWidth - rect.width - pad);
    const top = Math.min(fileContextMenu.y, window.innerHeight - rect.height - pad);
    setFileContextMenuStyle({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [fileContextMenu]);

  // Close context menu on any click, keydown, or scroll
  useEffect(() => {
    if (!fileContextMenu) return;
    const close = () => setFileContextMenu(undefined);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [fileContextMenu]);

  function handleFileContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    setFileContextMenu({ x: event.clientX, y: event.clientY });
  }

  async function handleOpenFileExternally() {
    if (!fileAsset?.localPath || !fileStorageSettings.directory) return;
    setFileContextMenu(undefined);
    setFileActionStatus(undefined);
    try {
      await invoke("open_file_with_system", {
        dir: fileStorageSettings.directory,
        fileName: fileAsset.localPath
      });
    } catch (error) {
      console.error("Failed to open file:", error);
      setFileActionStatus(`Could not open the file: ${String(error)}`);
    }
  }

  async function handleRevealFileInFolder() {
    if (!fileAsset?.localPath || !fileStorageSettings.directory) return;
    setFileContextMenu(undefined);
    setFileActionStatus(undefined);
    try {
      await invoke("reveal_file_in_folder", {
        dir: fileStorageSettings.directory,
        fileName: fileAsset.localPath
      });
    } catch (error) {
      console.error("Failed to reveal file:", error);
      setFileActionStatus(`Could not show the file in its folder: ${String(error)}`);
    }
  }

  if (!paper) {
    return <p className="inspector-empty">No document selected.</p>;
  }

  const currentPaper = paper;
  const authors = currentPaper.authors.map((author) => author.fullName).join(", ") || "No authors";
  const editableAuthors = authors === "No authors" ? "" : authors;

  function updatePaper(patch: Partial<Paper>) {
    onUpdatePaper({ ...currentPaper, ...patch });
  }

  async function handleArxivLookup() {
    if (!currentPaper.title.trim()) {
      setArxivLookupStatus("Title is required for arXiv lookup.");
      return;
    }

    setArxivLookupBusy(true);
    setArxivLookupStatus(undefined);
    setArxivResults([]);
    setArxivResultsOpen(false);
    try {
      const results = await searchArxivMetadata(settings, currentPaper.title);
      if (results.length === 0) {
        setArxivLookupStatus("No arXiv match found.");
        return;
      }

      setArxivResults(results);
      setArxivResultsOpen(true);
      setArxivLookupStatus(`${results.length} arXiv matches found. Choose one to fill metadata.`);
    } catch (error) {
      setArxivLookupStatus(error instanceof Error ? error.message : "arXiv lookup failed.");
    } finally {
      setArxivLookupBusy(false);
    }
  }

  function handleSelectArxivResult(metadata: ArxivMetadata) {
    updatePaper(arxivMetadataToPaperPatch(metadata));
    setArxivResultsOpen(false);
    setArxivLookupStatus(`Applied arXiv:${metadata.arxivId}`);
  }

  async function handleArxivDownload() {
    setArxivDownloadStatus(undefined);
    setArxivDownloadProgress(undefined);
    setArxivDownloadStatus(await onDownloadArxiv(currentPaper.id, (progress) => {
      setArxivDownloadProgress(progress);
      if (progress.downloadedBytes !== undefined) {
        setArxivDownloadStatus(
          `${formatFileSize(progress.downloadedBytes)}`
          + (progress.totalBytes ? ` / ${formatFileSize(progress.totalBytes)}` : " downloaded")
        );
      }
    }));
  }

  async function handleGoogleScholarSearch() {
    const query = currentPaper.title.trim();
    if (!query) return;
    const url = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`;
    try {
      await invoke("open_external_url", { url });
    } catch (error) {
      console.error("Failed to open Google Scholar:", error);
    }
  }

  async function handlePdfMetadataExtract() {
    setPdfMetadataBusy(true);
    setPdfMetadataStatus(undefined);
    try {
      const bytes = fileData ?? await onRequestFileData();
      if (!bytes) {
        setPdfMetadataStatus("No local PDF file available.");
        return;
      }
      const { extractPdfMetadataPatch } = await import("../lib/pdfMetadata");
      const result = await extractPdfMetadataPatch(bytes, fileAsset?.fileName);
      if (result.fields.length === 0) {
        setPdfMetadataStatus("No usable PDF metadata found.");
        return;
      }

      updatePaper(result.patch);
      setPdfMetadataStatus(`Updated ${result.fields.join(", ")} from PDF.`);
    } catch (error) {
      setPdfMetadataStatus(error instanceof Error ? error.message : "PDF metadata extraction failed.");
    } finally {
      setPdfMetadataBusy(false);
    }
  }

  return (
    <div className="details-tab">
      <div className="details-title-row">
        <h3>Details</h3>
        <div className="details-title-actions">
          <button type="button" onClick={handlePdfMetadataExtract} disabled={pdfMetadataBusy || !hasLocalPdf}>
            <FileSearch size={15} />
            {pdfMetadataBusy ? "Extracting..." : "Extract PDF"}
          </button>
          <div className="arxiv-action-stack">
            <button
              type="button"
              onClick={() => void handleGoogleScholarSearch()}
              disabled={!paper.title.trim()}
              title="Search this title on Google Scholar"
            >
              <GraduationCap size={15} />
              Google Scholar
            </button>
            <button type="button" onClick={handleArxivLookup} disabled={arxivLookupBusy || !paper.title.trim()}>
              <Search size={15} />
              {arxivLookupBusy ? "Searching..." : "Search arXiv"}
            </button>
            <button
              type="button"
              onClick={() => void handleArxivDownload()}
              disabled={arxivDownloadBusy || !paper.arxiv || hasLocalPdf}
              title={hasLocalPdf ? "A local PDF is already available." : undefined}
            >
              <Download className={arxivDownloadBusy ? "spinning" : undefined} size={15} />
              {arxivDownloadBusy ? "Downloading..." : "Download from arXiv"}
            </button>
          </div>
        </div>
      </div>
      {pdfMetadataStatus && <p className="metadata-lookup-status">{pdfMetadataStatus}</p>}
      {arxivLookupStatus && <p className="metadata-lookup-status">{arxivLookupStatus}</p>}
      {arxivDownloadStatus && <p className="metadata-lookup-status">{arxivDownloadStatus}</p>}
      {arxivDownloadBusy && arxivDownloadProgress?.phase === "downloading" && (
        <div className="arxiv-download-progress" aria-label="arXiv PDF download progress">
          <div className={arxivDownloadProgress.totalBytes ? "determinate" : "indeterminate"}>
            <span style={arxivDownloadProgress.totalBytes ? {
              width: `${Math.min(100, ((arxivDownloadProgress.downloadedBytes ?? 0) / arxivDownloadProgress.totalBytes) * 100)}%`
            } : undefined} />
          </div>
          <small>
            {formatFileSize(arxivDownloadProgress.downloadedBytes ?? 0)}
            {arxivDownloadProgress.totalBytes ? ` / ${formatFileSize(arxivDownloadProgress.totalBytes)}` : ""}
            {arxivDownloadProgress.totalBytes
              ? ` (${Math.round(((arxivDownloadProgress.downloadedBytes ?? 0) / arxivDownloadProgress.totalBytes) * 100)}%)`
              : ""}
          </small>
        </div>
      )}
      {arxivResultsOpen && (
        <div className="arxiv-results-popover">
          <header>
            <strong>arXiv matches</strong>
            <button type="button" onClick={() => setArxivResultsOpen(false)} aria-label="Close arXiv results">
              ×
            </button>
          </header>
          <div className="arxiv-results-list">
            {arxivResults.map((result) => (
              <article key={result.arxivId} className="arxiv-result">
                <button type="button" onClick={() => handleSelectArxivResult(result)}>
                  <span>{result.title}</span>
                  <small>
                    arXiv:{result.arxivId}
                    {result.year ? ` · ${result.year}` : ""}
                    {result.authors.length > 0 ? ` · ${formatAuthorPreview(result.authors.map((author) => author.fullName))}` : ""}
                  </small>
                  {result.abstract && <p>{result.abstract}</p>}
                </button>
              </article>
            ))}
          </div>
        </div>
      )}
      <label>
        Title
        <input value={paper.title} onChange={(event) => updatePaper({ title: event.target.value })} />
      </label>
      <label>
        arXiv ID
        <input value={paper.arxiv ?? ""} onChange={(event) => updatePaper({ arxiv: clean(event.target.value) })} />
      </label>
      <label>
        Authors
        <textarea
          value={editableAuthors}
          onChange={(event) => updatePaper({ authors: parseAuthors(event.target.value) })}
          placeholder="Separate authors with commas or new lines"
        />
      </label>
      <div className="details-grid">
        <label>
          Year
          <input
            value={paper.year ?? ""}
            onChange={(event) => updatePaper({ year: parseOptionalYear(event.target.value) })}
            inputMode="numeric"
          />
        </label>
        <label>
          URL
          <input value={paper.url ?? ""} onChange={(event) => updatePaper({ url: clean(event.target.value) })} />
        </label>
      </div>
      <label>
        Tags
        <input value={paper.tags?.join(", ") ?? ""} onChange={(event) => updatePaper({ tags: splitList(event.target.value) })} />
      </label>
      <label>
        Keywords
        <input
          value={paper.keywords?.join(", ") ?? ""}
          onChange={(event) => updatePaper({ keywords: splitList(event.target.value) })}
        />
      </label>
      <label>
        Abstract
        <textarea value={paper.abstract ?? ""} onChange={(event) => updatePaper({ abstract: clean(event.target.value) })} />
      </label>
      <div className="details-status-row">
        <label>
          <input type="checkbox" checked={Boolean(paper.favorite)} onChange={(event) => updatePaper({ favorite: event.target.checked })} />
          Favorite
        </label>
      </div>
      <p
        className={`details-file ${fileAsset?.localPath && fileStorageSettings.directory ? "has-local-file" : ""}`}
        onContextMenu={fileAsset?.localPath && fileStorageSettings.directory ? handleFileContextMenu : undefined}
        title={fileAsset?.localPath && fileStorageSettings.directory ? "Right-click for options" : undefined}
      >
        File: {fileAsset?.fileName ?? "No file attached"}
      </p>
      {fileActionStatus && <p className="metadata-lookup-status" role="alert">{fileActionStatus}</p>}

      {fileContextMenu && (
        <div
          ref={fileContextMenuRef}
          className="paper-context-menu"
          style={{
            left: fileContextMenuStyle?.left ?? fileContextMenu.x,
            top: fileContextMenuStyle?.top ?? fileContextMenu.y,
            visibility: fileContextMenuStyle ? "visible" : "hidden"
          }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => void handleOpenFileExternally()}>
            <ExternalLink size={15} />
            <span>Open Externally</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void handleRevealFileInFolder()}>
            <FolderOpen size={15} />
            <span>Show in Folder</span>
          </button>
        </div>
      )}
    </div>
  );
}

function parseAuthors(value: string) {
  return value.split(/\r?\n|,/).map((fullName) => fullName.trim()).filter(Boolean).map((fullName) => ({ fullName }));
}

function parseOptionalYear(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clean(value: string) {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function splitList(value: string) {
  return value.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
}

function formatAuthorPreview(authors: string[]) {
  if (authors.length <= 3) {
    return authors.join(", ");
  }

  return `${authors.slice(0, 3).join(", ")} et al.`;
}

function DeepSeekTab({ paper }: { paper?: Paper }) {
  if (!paper) {
    return <p className="inspector-empty">No document selected.</p>;
  }

  return (
    <div className="inspector-deepseek">
      <div className="deepseek-placeholder">
        <Send size={32} />
        <h3>Ask DeepSeek</h3>
        <p>
          Ask AI about this paper — summarize, explain concepts, find key insights,
          and more.
        </p>
        <p className="deepseek-coming-soon">Coming soon</p>
      </div>
    </div>
  );
}
