import { Trash2 } from "lucide-react";
import type { Annotation, Paper } from "@lumora/shared";

type PaperNotesTabProps = {
  paper?: Paper;
  annotations: Annotation[];
  onUpdatePaper: (paper: Paper) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
};

export function updatePaperPersonalNote(paper: Paper, value: string): Paper {
  const userContext = value === "" ? undefined : value;
  return paper.userContext === userContext
    ? paper
    : { ...paper, userContext };
}

export function PaperPersonalNoteEditor({
  paper,
  onUpdatePaper
}: {
  paper: Paper;
  onUpdatePaper: (paper: Paper) => void;
}) {
  return (
    <section className="paper-personal-note">
      <label>
        <strong>Personal note</strong>
        <textarea
          value={paper.userContext ?? ""}
          onChange={(event) => {
            const nextPaper = updatePaperPersonalNote(paper, event.target.value);
            if (nextPaper !== paper) {
              onUpdatePaper(nextPaper);
            }
          }}
          placeholder="Add your notes about this paper…"
          aria-label="Personal note for this paper"
        />
      </label>
    </section>
  );
}

export function PaperNotesTab({
  paper,
  annotations,
  onUpdatePaper,
  onDeleteAnnotation
}: PaperNotesTabProps) {
  if (!paper) {
    return <p className="inspector-empty">No document selected.</p>;
  }

  return (
    <div className="paper-notes-tab">
      <PaperPersonalNoteEditor paper={paper} onUpdatePaper={onUpdatePaper} />
      {annotations.length === 0 ? (
        <p className="inspector-empty">No notes or highlights for this document.</p>
      ) : (
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
      )}
    </div>
  );
}
