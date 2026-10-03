export type MeasuredListMetrics = {
  keys: string[];
  offsets: number[];
  heights: number[];
  totalHeight: number;
};

export type MeasuredListRange = { start: number; end: number };

export function buildMeasuredListMetrics(
  keys: string[],
  heights: ReadonlyMap<string, number>,
  estimatedHeight = 120,
  gap = 10
): MeasuredListMetrics {
  const offsets: number[] = [];
  const resolvedHeights: number[] = [];
  let offset = 0;
  const estimate = Number.isFinite(estimatedHeight) ? Math.max(1, estimatedHeight) : 120;
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 10;
  for (const key of keys) {
    const measured = heights.get(key);
    const height = measured !== undefined && Number.isFinite(measured) && measured > 0 ? measured : estimate;
    offsets.push(offset);
    resolvedHeights.push(height);
    offset += height + safeGap;
  }
  return { keys, offsets, heights: resolvedHeights, totalHeight: Math.max(0, offset - (keys.length ? safeGap : 0)) };
}

/** First row whose bottom extends past the given position (gaps belong to the next row). */
export function measuredListIndexAt(metrics: MeasuredListMetrics, top: number): number {
  let low = 0;
  let high = metrics.keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (metrics.offsets[middle] + metrics.heights[middle] <= top) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, metrics.keys.length - 1));
}

export function resolveMeasuredListRange(
  metrics: MeasuredListMetrics,
  scrollTop: number,
  viewportHeight: number,
  overscan = viewportHeight
): MeasuredListRange {
  if (!metrics.keys.length) return { start: 0, end: 0 };
  const top = Number.isFinite(scrollTop) ? scrollTop : 0;
  const height = Number.isFinite(viewportHeight) ? Math.max(1, viewportHeight) : 700;
  const margin = Number.isFinite(overscan) ? Math.max(0, overscan) : height;
  const start = measuredListIndexAt(metrics, Math.max(0, top - margin));
  const bottom = Math.max(0, top + height + margin);
  let low = start;
  let high = metrics.keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (metrics.offsets[middle] < bottom) low = middle + 1;
    else high = middle;
  }
  return { start, end: Math.max(start + 1, low) };
}

/** Keep a measured row's screen position stable when heights above it change. */
export function restoreMeasuredListAnchor(
  previous: MeasuredListMetrics,
  next: MeasuredListMetrics,
  scrollTop: number
): number {
  if (scrollTop < 0 || !previous.keys.length) return scrollTop;
  const index = measuredListIndexAt(previous, scrollTop);
  const nextIndex = next.keys.indexOf(previous.keys[index]);
  return nextIndex < 0 ? scrollTop : next.offsets[nextIndex] + scrollTop - previous.offsets[index];
}
