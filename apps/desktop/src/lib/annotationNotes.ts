import { noteDraftsEqual, type Annotation, type NoteDraft } from "@lumora/shared";

/** Attach note text to an annotation, promoting a highlight to a note. */
function withNoteComment(
  annotation: Annotation,
  draft: NoteDraft,
  updatedAt = new Date().toISOString()
): Annotation {
  return {
    ...annotation,
    kind: "note",
    comment: draft.text,
    commentContent: draft.content,
    updatedAt
  };
}

/**
 * The annotation to persist for an edited note draft, or `undefined` when the
 * draft brings nothing new. Note editors save on close — outside click, close
 * button, Escape, the page scrolling out of the virtual window — so unchanged
 * drafts must not turn every glance at a note into a library write and a sync
 * update. An emptied draft keeps the stored text; removing a note entirely is
 * the annotation menu's "Delete Note".
 */
export function resolveNoteDraft(
  annotation: Annotation,
  draft: string | NoteDraft,
  updatedAt = new Date().toISOString()
): Annotation | undefined {
  const value = typeof draft === "string" ? { text: draft.trim() } : {
    ...draft,
    text: draft.content ? draft.text : draft.text.trim()
  };
  const unchanged = annotation.kind === "note" && noteDraftsEqual(value, {
    text: annotation.comment ?? "", content: annotation.commentContent
  });
  if ((!value.text.trim() && !value.content) || unchanged) {
    return undefined;
  }

  return withNoteComment(annotation, value, updatedAt);
}
