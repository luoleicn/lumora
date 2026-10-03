import { describe, expect, it } from "vitest";
import { buildMeasuredListMetrics, measuredListIndexAt, resolveMeasuredListRange, restoreMeasuredListAnchor } from "./measuredListVirtualization";

describe("measured list virtualization", () => {
  it("preserves the complete height and gaps for mixed short and long notes", () => {
    const metrics = buildMeasuredListMetrics(["a", "b", "c"], new Map([["a", 45], ["c", 500]]));
    expect(metrics.heights).toEqual([45, 120, 500]);
    expect(metrics.offsets).toEqual([0, 55, 185]);
    expect(metrics.totalHeight).toBe(685);
    expect(measuredListIndexAt(metrics, 44)).toBe(0);
    expect(measuredListIndexAt(metrics, 45)).toBe(1);
    expect(measuredListIndexAt(metrics, 200)).toBe(2);
  });

  it("bounds the window at the start, middle and end of 4,172 annotations", () => {
    const keys = Array.from({ length: 4172 }, (_, index) => String(index));
    const metrics = buildMeasuredListMetrics(keys, new Map());
    for (const top of [0, 200_000, metrics.totalHeight - 700]) {
      const range = resolveMeasuredListRange(metrics, top, 700);
      expect(range.end - range.start).toBeLessThan(25);
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(keys.length);
    }
    expect(resolveMeasuredListRange(metrics, metrics.totalHeight - 700, 700).end).toBe(4172);
    expect(resolveMeasuredListRange(metrics, -400, 700).start).toBe(0);
  });

  it("keeps the visible annotation at the same offset after measurements change", () => {
    const old = buildMeasuredListMetrics(["a", "b", "c"], new Map());
    const resized = buildMeasuredListMetrics(["a", "b", "c"], new Map([["a", 400]]));
    expect(restoreMeasuredListAnchor(old, resized, 150)).toBe(430);
    expect(restoreMeasuredListAnchor(old, resized, -20)).toBe(-20);
    const filtered = buildMeasuredListMetrics(["c"], new Map());
    expect(restoreMeasuredListAnchor(old, filtered, 150)).toBe(150);
  });

  it("handles an empty list and invalid measurements without invalid CSS", () => {
    const empty = buildMeasuredListMetrics([], new Map());
    expect(empty.totalHeight).toBe(0);
    expect(resolveMeasuredListRange(empty, 0, 700)).toEqual({ start: 0, end: 0 });
    const metrics = buildMeasuredListMetrics(["a", "b"], new Map([["a", Number.NaN], ["b", -5]]), Number.NaN, Number.NaN);
    expect(metrics.heights).toEqual([120, 120]);
    expect(resolveMeasuredListRange(metrics, Number.NaN, Number.NaN).end).toBe(2);
  });
});
