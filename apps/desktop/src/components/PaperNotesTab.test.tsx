import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Annotation, Paper } from "@lumora/shared";
import {
  PaperNotesTab,
  updatePaperPersonalNote
} from "./PaperNotesTab";

const paper: Paper = {
  id: "paper-a",
  title: "A Paper",
  authors: [],
  userContext: "First line\nSecond line",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z"
};

describe("PaperNotesTab", () => {
  it("keeps the personal note editor visible above an empty annotation state", () => {
    const markup = renderToStaticMarkup(
      <PaperNotesTab
        paper={paper}
        annotations={[]}
        onUpdatePaper={vi.fn()}
        onDeleteAnnotation={vi.fn()}
      />
    );

    expect(markup.indexOf("Personal note")).toBeLessThan(
      markup.indexOf("No notes or highlights for this document.")
    );
    expect(markup).toContain("First line\nSecond line");
    expect(markup).toContain('aria-label="Personal note for this paper"');
  });

  it("renders PDF annotations below the personal note", () => {
    const annotation: Annotation = {
      id: "annotation-a",
      paperId: paper.id,
      fileId: "file-a",
      pageIndex: 2,
      kind: "note",
      color: "#ffee58",
      rects: [],
      quote: "Quoted text",
      comment: "Annotation comment",
      createdAt: paper.createdAt,
      updatedAt: paper.updatedAt
    };
    const markup = renderToStaticMarkup(
      <PaperNotesTab
        paper={paper}
        annotations={[annotation]}
        onUpdatePaper={vi.fn()}
        onDeleteAnnotation={vi.fn()}
      />
    );

    expect(markup.indexOf("Personal note")).toBeLessThan(markup.indexOf("Page 3"));
    expect(markup).toContain("Quoted text");
    expect(markup).toContain("Annotation comment");
  });

  it("updates only userContext and removes it when the editor is cleared", () => {
    const updated = updatePaperPersonalNote(paper, "  New note\nwith spacing  ");
    expect(updated).toEqual({
      ...paper,
      userContext: "  New note\nwith spacing  "
    });
    expect(updatePaperPersonalNote(updated, "")).toEqual({
      ...paper,
      userContext: undefined
    });
    expect(updatePaperPersonalNote(paper, paper.userContext!)).toBe(paper);
  });
});
