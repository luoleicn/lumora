import type { Annotation } from "@lumora/shared";

/** Attach note text to an annotation, promoting a highlight to a note. */
function withNoteComment(
  annotation: Annotation,
  comment: string,
  updatedAt = new Date().toISOString()
): Annotation {
  return {
    ...annotation,
    kind: "note",
    comment,
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
  draft: string,
  updatedAt = new Date().toISOString()
): Annotation | undefined {
  const trimmed = draft.trim();
  const unchanged = annotation.kind === "note" && trimmed === (annotation.comment ?? "");
  if (!trimmed || unchanged) {
    return undefined;
  }

  return withNoteComment(annotation, trimmed, updatedAt);
}
