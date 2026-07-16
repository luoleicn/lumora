import { describe, expect, it, vi } from "vitest";
import {
  buildPdfRenderPolicy,
  normalizeLinuxGraphicsTier,
  resolvePdfDevicePixelRatio,
  resolvePdfRenderPolicy
} from "./pdfRenderPolicy";

describe("PDF render policy", () => {
  it("keeps the high-quality render budget on modern macOS", () => {
    expect(buildPdfRenderPolicy({
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/620.1",
      isLegacyWebKit: false
    })).toEqual({
      tier: "modern-webkit",
      maxDevicePixelRatio: 2,
      maxCanvasPixels: 16_000_000,
      overscanPages: 2,
      debounceZoom: false
    });
  });

  it("starts Linux with a safe budget until its graphics probe completes", () => {
    expect(buildPdfRenderPolicy({
      platform: "Linux x86_64",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/620.1",
      isLegacyWebKit: false
    })).toEqual({
      tier: "linux-unknown",
      maxDevicePixelRatio: 1.25,
      maxCanvasPixels: 5_000_000,
      overscanPages: 1,
      debounceZoom: true
    });
  });

  it("raises Linux quality for a discrete GPU without enabling live canvas zoom", () => {
    expect(buildPdfRenderPolicy({
      platform: "Linux x86_64",
      isLegacyWebKit: false,
      linuxGraphicsTier: "discrete"
    })).toEqual({
      tier: "linux-discrete",
      maxDevicePixelRatio: 1.75,
      maxCanvasPixels: 8_000_000,
      overscanPages: 1,
      debounceZoom: true
    });
  });

  it("minimizes canvas pressure when Linux uses software rendering", () => {
    expect(buildPdfRenderPolicy({
      platform: "Linux x86_64",
      isLegacyWebKit: false,
      linuxGraphicsTier: "software"
    })).toMatchObject({
      tier: "linux-software",
      maxDevicePixelRatio: 1,
      maxCanvasPixels: 4_000_000,
      overscanPages: 0
    });
  });

  it("keeps Retina quality but removes overscan on older macOS WKWebView", () => {
    expect(buildPdfRenderPolicy({
      platform: "MacIntel",
      isLegacyWebKit: true
    })).toEqual({
      tier: "legacy-webkit",
      maxDevicePixelRatio: 2,
      maxCanvasPixels: 8_000_000,
      overscanPages: 0,
      debounceZoom: true
    });
  });

  it("always keeps Linux on its native renderer policy even with legacy WebKitGTK", () => {
    expect(buildPdfRenderPolicy({
      platform: "Linux x86_64",
      isLegacyWebKit: true,
      linuxGraphicsTier: "hardware"
    })).toMatchObject({
      tier: "linux-hardware",
      maxDevicePixelRatio: 1.5
    });
  });

  it("normalizes native graphics capability responses", () => {
    expect(normalizeLinuxGraphicsTier("discrete")).toBe("discrete");
    expect(normalizeLinuxGraphicsTier("hardware")).toBe("hardware");
    expect(normalizeLinuxGraphicsTier("software")).toBe("software");
    expect(normalizeLinuxGraphicsTier("unexpected")).toBe("unknown");
    expect(normalizeLinuxGraphicsTier(undefined)).toBe("unknown");
  });

  it("uses the asynchronous Linux probe but skips it on macOS", async () => {
    const linuxProbe = vi.fn().mockResolvedValue("discrete" as const);
    const macProbe = vi.fn().mockResolvedValue("software" as const);

    await expect(resolvePdfRenderPolicy({
      platform: "Linux x86_64",
      isLegacyWebKit: false
    }, linuxProbe)).resolves.toMatchObject({ tier: "linux-discrete" });
    await expect(resolvePdfRenderPolicy({
      platform: "MacIntel",
      isLegacyWebKit: false
    }, macProbe)).resolves.toMatchObject({ tier: "modern-webkit" });
    expect(linuxProbe).toHaveBeenCalledOnce();
    expect(macProbe).not.toHaveBeenCalled();
  });

  it("falls back to the software budget when graphics probing fails", async () => {
    await expect(resolvePdfRenderPolicy({
      platform: "Linux x86_64",
      isLegacyWebKit: false
    }, async () => {
      throw new Error("DRM capability probe failed");
    })).resolves.toMatchObject({ tier: "linux-software" });
  });

  it("caps backing-store pixels according to the detected tier", () => {
    const policy = buildPdfRenderPolicy({
      platform: "Linux x86_64",
      isLegacyWebKit: false,
      linuxGraphicsTier: "hardware"
    });

    expect(resolvePdfDevicePixelRatio(2, 1000, 1.3, policy)).toBe(1.5);
    expect(resolvePdfDevicePixelRatio(2, 2500, 1.3, policy)).toBeCloseTo(Math.sqrt(6_000_000 / 8_125_000));
    expect(resolvePdfDevicePixelRatio(2, 4000, 1.3, policy)).toBe(0.75);
    expect(resolvePdfDevicePixelRatio(0, 1000, 1.3, policy)).toBe(1);
  });

  it("preserves 2x Retina rendering on Intel Mac until the canvas budget is reached", () => {
    const policy = buildPdfRenderPolicy({
      platform: "MacIntel",
      isLegacyWebKit: true
    });

    expect(resolvePdfDevicePixelRatio(2, 1000, 1.4, policy)).toBe(2);
    expect(resolvePdfDevicePixelRatio(2, 3000, 1.4, policy))
      .toBeCloseTo(Math.sqrt(8_000_000 / 12_600_000));
  });
});
