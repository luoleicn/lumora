import { Cloud, DatabaseZap, LogIn, RefreshCw, Search, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Annotation, ArxivMetadata, FileAsset, Paper } from "@lumora/shared";
import { searchArxivMetadata, type SyncSettings } from "../lib/syncClient";

type SyncPanelProps = {
  settings: SyncSettings;
  busy: boolean;
  status?: string;
  paper?: Paper;
  fileAsset?: FileAsset;
  annotations: Annotation[];
  onSettingsChange: (settings: SyncSettings) => void;
  onLogin: () => void;
  onSync: () => void;
  onConnectMendeley: () => void;
  onImportMendeley: () => void;
  onUpdatePaper: (paper: Paper) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
};

export function SyncPanel({
  settings,
  busy,
  status,
  paper,
  fileAsset,
  annotations,
  onSettingsChange,
  onLogin,
  onSync,
  onConnectMendeley,
  onImportMendeley,
  onUpdatePaper,
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
          onUpdatePaper={onUpdatePaper}
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
          <div className="sync-actions">
            <button type="button" onClick={onConnectMendeley} disabled={busy || !settings.token}>
              <Send size={16} />
              Mendeley OAuth
            </button>
            <button type="button" onClick={onImportMendeley} disabled={busy || !settings.token}>
              <DatabaseZap size={16} />
              Import
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
  onUpdatePaper
}: {
  settings: SyncSettings;
  paper?: Paper;
  fileAsset?: FileAsset;
  onUpdatePaper: (paper: Paper) => void;
}) {
  const [arxivLookupStatus, setArxivLookupStatus] = useState<string>();
  const [arxivLookupBusy, setArxivLookupBusy] = useState(false);

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
    try {
      const results = await searchArxivMetadata(settings, currentPaper.title);
      const bestMatch = results[0];
      if (!bestMatch) {
        setArxivLookupStatus("No arXiv match found.");
        return;
      }

      updatePaper(arxivMetadataToPaperPatch(bestMatch));
      setArxivLookupStatus(`Matched arXiv:${bestMatch.arxivId}`);
    } catch (error) {
      setArxivLookupStatus(error instanceof Error ? error.message : "arXiv lookup failed.");
    } finally {
      setArxivLookupBusy(false);
    }
  }

  return (
    <div className="details-tab">
      <div className="details-title-row">
        <h3>Details</h3>
        <button type="button" onClick={handleArxivLookup} disabled={arxivLookupBusy || !paper.title.trim()}>
          <Search size={15} />
          {arxivLookupBusy ? "Searching..." : "Search arXiv"}
        </button>
      </div>
      {arxivLookupStatus && <p className="metadata-lookup-status">{arxivLookupStatus}</p>}
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
