export type VirtualListRange = {
  start: number;
  end: number;
  paddingBefore: number;
  paddingAfter: number;
};

export type VirtualListMetrics = {
  itemHeight: number;
  leadingHeight?: number;
  overscanItems?: number;
};

/**
 * Resolve an exclusive item range for fixed-height desktop lists. Keeping the
 * calculation DOM-independent makes the same policy usable by WebKitGTK and
 * WKWebView list implementations.
 */
export function resolveVirtualListRange(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  metrics: VirtualListMetrics
): VirtualListRange {
  const count = Math.max(0, Math.floor(itemCount));
  const itemHeight = Math.max(1, metrics.itemHeight);
  const leadingHeight = Math.max(0, metrics.leadingHeight ?? 0);
  const overscan = Math.max(0, Math.floor(metrics.overscanItems ?? 0));
  const safeScrollTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const safeViewportHeight = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const firstVisible = Math.floor(Math.max(0, safeScrollTop - leadingHeight) / itemHeight);
  const lastVisible = Math.ceil(Math.max(0, safeScrollTop + safeViewportHeight - leadingHeight) / itemHeight);
  const start = Math.min(count, Math.max(0, firstVisible - overscan));
  const end = Math.min(count, Math.max(start, lastVisible + overscan));

  return {
    start,
    end,
    paddingBefore: start * itemHeight,
    paddingAfter: (count - end) * itemHeight
  };
}
