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
 * Iterates over every `<span>` inside `.react-pdf__Page__textContent`, checks
 * whether its text content includes the (lowercased) query, and converts the
 * span's bounding rect to normalized coordinates relative to the page shell.
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
    if (!text.toLowerCase().includes(query)) continue;

    const spanRect = span.getBoundingClientRect();
    const normalized = normalizeRect(spanRect, pageRect);

    // We highlight the entire matched span. A multi-word span that only
    // partially matches the query is fully highlighted — this is the same
    // approximation most PDF readers make without per-character measurement.
    matches.push({
      pageIndex,
      rect: normalized,
      key: `pdf-search-${pageIndex}-${matchIndex++}`
    });
  }

  return matches;
}
