import { describe, expect, it } from "vitest";
import {
  buildPdfPageMetrics,
  defaultPdfPageAspectRatio,
  findPdfPageRange,
  listMountedPdfPageIndexes,
  pageOffset
} from "./pdfVirtualization";

describe("PDF page virtualization", () => {
  it("builds offsets from measured and fallback page ratios", () => {
    const metrics = buildPdfPageMetrics(3, 100, { 1: 2 }, 10);

    expect(metrics.heights).toEqual([
      100 * defaultPdfPageAspectRatio,
      200,
      100 * defaultPdfPageAspectRatio
    ]);
    expect(metrics.offsets[0]).toBe(0);
    expect(metrics.offsets[1]).toBeCloseTo(100 * defaultPdfPageAspectRatio + 10);
    expect(metrics.totalHeight).toBeCloseTo(400 * defaultPdfPageAspectRatio / 2 + 220);
  });

  it("returns only visible pages plus a bounded overscan window", () => {
    const metrics = buildPdfPageMetrics(100, 100, Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [index, 1])
    ), 0);

    expect(findPdfPageRange(metrics, 1000, 300, 2)).toEqual({ start: 8, end: 15 });
  });

  it("clamps ranges and page offsets at document boundaries", () => {
    const metrics = buildPdfPageMetrics(4, 100, { 0: 1, 1: 1, 2: 1, 3: 1 }, 0);

    expect(findPdfPageRange(metrics, 0, 50, 3)).toEqual({ start: 0, end: 3 });
    expect(findPdfPageRange(metrics, 380, 100, 1)).toEqual({ start: 2, end: 3 });
    expect(pageOffset(metrics, -2)).toBe(0);
    expect(pageOffset(metrics, 99)).toBe(300);
  });

  it("releases every mounted page while a warm reader tab is inactive", () => {
    expect(listMountedPdfPageIndexes(20, { start: 4, end: 7 }, false)).toEqual([]);
    expect(listMountedPdfPageIndexes(20, { start: 4, end: 7 }, true)).toEqual([4, 5, 6, 7]);
    expect(listMountedPdfPageIndexes(3, { start: -2, end: 10 }, true)).toEqual([0, 1, 2]);
  });
});
