import { Trash2 } from "lucide-react";
import { noteDraftsEqual, type Annotation, type NoteDraft, type Paper } from "@lumora/shared";
import { MeasuredVirtualList } from "./MeasuredVirtualList";
import { RichNoteEditor } from "./RichNoteEditor";
import { NoteContent } from "./NoteContent";

type PaperNotesTabProps = {
  paper?: Paper;
  annotations: Annotation[];
  onUpdatePaper: (paper: Paper) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
};

export function updatePaperPersonalNote(paper: Paper, value: string | NoteDraft): Paper {
  const draft = typeof value === "string" ? { text: value } : value;
  const userContext = draft.text === "" ? undefined : draft.text;
  return noteDraftsEqual({ text: paper.userContext ?? "", content: paper.userContextContent }, draft)
    ? paper
    : { ...paper, userContext, userContextContent: draft.content };
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
      <div className="paper-personal-note-field">
        <strong>Personal note</strong>
        <RichNoteEditor
          key={paper.id}
          value={paper.userContext ?? ""}
          content={paper.userContextContent}
          onChange={(draft) => {
            const nextPaper = updatePaperPersonalNote(paper, draft);
            if (nextPaper !== paper) {
              onUpdatePaper(nextPaper);
            }
          }}
          placeholder="Write a note or paste an image…"
          ariaLabel="Personal note for this paper"
        />
      </div>
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
        <MeasuredVirtualList
          className="inspector-notes"
          scrollContainerSelector=".sync-panel"
          items={annotations}
          renderItem={(annotation) => (
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
              {(annotation.comment || annotation.commentContent) && <blockquote><NoteContent value={annotation.comment ?? ""} content={annotation.commentContent} /></blockquote>}
            </article>
          )}
        />
      )}
    </div>
  );
}
