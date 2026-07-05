import { Save, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

export type ManualReferenceDraft = {
  documentType: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url?: string;
  pages?: string;
  volume?: string;
  issue?: string;
  publisher?: string;
  tags: string[];
  keywords: string[];
  abstract?: string;
};

type ManualReferenceModalProps = {
  open: boolean;
  onClose: () => void;
  onSave: (draft: ManualReferenceDraft) => void;
};

const documentTypes = [
  ["journalArticle", "Journal Article"],
  ["conferencePaper", "Conference Paper"],
  ["book", "Book"],
  ["bookSection", "Book Section"],
  ["thesis", "Thesis"],
  ["report", "Report"]
];

const emptyForm = {
  documentType: "journalArticle",
  title: "",
  authors: "",
  year: "",
  venue: "",
  doi: "",
  url: "",
  pages: "",
  volume: "",
  issue: "",
  publisher: "",
  tags: "",
  keywords: "",
  abstract: ""
};

export function ManualReferenceModal({ open, onClose, onSave }: ManualReferenceModalProps) {
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    if (open) {
      setForm(emptyForm);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  function updateField(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form.title.trim()) {
      return;
    }

    onSave({
      documentType: form.documentType,
      title: form.title.trim(),
      authors: splitLines(form.authors),
      year: parseYear(form.year),
      venue: clean(form.venue),
      doi: clean(form.doi),
      url: clean(form.url),
      pages: clean(form.pages),
      volume: clean(form.volume),
      issue: clean(form.issue),
      publisher: clean(form.publisher),
      tags: splitList(form.tags),
      keywords: splitList(form.keywords),
      abstract: clean(form.abstract)
    });
    onClose();
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="manual-modal" onSubmit={handleSubmit} role="dialog" aria-modal="true" aria-label="Add entry manually">
        <header>
          <div>
            <h2>Add Entry Manually</h2>
            <p>Structured metadata can be edited later in Details.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="manual-form-grid">
          <label>
            Type
            <select value={form.documentType} onChange={(event) => updateField("documentType", event.target.value)}>
              {documentTypes.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="wide">
            Title
            <input value={form.title} onChange={(event) => updateField("title", event.target.value)} autoFocus required />
          </label>
          <label className="wide">
            Authors
            <textarea
              value={form.authors}
              onChange={(event) => updateField("authors", event.target.value)}
              placeholder="One author per line"
            />
          </label>
          <label>
            Year
            <input value={form.year} onChange={(event) => updateField("year", event.target.value)} inputMode="numeric" />
          </label>
          <label>
            Published In
            <input value={form.venue} onChange={(event) => updateField("venue", event.target.value)} />
          </label>
          <label>
            DOI
            <input value={form.doi} onChange={(event) => updateField("doi", event.target.value)} />
          </label>
          <label>
            URL
            <input value={form.url} onChange={(event) => updateField("url", event.target.value)} />
          </label>
          <label>
            Volume
            <input value={form.volume} onChange={(event) => updateField("volume", event.target.value)} />
          </label>
          <label>
            Issue
            <input value={form.issue} onChange={(event) => updateField("issue", event.target.value)} />
          </label>
          <label>
            Pages
            <input value={form.pages} onChange={(event) => updateField("pages", event.target.value)} />
          </label>
          <label>
            Publisher
            <input value={form.publisher} onChange={(event) => updateField("publisher", event.target.value)} />
          </label>
          <label>
            Tags
            <input value={form.tags} onChange={(event) => updateField("tags", event.target.value)} placeholder="comma separated" />
          </label>
          <label>
            Keywords
            <input
              value={form.keywords}
              onChange={(event) => updateField("keywords", event.target.value)}
              placeholder="comma separated"
            />
          </label>
          <label className="wide">
            Abstract
            <textarea value={form.abstract} onChange={(event) => updateField("abstract", event.target.value)} />
          </label>
        </div>

        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            <Save size={16} />
            Save
          </button>
        </footer>
      </form>
    </div>
  );
}

function clean(value: string) {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseYear(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function splitLines(value: string) {
  return value.split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean);
}

function splitList(value: string) {
  return value.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
}
