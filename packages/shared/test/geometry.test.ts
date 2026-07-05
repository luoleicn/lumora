import { describe, expect, it } from "vitest";
import { denormalizeRect, normalizeRect } from "../src/geometry";

describe("PDF annotation geometry", () => {
  it("normalizes page-relative rectangles", () => {
    const rect = normalizeRect(
      { left: 150, top: 240, width: 200, height: 40 },
      { left: 100, top: 200, width: 500, height: 800 }
    );

    expect(rect).toEqual({
      x: 0.1,
      y: 0.05,
      width: 0.4,
      height: 0.05
    });
  });

  it("denormalizes rectangles for rendered page size", () => {
    expect(denormalizeRect({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, 1000, 500))
      .toEqual({ left: 100, top: 100, width: 300, height: 200 });
  });
});
