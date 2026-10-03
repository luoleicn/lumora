import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  buildMeasuredListMetrics,
  resolveMeasuredListRange,
  restoreMeasuredListAnchor,
  type MeasuredListMetrics,
  type MeasuredListRange
} from "../lib/measuredListVirtualization";
import { prepareVirtualListSelectionEvent } from "../lib/virtualListSelection";

type MeasuredVirtualListProps<T extends { id: string }> = {
  items: T[];
  renderItem: (item: T) => ReactNode;
  className?: string;
  /** Omit for an owned scroller; Notes uses its existing inspector scroller. */
  scrollContainerSelector?: string;
  estimatedHeight?: number;
  gap?: number;
};

const focusableSelector = "button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";

export function MeasuredVirtualList<T extends { id: string }>({
  items, renderItem, className, scrollContainerSelector, estimatedHeight = 120, gap = 10
}: MeasuredVirtualListProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const nodesRef = useRef(new Map<string, HTMLDivElement>());
  const observerRef = useRef<ResizeObserver | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const heightsRef = useRef(new Map<string, { item: T; width: number; height: number }>());
  const widthRef = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [revision, setRevision] = useState(0);
  const [retainedIds, setRetainedIds] = useState<Set<string>>(() => new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [range, setRange] = useState<MeasuredListRange>(() => resolveMeasuredListRange(
    buildMeasuredListMetrics(items.map((item) => item.id), new Map(), estimatedHeight, gap), 0, 700
  ));
  const anchorRef = useRef<{ metrics: MeasuredListMetrics; top: number } | undefined>(undefined);
  const metrics = useMemo(() => {
    const heights = new Map<string, number>();
    for (const item of items) {
      const cached = heightsRef.current.get(item.id);
      // A changed, offscreen item keeps its previous height as an estimate
      // until it mounts and can be measured, avoiding jumps during edits.
      if (cached && Math.abs(cached.width - widthRef.current) < 0.5) heights.set(item.id, cached.height);
    }
    return buildMeasuredListMetrics(items.map((item) => item.id), heights, estimatedHeight, gap);
  }, [items, revision, estimatedHeight, gap]);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  const viewport = useCallback(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return { top: 0, height: 700, offset: 0 };
    const offset = content.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientTop + scroll.scrollTop;
    return { top: scroll.scrollTop - offset, height: scroll.clientHeight || 700, offset };
  }, []);

  const refreshRange = useCallback(() => {
    const view = viewport();
    const next = resolveMeasuredListRange(metricsRef.current, view.top, view.height);
    setRange((current) => current.start === next.start && current.end === next.end ? current : next);
  }, [viewport]);

  const measure = useCallback(() => {
    frameRef.current = undefined;
    const width = contentRef.current?.getBoundingClientRect().width ?? 0;
    let changed = width > 0 && Math.abs(width - widthRef.current) >= 0.5;
    if (width > 0) widthRef.current = width;
    const byId = new Map(itemsRef.current.map((item) => [item.id, item]));
    for (const [id, node] of nodesRef.current) {
      const item = byId.get(id);
      const box = node.getBoundingClientRect();
      if (!item || box.height <= 0 || box.width <= 0) continue;
      const previous = heightsRef.current.get(id);
      if (previous?.item !== item || Math.abs(previous.height - box.height) >= 0.5 || Math.abs(previous.width - box.width) >= 0.5) {
        heightsRef.current.set(id, { item, width: box.width, height: box.height });
        changed = true;
      }
    }
    if (changed) {
      anchorRef.current = { metrics: metricsRef.current, top: viewport().top };
      setRevision((current) => current + 1);
    } else refreshRange();
  }, [refreshRange, viewport]);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current === undefined) frameRef.current = requestAnimationFrame(measure);
  }, [measure]);

  const registerNode = useCallback((id: string, node: HTMLDivElement | null) => {
    const old = nodesRef.current.get(id);
    if (old) observerRef.current?.unobserve(old);
    if (node) {
      nodesRef.current.set(id, node);
      observerRef.current?.observe(node);
      scheduleMeasure();
    } else nodesRef.current.delete(id);
  }, [scheduleMeasure]);

  useLayoutEffect(() => {
    const root = rootRef.current!;
    const scroll = scrollContainerSelector ? root.closest<HTMLElement>(scrollContainerSelector) ?? root : root;
    scrollRef.current = scroll;
    const observer = new ResizeObserver(scheduleMeasure);
    observerRef.current = observer;
    observer.observe(root);
    if (scroll !== root) observer.observe(scroll);
    for (const node of nodesRef.current.values()) observer.observe(node);
    // Scroll events never scan the full dataset or measure every card.
    let scrollFrame: number | undefined;
    const onScroll = () => {
      if (scrollFrame !== undefined) return;
      scrollFrame = requestAnimationFrame(() => { scrollFrame = undefined; refreshRange(); });
    };
    const retainInteraction = () => {
      const ids = new Set<string>();
      const selection = window.getSelection();
      const focused = document.activeElement;
      for (const [id, node] of nodesRef.current) {
        if (node.contains(focused)) ids.add(id);
        if (selection && !selection.isCollapsed) {
          for (let index = 0; index < selection.rangeCount; index += 1) {
            if (selection.getRangeAt(index).intersectsNode(node)) { ids.add(id); break; }
          }
        }
      }
      setRetainedIds((current) => current.size === ids.size && [...ids].every((id) => current.has(id)) ? current : ids);
      if (!selection || selection.isCollapsed || !root.contains(selection.anchorNode)) setSelectAll(false);
    };
    const prepareSelection = () => flushSync(() => setSelectAll(true));
    scroll.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("focusin", retainInteraction);
    root.addEventListener("focusout", retainInteraction);
    root.addEventListener(prepareVirtualListSelectionEvent, prepareSelection);
    document.addEventListener("selectionchange", retainInteraction);
    refreshRange();
    scheduleMeasure();
    return () => {
      observer.disconnect();
      observerRef.current = undefined;
      scroll.removeEventListener("scroll", onScroll);
      root.removeEventListener("focusin", retainInteraction);
      root.removeEventListener("focusout", retainInteraction);
      root.removeEventListener(prepareVirtualListSelectionEvent, prepareSelection);
      document.removeEventListener("selectionchange", retainInteraction);
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    };
  }, [refreshRange, scheduleMeasure, scrollContainerSelector]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = undefined;
    const scroll = scrollRef.current;
    if (anchor && scroll) {
      const top = restoreMeasuredListAnchor(anchor.metrics, metrics, anchor.top);
      scroll.scrollTop = Math.max(0, viewport().offset + top);
    }
    if (scroll && scroll.clientHeight > 0) {
      scroll.scrollTop = Math.min(scroll.scrollTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    }
    refreshRange();
    // A changed item can grow even if its ResizeObserver has not fired yet.
    scheduleMeasure();
  }, [metrics, refreshRange, scheduleMeasure, viewport]);

  useLayoutEffect(() => {
    const ids = new Set(items.map((item) => item.id));
    for (const id of heightsRef.current.keys()) if (!ids.has(id)) heightsRef.current.delete(id);
  }, [items]);

  const indexes = useMemo(() => {
    const result: number[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (selectAll || (index >= range.start && index < range.end) || retainedIds.has(items[index].id)) result.push(index);
    }
    return result;
  }, [items, range, retainedIds, selectAll]);

  return (
    <div ref={rootRef} className={className} data-virtual-list="" onKeyDown={(event) => {
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement;
      const row = target.closest<HTMLElement>("[data-virtual-item]");
      if (!row) return;
      const controls = Array.from(row.querySelectorAll<HTMLElement>(focusableSelector));
      if (target !== controls[event.shiftKey ? 0 : controls.length - 1]) return;
      const currentIndex = items.findIndex((item) => item.id === row.dataset.virtualItem);
      const nextIndex = currentIndex + (event.shiftKey ? -1 : 1);
      if (nextIndex < 0 || nextIndex >= items.length) return;
      event.preventDefault();
      const nextId = items[nextIndex].id;
      flushSync(() => setRetainedIds((current) => new Set([...current, nextId])));
      const nextRow = nodesRef.current.get(nextId);
      const nextControls = nextRow?.querySelectorAll<HTMLElement>(focusableSelector);
      const nextControl = nextControls?.[event.shiftKey ? nextControls.length - 1 : 0];
      if (!nextControl) return;
      const scroll = scrollRef.current;
      const view = viewport();
      const top = metrics.offsets[nextIndex];
      const bottom = top + metrics.heights[nextIndex];
      if (scroll && (top < view.top || bottom > view.top + view.height)) {
        scroll.scrollTop = view.offset + (top < view.top ? top : bottom - view.height);
        refreshRange();
      }
      nextControl.focus({ preventScroll: true });
    }}>
      <div ref={contentRef} data-virtual-content="" style={{ position: "relative", height: metrics.totalHeight, overflowAnchor: "none" }}>
        {indexes.map((index) => (
          <MeasuredRow key={items[index].id} id={items[index].id} top={metrics.offsets[index]} registerNode={registerNode}>
            {renderItem(items[index])}
          </MeasuredRow>
        ))}
      </div>
    </div>
  );
}

function MeasuredRow({ id, top, registerNode, children }: {
  id: string;
  top: number;
  registerNode: (id: string, node: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const ref = useCallback((node: HTMLDivElement | null) => registerNode(id, node), [id, registerNode]);
  return <div ref={ref} data-virtual-item={id} style={{ position: "absolute", top, width: "100%" }}>{children}</div>;
}
