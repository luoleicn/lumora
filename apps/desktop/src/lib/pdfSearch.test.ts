import { describe, expect, it } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { countTextOccurrences, findInPdfText } from "./pdfSearch";

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
});
