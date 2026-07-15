export type PdfPageMetrics = {
  offsets: number[];
  heights: number[];
  totalHeight: number;
};

export type PdfPageRange = {
  start: number;
  end: number;
};

export const defaultPdfPageAspectRatio = Math.SQRT2;
export const defaultPdfPageGap = 18;

export function buildPdfPageMetrics(
  numPages: number,
  renderedWidth: number,
  aspectRatios: Readonly<Record<number, number>>,
  gap = defaultPdfPageGap
): PdfPageMetrics {
  const offsets: number[] = [];
  const heights: number[] = [];
  let offset = 0;

  for (let pageIndex = 0; pageIndex < numPages; pageIndex += 1) {
    const ratio = normalizeAspectRatio(aspectRatios[pageIndex]);
    const height = renderedWidth * ratio;
    offsets.push(offset);
    heights.push(height);
    offset += height + gap;
  }

  return {
    offsets,
    heights,
    totalHeight: Math.max(0, offset - (numPages > 0 ? gap : 0))
  };
}

export function findPdfPageRange(
  metrics: PdfPageMetrics,
  scrollTop: number,
  viewportHeight: number,
  overscanPages = 2
): PdfPageRange {
  const pageCount = metrics.offsets.length;
  if (pageCount === 0) {
    return { start: 0, end: -1 };
  }

  const viewportStart = Math.max(0, scrollTop);
  const viewportEnd = viewportStart + Math.max(1, viewportHeight);
  const firstVisible = findFirstPageEndingAfter(metrics, viewportStart);
  const lastVisible = findLastPageStartingBefore(metrics, viewportEnd);

  return {
    start: Math.max(0, firstVisible - overscanPages),
    end: Math.min(pageCount - 1, Math.max(firstVisible, lastVisible) + overscanPages)
  };
}

export function pageOffset(metrics: PdfPageMetrics, pageIndex: number): number {
  if (metrics.offsets.length === 0) {
    return 0;
  }
  const clampedIndex = Math.min(Math.max(pageIndex, 0), metrics.offsets.length - 1);
  return metrics.offsets[clampedIndex] ?? 0;
}

function findFirstPageEndingAfter(metrics: PdfPageMetrics, value: number): number {
  let low = 0;
  let high = metrics.offsets.length - 1;
  let result = high;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const pageEnd = metrics.offsets[middle] + metrics.heights[middle];
    if (pageEnd > value) {
      result = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return result;
}

function findLastPageStartingBefore(metrics: PdfPageMetrics, value: number): number {
  let low = 0;
  let high = metrics.offsets.length - 1;
  let result = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (metrics.offsets[middle] <= value) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

function normalizeAspectRatio(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? value : defaultPdfPageAspectRatio;
}
