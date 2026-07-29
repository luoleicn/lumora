import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfPageMetrics } from "./pdfVirtualization";
import { pageOffset } from "./pdfVirtualization";

type PdfDestinationMode = { name?: unknown };

/**
 * Converts a resolved PDF.js destination into the scroll coordinate owned by
 * Lumora's virtual page list. react-pdf's default navigation scrolls a mounted
 * page DOM node, which is not reliable when the destination page is virtualized.
 */
export async function resolvePdfDestinationOffset(
  document: Pick<PDFDocumentProxy, "getPage">,
  metrics: PdfPageMetrics,
  renderedPageWidth: number,
  pageIndex: number,
  destination?: unknown
): Promise<number> {
  const pageTop = pageOffset(metrics, pageIndex);
  if (!Array.isArray(destination)) {
    return pageTop;
  }

  const position = destinationPosition(destination);
  if (!position) {
    return pageTop;
  }

  const page = await document.getPage(pageIndex + 1);
  const unscaledViewport = page.getViewport({ scale: 1 });
  const scale = renderedPageWidth / unscaledViewport.width;
  const viewport = page.getViewport({ scale });
  const [, viewportY] = viewport.convertToViewportPoint(position.x, position.y);
  const boundedY = Math.min(Math.max(viewportY, 0), viewport.height);
  return pageTop + boundedY;
}

export function resolveNativePdfDestinationOffset(
  metrics: PdfPageMetrics,
  pageIndex: number,
  normalizedTop?: number
): number | undefined {
  // `pageOffset` intentionally clamps UI input, but PDF destinations come from
  // an IPC contract. Invalid contract data must fail closed instead of being
  // converted to the first page.
  if (!Number.isInteger(pageIndex)
    || pageIndex < 0
    || pageIndex >= metrics.offsets.length
    || pageIndex >= metrics.heights.length) {
    return undefined;
  }
  const pageTop = pageOffset(metrics, pageIndex);
  if (typeof normalizedTop !== "number" || !Number.isFinite(normalizedTop)) {
    return pageTop;
  }
  const pageHeight = metrics.heights[pageIndex];
  if (typeof pageHeight !== "number" || !Number.isFinite(pageHeight) || pageHeight <= 0) {
    return pageTop;
  }
  return pageTop + Math.min(Math.max(normalizedTop, 0), 1) * pageHeight;
}

function destinationPosition(destination: unknown[]): { x: number; y: number } | undefined {
  const mode = (destination[1] as PdfDestinationMode | undefined)?.name;
  switch (mode) {
    case "XYZ":
      return numericPosition(destination[2], destination[3]);
    case "FitH":
    case "FitBH":
      return numericPosition(0, destination[2]);
    case "FitR":
      return numericPosition(destination[2], destination[5]);
    default:
      return undefined;
  }
}

function numericPosition(x: unknown, y: unknown): { x: number; y: number } | undefined {
  if (typeof y !== "number" || !Number.isFinite(y)) {
    return undefined;
  }
  return {
    x: typeof x === "number" && Number.isFinite(x) ? x : 0,
    y
  };
}
