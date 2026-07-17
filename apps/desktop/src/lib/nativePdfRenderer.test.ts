import { describe, expect, it } from "vitest";
import { buildPdfRenderPolicy } from "./pdfRenderPolicy";
import {
  isLinuxNativePdfPlatform,
  normalizeNativePdfPixelWidth,
  shouldUseNativePdfRenderer
} from "./nativePdfRenderer";

describe("native PDF renderer", () => {
  it("isolates page rasterization on Linux but keeps WKWebView on its native path", () => {
    expect(shouldUseNativePdfRenderer(buildPdfRenderPolicy({
      platform: "Linux x86_64",
      isLegacyWebKit: false,
      linuxGraphicsTier: "discrete"
    }))).toBe(true);
    expect(shouldUseNativePdfRenderer(buildPdfRenderPolicy({
      platform: "MacIntel",
      isLegacyWebKit: false
    }))).toBe(false);
  });

  it("bounds sidecar image width independently of CSS zoom", () => {
    expect(normalizeNativePdfPixelWidth(1200.4)).toBe(1200);
    expect(normalizeNativePdfPixelWidth(100)).toBe(256);
    expect(normalizeNativePdfPixelWidth(9000)).toBe(8192);
    expect(normalizeNativePdfPixelWidth(Number.NaN)).toBe(1024);
  });

  it("recognizes Linux without relying on WebGL", () => {
    expect(isLinuxNativePdfPlatform("Linux x86_64", "")).toBe(true);
    expect(isLinuxNativePdfPlatform("", "Mozilla/5.0 (X11; Linux x86_64)")).toBe(true);
    expect(isLinuxNativePdfPlatform("MacIntel", "Mozilla/5.0 (Macintosh)")).toBe(false);
  });
});
