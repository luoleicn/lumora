import { BookOpen, FileText, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { Annotation, Paper } from "@lumora/shared";

type NotebookPanelProps = {
  papers: Paper[];
  annotations: Annotation[];
  onOpenPaper: (paperId: string) => void;
};

export function NotebookPanel({ papers, annotations, onOpenPaper }: NotebookPanelProps) {
  const [query, setQuery] = useState("");
  const activeAnnotations = annotations.filter((annotation) => !annotation.deletedAt);
  const paperById = useMemo(() => new Map(papers.map((paper) => [paper.id, paper])), [papers]);
  const visibleAnnotations = activeAnnotations.filter((annotation) => {
    const lowerQuery = query.trim().toLowerCase();
    if (!lowerQuery) {
      return true;
    }

    const paper = paperById.get(annotation.paperId);
    return `${paper?.title ?? ""} ${annotation.quote ?? ""} ${annotation.comment ?? ""}`.toLowerCase().includes(lowerQuery);
  });

  return (
    <section className="notebook-panel">
      <header className="notebook-toolbar">
        <div className="paper-heading">
          <h2>Notebook</h2>
          <span>{activeAnnotations.length} notes and highlights</span>
        </div>
        <label className="notebook-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" />
        </label>
      </header>

      {visibleAnnotations.length === 0 ? (
        <div className="reader-empty">
          <div>
            <BookOpen size={28} />
            <h2>No notes found</h2>
            <p>Highlights and comments appear here across the whole library.</p>
          </div>
        </div>
      ) : (
        <div className="notebook-list">
          {visibleAnnotations.map((annotation) => {
            const paper = paperById.get(annotation.paperId);
            return (
              <article key={annotation.id} className="notebook-item">
                <button type="button" onClick={() => onOpenPaper(annotation.paperId)}>
                  <FileText size={15} />
                  <span>{paper?.title ?? "Unknown document"}</span>
                  <strong>Page {annotation.pageIndex + 1}</strong>
                </button>
                <div className="notebook-note">
                  <span className="annotation-dot" style={{ backgroundColor: annotation.color }} />
                  <div>
                    {annotation.quote && <p>{annotation.quote}</p>}
                    {annotation.comment && <blockquote>{annotation.comment}</blockquote>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
