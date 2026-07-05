import type { NormalizedRect } from "./entities.js";

export function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

export function normalizeRect(
  rect: DOMRect | Pick<DOMRect, "left" | "top" | "width" | "height">,
  pageRect: DOMRect | Pick<DOMRect, "left" | "top" | "width" | "height">
): NormalizedRect {
  return {
    x: clamp01((rect.left - pageRect.left) / pageRect.width),
    y: clamp01((rect.top - pageRect.top) / pageRect.height),
    width: clamp01(rect.width / pageRect.width),
    height: clamp01(rect.height / pageRect.height)
  };
}

export function denormalizeRect(
  rect: NormalizedRect,
  pageWidth: number,
  pageHeight: number
): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.x * pageWidth,
    top: rect.y * pageHeight,
    width: rect.width * pageWidth,
    height: rect.height * pageHeight
  };
}

export function mergeNearbyRects(rects: NormalizedRect[]): NormalizedRect[] {
  return rects
    .filter((rect) => rect.width > 0.001 && rect.height > 0.001)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}
