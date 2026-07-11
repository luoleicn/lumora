import { Cloud, DatabaseZap, Download, FileSearch, LogIn, RefreshCw, Search, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Annotation, ArxivMetadata, FileAsset, Paper } from "@lumora/shared";
import { searchArxivMetadata, type SyncSettings } from "../lib/syncClient";
import { formatFileSize, type ArxivDownloadProgress } from "../lib/arxivFiles";

type SyncPanelProps = {
  settings: SyncSettings;
  busy: boolean;
  status?: string;
  paper?: Paper;
  fileAsset?: FileAsset;
  fileData?: Uint8Array;
  hasLocalPdf: boolean;
  annotations: Annotation[];
  onSettingsChange: (settings: SyncSettings) => void;
  onLogin: () => void;
  onSync: () => void;
  onUpdatePaper: (paper: Paper) => void;
  arxivDownloadBusy: boolean;
  onDownloadArxiv: (paperId: string, onProgress: (progress: ArxivDownloadProgress) => void) => Promise<string>;
  onDeleteAnnotation: (annotation: Annotation) => void;
};

export function SyncPanel({
  settings,
  busy,
  status,
  paper,
  fileAsset,
  fileData,
  hasLocalPdf,
  annotations,
  onSettingsChange,
  onLogin,
  onSync,
  onUpdatePaper,
  arxivDownloadBusy,
  onDownloadArxiv,
  onDeleteAnnotation
}: SyncPanelProps) {
  const [activeTab, setActiveTab] = useState<"details" | "notes" | "sync">("details");
  const visibleAnnotations = annotations.filter((annotation) => !annotation.deletedAt);

  return (
    <aside className="sync-panel">
      <div className="inspector-tabs" role="tablist" aria-label="Inspector">
        <button type="button" className={activeTab === "details" ? "active" : ""} onClick={() => setActiveTab("details")}>
          Details
        </button>
        <button type="button" className={activeTab === "notes" ? "active" : ""} onClick={() => setActiveTab("notes")}>
          Notes
        </button>
        <button type="button" className={activeTab === "sync" ? "active" : ""} onClick={() => setActiveTab("sync")}>
          Sync
        </button>
      </div>

      {activeTab === "details" && (
        <DetailsTab
          settings={settings}
          paper={paper}
          fileAsset={fileAsset}
          fileData={fileData}
          hasLocalPdf={hasLocalPdf}
          onUpdatePaper={onUpdatePaper}
          arxivDownloadBusy={arxivDownloadBusy}
          onDownloadArxiv={onDownloadArxiv}
        />
      )}
      {activeTab === "notes" && <NotesTab annotations={visibleAnnotations} onDeleteAnnotation={onDeleteAnnotation} />}
      {activeTab === "sync" && (
        <>
          <div className="panel-heading">
            <Cloud size={18} />
            <h3>Sync</h3>
          </div>
          <label>
            Server
            <input
              value={settings.serverUrl}
              onChange={(event) => onSettingsChange({ ...settings, serverUrl: event.target.value })}
            />
          </label>
          <label>
            Email
            <input
              value={settings.email}
              onChange={(event) => onSettingsChange({ ...settings, email: event.target.value })}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={settings.password}
              onChange={(event) => onSettingsChange({ ...settings, password: event.target.value })}
            />
          </label>
          <div className="sync-actions">
            <button type="button" onClick={onLogin} disabled={busy}>
              <LogIn size={16} />
              Login
            </button>
            <button type="button" onClick={onSync} disabled={busy || !settings.token}>
              <RefreshCw size={16} />
              Sync
            </button>
          </div>
          {status && <p className="sync-status">{status}</p>}
        </>
      )}
    </aside>
  );
}

const documentTypes = [
  ["journalArticle", "Journal Article"],
  ["conferencePaper", "Conference Paper"],
  ["preprint", "Preprint"],
  ["book", "Book"],
  ["bookSection", "Book Section"],
  ["thesis", "Thesis"],
  ["report", "Report"]
];

function DetailsTab({
  settings,
  paper,
  fileAsset,
  fileData,
  hasLocalPdf,
  onUpdatePaper,
  arxivDownloadBusy,
  onDownloadArxiv
}: {
  settings: SyncSettings;
  paper?: Paper;
  fileAsset?: FileAsset;
  fileData?: Uint8Array;
  hasLocalPdf: boolean;
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

  async function handlePdfMetadataExtract() {
    if (!fileData) {
      setPdfMetadataStatus("No local PDF file available.");
      return;
    }

    setPdfMetadataBusy(true);
    setPdfMetadataStatus(undefined);
    try {
      const { extractPdfMetadataPatch } = await import("../lib/pdfMetadata");
      const result = await extractPdfMetadataPatch(fileData, fileAsset?.fileName);
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
          <button type="button" onClick={handlePdfMetadataExtract} disabled={pdfMetadataBusy || !fileData}>
            <FileSearch size={15} />
            {pdfMetadataBusy ? "Extracting..." : "Extract PDF"}
          </button>
          <div className="arxiv-action-stack">
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
        Type
        <select value={paper.documentType ?? "journalArticle"} onChange={(event) => updatePaper({ documentType: event.target.value })}>
          {documentTypes.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
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
          Published In
          <input value={paper.venue ?? ""} onChange={(event) => updatePaper({ venue: clean(event.target.value) })} />
        </label>
        <label>
          DOI
          <input value={paper.doi ?? ""} onChange={(event) => updatePaper({ doi: clean(event.target.value) })} />
        </label>
        <label>
          URL
          <input value={paper.url ?? ""} onChange={(event) => updatePaper({ url: clean(event.target.value) })} />
        </label>
        <label>
          Volume
          <input value={paper.volume ?? ""} onChange={(event) => updatePaper({ volume: clean(event.target.value) })} />
        </label>
        <label>
          Issue
          <input value={paper.issue ?? ""} onChange={(event) => updatePaper({ issue: clean(event.target.value) })} />
        </label>
        <label>
          Pages
          <input value={paper.pages ?? ""} onChange={(event) => updatePaper({ pages: clean(event.target.value) })} />
        </label>
        <label>
          Publisher
          <input value={paper.publisher ?? ""} onChange={(event) => updatePaper({ publisher: clean(event.target.value) })} />
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
      <p className="details-file">File: {fileAsset?.fileName ?? "No file attached"}</p>
    </div>
  );
}

function arxivMetadataToPaperPatch(metadata: ArxivMetadata): Partial<Paper> {
  return {
    arxiv: metadata.arxivId,
    title: metadata.title,
    authors: metadata.authors,
    year: metadata.year,
    venue: metadata.venue ?? "arXiv",
    doi: metadata.doi,
    abstract: metadata.abstract,
    url: metadata.url,
    documentType: "preprint",
    keywords: metadata.categories ?? [],
    needsReview: false
  };
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

function NotesTab({
  annotations,
  onDeleteAnnotation
}: {
  annotations: Annotation[];
  onDeleteAnnotation: (annotation: Annotation) => void;
}) {
  if (annotations.length === 0) {
    return <p className="inspector-empty">No notes or highlights for this document.</p>;
  }

  return (
    <div className="inspector-notes">
      {annotations.map((annotation) => (
        <article key={annotation.id}>
          <header>
            <span style={{ backgroundColor: annotation.color }} />
            <strong>Page {annotation.pageIndex + 1}</strong>
            <button
              className="icon-button small"
              type="button"
              onClick={() => onDeleteAnnotation(annotation)}
              aria-label="Delete annotation"
            >
              <Trash2 size={14} />
            </button>
          </header>
          {annotation.quote && <p>{annotation.quote}</p>}
          {annotation.comment && <blockquote>{annotation.comment}</blockquote>}
        </article>
      ))}
    </div>
  );
}
