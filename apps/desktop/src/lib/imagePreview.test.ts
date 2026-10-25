import { describe, expect, it } from "vitest";
import { constrainImageView, fitImageScale, stepImageScale, zoomImageAt } from "./imagePreview";

describe("image preview geometry", () => {
  it("fits either image orientation within the canvas and keeps small images sharp", () => {
    expect(fitImageScale({ width: 1600, height: 1000 }, { width: 896, height: 696 })).toBe(0.5);
    expect(fitImageScale({ width: 1000, height: 1600 }, { width: 896, height: 696 })).toBe(0.375);
    expect(fitImageScale({ width: 100, height: 100 }, { width: 896, height: 696 })).toBe(1);
    expect(fitImageScale({ width: 100000, height: 100000 }, { width: 896, height: 696 })).toBe(0.006);
  });

  it("zooms around the cursor and clamps to the supported range", () => {
    expect(zoomImageAt({ scale: 1, x: 20, y: 30 }, 2, { x: 100, y: 100 })).toEqual({ scale: 2, x: -60, y: -40 });
    expect(zoomImageAt({ scale: 1, x: 0, y: 0 }, 100).scale).toBe(8);
    expect(zoomImageAt({ scale: 1, x: 0, y: 0 }, 0).scale).toBe(0.05);
  });

  it("recenters images smaller than the canvas and limits panning of large images", () => {
    const image = { width: 1600, height: 1000 };
    const viewport = { width: 896, height: 696 };
    expect(constrainImageView({ scale: 0.5, x: 100, y: 100 }, image, viewport)).toEqual({ scale: 0.5, x: 0, y: 0 });
    expect(constrainImageView({ scale: 1, x: 9999, y: -9999 }, image, viewport)).toEqual({ scale: 1, x: 400, y: -200 });
  });

  it("steps from fitted percentages through predictable zoom stops", () => {
    expect(stepImageScale(0.44, 1)).toBe(0.5);
    expect(stepImageScale(0.44, -1)).toBe(0.25);
    expect(stepImageScale(0.006, 1)).toBe(0.05);
    expect(stepImageScale(8, 1)).toBe(8);
    expect(stepImageScale(0.05, -1)).toBe(0.05);
  });
});
