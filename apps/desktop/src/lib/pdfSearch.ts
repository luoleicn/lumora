import type { NormalizedRect } from "@lumora/shared";
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
};

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
                key: `pdf-search-${pageIndex}-${matchIndex++}`
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
          key: `pdf-search-${pageIndex}-${matchIndex++}`
        });
      }

      searchFrom = pos + query.length;
    }
  }

  return matches;
}
