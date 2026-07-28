import { describe, expect, it, vi } from "vitest";
import {
  resolveNativePdfDestinationOffset,
  resolvePdfDestinationOffset
} from "./pdfDestination";

const metrics = {
  offsets: [0, 820, 1640],
  heights: [800, 800, 800],
  totalHeight: 2440
};

function documentWithViewport() {
  const convertToViewportPoint = vi.fn((x: number, y: number) => [x * 2, (400 - y) * 2]);
  return {
    document: {
      getPage: vi.fn(async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 400 * scale,
          height: 800 * scale,
          convertToViewportPoint
        })
      }))
    },
    convertToViewportPoint
  };
}

describe("resolvePdfDestinationOffset", () => {
  it("maps an XYZ destination into the virtual page scroll space", async () => {
    const { document, convertToViewportPoint } = documentWithViewport();
    const destination = [{ num: 10, gen: 0 }, { name: "XYZ" }, 20, 300, null];

    await expect(resolvePdfDestinationOffset(document as never, metrics, 800, 1, destination))
      .resolves.toBe(1020);
    expect(document.getPage).toHaveBeenCalledWith(2);
    expect(convertToViewportPoint).toHaveBeenCalledWith(20, 300);
  });

  it("maps FitH and FitR destinations using their top coordinate", async () => {
    const { document } = documentWithViewport();
    await expect(resolvePdfDestinationOffset(
      document as never, metrics, 800, 2, [0, { name: "FitH" }, 350]
    )).resolves.toBe(1740);
    await expect(resolvePdfDestinationOffset(
      document as never, metrics, 800, 0, [0, { name: "FitR" }, 10, 20, 100, 250]
    )).resolves.toBe(300);
  });

  it("falls back to the target page top for destinations without a vertical coordinate", async () => {
    const { document } = documentWithViewport();
    await expect(resolvePdfDestinationOffset(
      document as never, metrics, 800, 1, [0, { name: "Fit" }]
    )).resolves.toBe(820);
    expect(document.getPage).not.toHaveBeenCalled();
  });

  it("maps a native normalized destination into the virtual page scroll space", () => {
    expect(resolveNativePdfDestinationOffset(metrics, 1, 0.375)).toBe(1120);
    expect(resolveNativePdfDestinationOffset(metrics, 1)).toBe(820);
  });

  it("bounds malformed native destination positions to the target page", () => {
    expect(resolveNativePdfDestinationOffset(metrics, 2, -0.5)).toBe(1640);
    expect(resolveNativePdfDestinationOffset(metrics, 0, 1.5)).toBe(800);
    expect(resolveNativePdfDestinationOffset(metrics, 1, Number.NaN)).toBe(820);
  });
});
