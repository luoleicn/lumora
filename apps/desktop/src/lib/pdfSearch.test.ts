import { describe, expect, it } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  countTextOccurrences,
  findInPdfText,
  nextPdfSearchMatchIndex,
  previousPdfSearchMatchIndex
} from "./pdfSearch";

describe("PDF text search", () => {
  it("counts case-insensitive non-overlapping occurrences", () => {
    expect(countTextOccurrences("Alpha alpha ALPHA", "alpha")).toBe(3);
    expect(countTextOccurrences("aaaa", "aa")).toBe(2);
    expect(countTextOccurrences("anything", "")).toBe(0);
  });

  it("searches pages without requiring rendered page DOM", async () => {
    const pages = [
      [{ str: "first match and MATCH" }],
      [{ str: "none" }, { str: "last match" }]
    ];
    const document = {
      numPages: pages.length,
      getPage: async (pageNumber: number) => ({
        getTextContent: async () => ({ items: pages[pageNumber - 1] })
      })
    } as unknown as PDFDocumentProxy;

    await expect(findInPdfText(document, "match")).resolves.toEqual([
      { pageIndex: 0, pageMatchIndex: 0, key: "pdf-search-target-0-0" },
      { pageIndex: 0, pageMatchIndex: 1, key: "pdf-search-target-0-1" },
      { pageIndex: 1, pageMatchIndex: 0, key: "pdf-search-target-1-0" }
    ]);
  });

  it("selects a result only when the user navigates", () => {
    expect(nextPdfSearchMatchIndex(-1, 3)).toBe(0);
    expect(nextPdfSearchMatchIndex(0, 3)).toBe(1);
    expect(nextPdfSearchMatchIndex(2, 3)).toBe(0);
    expect(previousPdfSearchMatchIndex(-1, 3)).toBe(2);
    expect(previousPdfSearchMatchIndex(2, 3)).toBe(1);
    expect(nextPdfSearchMatchIndex(-1, 0)).toBe(-1);
  });
});
