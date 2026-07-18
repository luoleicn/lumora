import type { NormalizedRect } from "@lumora/shared";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { normalizeRect } from "@lumora/shared";

// PDF text-layer search: walks the rendered DOM spans that react-pdf produces and
// returns their bounding rects normalized to the page element. Using the DOM
// layer avoids PDF coordinate-system conversion — the coordinates are already in
// the same CSS-pixel space as the annotation overlay.

export type PdfSearchMatch = {
  /** 0-based page index */
  pageIndex: number;
  /** Normalized rect relative to the page element */
  rect: NormalizedRect;
  /** Unique key for React list rendering */
  key: string;
  /** Zero-based occurrence within this page. */
  matchIndex: number;
};

export type PdfSearchTarget = {
  pageIndex: number;
  pageMatchIndex: number;
  key: string;
};

export function nextPdfSearchMatchIndex(activeIndex: number, totalMatches: number): number {
  if (totalMatches <= 0) return -1;
  return activeIndex < 0 || activeIndex >= totalMatches - 1 ? 0 : activeIndex + 1;
}

export function previousPdfSearchMatchIndex(activeIndex: number, totalMatches: number): number {
  if (totalMatches <= 0) return -1;
  return activeIndex <= 0 || activeIndex >= totalMatches ? totalMatches - 1 : activeIndex - 1;
}

// Search the PDF text model rather than the rendered DOM. This keeps find-in-
// document complete when only a small virtual window of pages is mounted.
export async function findInPdfText(
  document: PDFDocumentProxy,
  query: string,
  shouldCancel: () => boolean = () => false
): Promise<PdfSearchTarget[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const targets: PdfSearchTarget[] = [];
  for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
    if (shouldCancel()) {
      return [];
    }

    const page = await document.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    let pageMatchIndex = 0;
    for (const item of content.items as Array<{ str?: unknown }>) {
      if (typeof item.str !== "string") {
        continue;
      }
      const count = countTextOccurrences(item.str, normalizedQuery);
      for (let occurrence = 0; occurrence < count; occurrence += 1) {
        targets.push({
          pageIndex,
          pageMatchIndex,
          key: `pdf-search-target-${pageIndex}-${pageMatchIndex}`
        });
        pageMatchIndex += 1;
      }
    }
  }

  return shouldCancel() ? [] : targets;
}

export function countTextOccurrences(text: string, normalizedQuery: string): number {
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  let count = 0;
  let searchFrom = 0;
  while (searchFrom < normalizedText.length) {
    const position = normalizedText.indexOf(normalizedQuery, searchFrom);
    if (position === -1) {
      break;
    }
    count += 1;
    searchFrom = position + normalizedQuery.length;
  }
  return count;
}

/**
 * Searches the rendered text layer of a single PDF page for a query string.
 *
 * Each `<span>` inside `.react-pdf__Page__textContent` is matched case-
 * insensitively.  When the span contains a single text node the DOM Range API
 * measures only the matched substring so that the highlight overlay is as
 * narrow as possible; multi-rect ranges (word wrapped across visual lines) are
 * split into one highlight per rect.  Spans with a more complex child layout
 * fall back to highlighting the whole span.
 *
 * @param pageElement - The `.page-shell` DOM element (has `data-page-index`)
 * @param pageIndex  - Zero-based page index for the returned matches
 * @param query      - Lowercased search query
 * @returns Array of match positions for this page
 */
export function findInPageTextLayer(
  pageElement: HTMLElement,
  pageIndex: number,
  query: string
): PdfSearchMatch[] {
  const textContent = pageElement.querySelector(".react-pdf__Page__textContent");
  if (!textContent) return [];

  const pageRect = pageElement.getBoundingClientRect();
  const textSpans = Array.from(textContent.querySelectorAll("span"));
  const matches: PdfSearchMatch[] = [];
  let matchIndex = 0;

  for (const span of textSpans) {
    const text = span.textContent ?? "";
    const lowerText = text.toLowerCase();
    let searchFrom = 0;

    while (searchFrom < text.length) {
      const pos = lowerText.indexOf(query, searchFrom);
      if (pos === -1) break;
      const currentMatchIndex = matchIndex;
      let matchRectIndex = 0;

      const textNode = span.firstChild;
      if (textNode && textNode.nodeType === Node.TEXT_NODE && textNode.textContent) {
        const nodeLen = textNode.textContent.length;
        const start = Math.min(pos, nodeLen);
        const end = Math.min(pos + query.length, nodeLen);
        if (start < end) {
          const range = document.createRange();
          range.setStart(textNode, start);
          range.setEnd(textNode, end);
          const rects = range.getClientRects();
          for (let r = 0; r < rects.length; r++) {
            const rect = rects[r];
            if (rect.width > 0 && rect.height > 0) {
              matches.push({
                pageIndex,
                rect: normalizeRect(rect, pageRect),
                key: `pdf-search-${pageIndex}-${currentMatchIndex}-${matchRectIndex++}`,
                matchIndex: currentMatchIndex
              });
            }
          }
        }
      } else {
        // Fallback: highlight the whole span when the DOM isn't a simple text node.
        const spanRect = span.getBoundingClientRect();
        matches.push({
          pageIndex,
          rect: normalizeRect(spanRect, pageRect),
          key: `pdf-search-${pageIndex}-${currentMatchIndex}-0`,
          matchIndex: currentMatchIndex
        });
      }

      matchIndex += 1;
      searchFrom = pos + query.length;
    }
  }

  return matches;
}
