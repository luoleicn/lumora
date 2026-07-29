import { describe, expect, it } from "vitest";
import { buildPdfRenderPolicy } from "./pdfRenderPolicy";
import {
  decodeNativePdfDocumentInfo,
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

  it("decodes the native IPC link contract with camelCase destination fields", () => {
    expect(decodeNativePdfDocumentInfo({
      sessionId: "session-1",
      pages: [{
        width: 600,
        height: 800,
        links: [{
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.04,
          target: { kind: "internal", pageIndex: 1, top: 0.42 }
        }]
      }, {
        width: 600,
        height: 800,
        links: []
      }]
    }).pages[0].links[0].target).toEqual({
      kind: "internal",
      pageIndex: 1,
      top: 0.42
    });
  });

  it("drops malformed link targets instead of degrading them to page one", () => {
    const document = decodeNativePdfDocumentInfo({
      sessionId: "session-1",
      pages: [{
        width: 600,
        height: 800,
        links: [
          {
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.04,
            target: { kind: "internal", page_index: 0 }
          },
          {
            x: 0.1,
            y: 0.3,
            width: 0.3,
            height: 0.04,
            target: { kind: "internal", pageIndex: 4 }
          }
        ]
      }]
    });

    expect(document.pages[0].links).toEqual([]);
  });
});
