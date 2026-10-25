export type ImageSize = { width: number; height: number };
export type ImageView = { scale: number; x: number; y: number };

export const minImageScale = 0.05;
export const maxImageScale = 8;
const canvasInset = 48;
const zoomStops = [0.05, 0.1, 0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

export function clampImageScale(scale: number): number {
  return Math.min(maxImageScale, Math.max(minImageScale, scale));
}

export function fitImageScale(image: ImageSize, viewport: ImageSize): number {
  if (!image.width || !image.height || !viewport.width || !viewport.height) return 1;
  return Math.max(Number.EPSILON, Math.min(1,
    Math.max(1, viewport.width - canvasInset * 2) / image.width,
    Math.max(1, viewport.height - canvasInset * 2) / image.height));
}

export function stepImageScale(scale: number, direction: 1 | -1): number {
  return direction === 1
    ? zoomStops.find((stop) => stop > scale + 0.001) ?? maxImageScale
    : [...zoomStops].reverse().find((stop) => stop < scale - 0.001) ?? minImageScale;
}

export function constrainImageView(view: ImageView, image: ImageSize, viewport: ImageSize): ImageView {
  const limitX = Math.max(0, (image.width * view.scale - viewport.width + canvasInset * 2) / 2);
  const limitY = Math.max(0, (image.height * view.scale - viewport.height + canvasInset * 2) / 2);
  return { ...view, x: Math.min(limitX, Math.max(-limitX, view.x)), y: Math.min(limitY, Math.max(-limitY, view.y)) };
}

/** Keep the same image point under the cursor while zooming. */
export function zoomImageAt(view: ImageView, scale: number, anchor = { x: 0, y: 0 }): ImageView {
  const next = clampImageScale(scale);
  const ratio = next / view.scale;
  return { scale: next, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio };
}
