import { describe, expect, it } from "vitest";
import { isNoteImageUrl, noteBlocks, noteDraft, noteDraftsEqual, type NoteContent } from "../src/notes.js";

const image = { type: "image" as const, dataUrl: "data:image/png;base64,aGVsbG8=", alt: "Figure" };

describe("portable notes", () => {
  it("retains paragraph whitespace and needs no rich payload for legacy text", () => {
    expect(noteDraft([{ type: "text", text: "  A\n" }, { type: "text", text: "\nB  " }])).toEqual({ text: "  A\n\nB  " });
    expect(noteBlocks("Old note")).toEqual([{ type: "text", text: "Old note" }]);
  });

  it("round-trips mixed content and image-only notes through entity JSON without local paths", () => {
    const blocks = [{ type: "text" as const, text: "Before" }, image, { type: "text" as const, text: "After" }];
    const saved = JSON.parse(JSON.stringify(noteDraft(blocks)));
    expect(noteBlocks(saved.text, saved.content)).toEqual(blocks);
    expect(saved.text).toBe("Before\n[Figure]\nAfter");
    expect(noteDraft([image]).content?.blocks).toEqual([image]);
    expect(noteDraft(noteBlocks(saved.text, saved.content))).toEqual(saved);
  });

  it("rejects remote URLs, local paths, SVG and executable URLs", () => {
    for (const value of ["https://example.com/a.png", "file:///tmp/a.png", "blob:local", "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,broken!"]) {
      expect(isNoteImageUrl(value)).toBe(false);
      const content = { version: 1, blocks: [{ ...image, dataUrl: value }] } as NoteContent;
      expect(noteBlocks("", content)).toEqual([]);
    }
  });

  it("detects image changes even when fallback text is unchanged", () => {
    const first = noteDraft([image]);
    const second = noteDraft([{ ...image, dataUrl: "data:image/png;base64,Ynl0ZXM=" }]);
    expect(first.text).toBe(second.text);
    expect(noteDraftsEqual(first, second)).toBe(false);
    expect(noteDraftsEqual(first, JSON.parse(JSON.stringify(first)))).toBe(true);
  });
});
