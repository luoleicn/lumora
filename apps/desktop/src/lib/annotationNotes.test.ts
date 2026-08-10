import { describe, expect, it } from "vitest";
import type { Annotation } from "@lumora/shared";
import { resolveNoteDraft } from "./annotationNotes";

const highlight: Annotation = {
  id: "annotation-a",
  paperId: "paper-a",
  fileId: "file-a",
  pageIndex: 2,
  kind: "highlight",
  color: "#ffee58",
  rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
  quote: "Quoted text",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

const note: Annotation = { ...highlight, kind: "note", comment: "Existing note" };

describe("resolveNoteDraft", () => {
  it("promotes a highlight to a note with the trimmed draft", () => {
    expect(resolveNoteDraft(highlight, "  Fresh note  ", "2026-08-10T09:00:00.000Z")).toEqual({
      ...highlight,
      kind: "note",
      comment: "Fresh note",
      updatedAt: "2026-08-10T09:00:00.000Z"
    });
  });

  it("rewrites an existing note without touching its position or color", () => {
    const positioned: Annotation = { ...note, notePosition: { x: 0.4, y: 0.5 } };
    expect(resolveNoteDraft(positioned, "Revised note", "2026-08-10T09:00:00.000Z")).toEqual({
      ...positioned,
      comment: "Revised note",
      updatedAt: "2026-08-10T09:00:00.000Z"
    });
  });

  it("skips unchanged drafts so closing an untouched editor writes nothing", () => {
    expect(resolveNoteDraft(note, "Existing note")).toBeUndefined();
    expect(resolveNoteDraft(note, "  Existing note\n")).toBeUndefined();
  });

  it("keeps the stored text when the draft is emptied", () => {
    expect(resolveNoteDraft(note, "   ")).toBeUndefined();
    expect(resolveNoteDraft(highlight, "")).toBeUndefined();
  });
});
