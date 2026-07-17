import { invoke } from "@tauri-apps/api/core";

export type LinuxGraphicsTier = "discrete" | "hardware" | "software" | "unknown";

export type PdfRenderEnvironment = {
  platform?: string;
  userAgent?: string;
  isLegacyWebKit: boolean;
  linuxGraphicsTier?: LinuxGraphicsTier;
};

export type PdfRenderPolicy = {
  tier: "modern-webkit" | "legacy-webkit" | "linux-discrete" | "linux-hardware" | "linux-software" | "linux-unknown";
  maxDevicePixelRatio: number;
  maxCanvasPixels: number;
  overscanPages: number;
  debounceZoom: boolean;
};

const modernWebKitPolicy: PdfRenderPolicy = {
  tier: "modern-webkit",
  maxDevicePixelRatio: 2,
  maxCanvasPixels: 16_000_000,
  overscanPages: 2,
  debounceZoom: false
};

const legacyWebKitPolicy: PdfRenderPolicy = {
  tier: "legacy-webkit",
  // Intel Retina Macs still need a 2x backing store at normal reading widths.
  // Save work by mounting only visible pages and cap unusually large zoomed
  // canvases instead of globally softening every page to 1.5x.
  maxDevicePixelRatio: 2,
  maxCanvasPixels: 8_000_000,
  overscanPages: 0,
  debounceZoom: true
};

const linuxPolicies: Record<LinuxGraphicsTier, PdfRenderPolicy> = {
  discrete: {
    tier: "linux-discrete",
    // Pages are rasterized by Poppler outside WebKitGTK, so a discrete GPU
    // machine can afford the same backing-store budget as modern macOS.
    // Fractional caps below the display DPR blur HiDPI text on upscale.
    maxDevicePixelRatio: 2,
    maxCanvasPixels: 16_000_000,
    overscanPages: 1,
    debounceZoom: true
  },
  hardware: {
    tier: "linux-hardware",
    maxDevicePixelRatio: 1.5,
    maxCanvasPixels: 6_000_000,
    overscanPages: 1,
    debounceZoom: true
  },
  software: {
    tier: "linux-software",
    maxDevicePixelRatio: 1,
    maxCanvasPixels: 4_000_000,
    overscanPages: 0,
    debounceZoom: true
  },
  unknown: {
    tier: "linux-unknown",
    maxDevicePixelRatio: 1.25,
    maxCanvasPixels: 5_000_000,
    overscanPages: 1,
    debounceZoom: true
  }
};

let detectedPolicyPromise: Promise<PdfRenderPolicy> | undefined;

/**
 * Linux Tauri uses WebKitGTK, whose canvas/font path has a materially different
 * performance profile from WKWebView on macOS. Capability detection alone is
 * insufficient because current WebKitGTK implements modern JavaScript APIs but
 * may still be running its graphics stack on the CPU.
 */
export function buildPdfRenderPolicy(environment: PdfRenderEnvironment): PdfRenderPolicy {
  if (isLinux(environment.platform, environment.userAgent)) {
    return linuxPolicies[environment.linuxGraphicsTier ?? "unknown"];
  }
  if (environment.isLegacyWebKit) {
    return legacyWebKitPolicy;
  }
  return modernWebKitPolicy;
}

export function readPdfRenderEnvironment(isLegacyWebKit: boolean): PdfRenderEnvironment {
  if (typeof navigator === "undefined") {
    return { isLegacyWebKit };
  }

  return {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    isLegacyWebKit
  };
}

export function detectPdfRenderPolicy(isLegacyWebKit: boolean): PdfRenderPolicy {
  return buildPdfRenderPolicy(readPdfRenderEnvironment(isLegacyWebKit));
}

/** Resolve and cache the policy once per WebView process. */
export function detectPdfRenderPolicyWithGraphics(isLegacyWebKit: boolean): Promise<PdfRenderPolicy> {
  if (!detectedPolicyPromise) {
    const environment = readPdfRenderEnvironment(isLegacyWebKit);
    detectedPolicyPromise = resolvePdfRenderPolicy(environment, probeLinuxGraphicsTier);
  }
  return detectedPolicyPromise;
}

export async function resolvePdfRenderPolicy(
  environment: PdfRenderEnvironment,
  probe: () => Promise<LinuxGraphicsTier>
): Promise<PdfRenderPolicy> {
  if (!isLinux(environment.platform, environment.userAgent)) {
    return buildPdfRenderPolicy(environment);
  }

  let linuxGraphicsTier: LinuxGraphicsTier;
  try {
    linuxGraphicsTier = await probe();
  } catch {
    // Missing DRM access and unsupported runtimes must never increase the PDF
    // memory budget.
    linuxGraphicsTier = "software";
  }

  return buildPdfRenderPolicy({ ...environment, linuxGraphicsTier });
}

/**
 * Ask the native process to inspect Linux DRM/sysfs. Never initialize WebGL in
 * WebKitGTK merely to detect graphics support: affected WebKit releases can
 * enter an AtomString allocation loop during context creation.
 */
export async function probeLinuxGraphicsTier(): Promise<LinuxGraphicsTier> {
  const capability = await invoke<{ tier?: unknown }>("linux_graphics_capability");
  return normalizeLinuxGraphicsTier(capability?.tier);
}

export function normalizeLinuxGraphicsTier(value: unknown): LinuxGraphicsTier {
  return value === "discrete" || value === "hardware" || value === "software"
    ? value
    : "unknown";
}

/**
 * Keep a single page canvas within the platform budget. DPR may dip below 1 at
 * extreme zoom levels: the CSS page is already enlarged then, so this preserves
 * useful detail without allocating a quadratic-size backing store.
 */
export function resolvePdfDevicePixelRatio(
  devicePixelRatio: number,
  renderedWidth: number,
  aspectRatio: number,
  policy: PdfRenderPolicy
): number {
  const safeDevicePixelRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const cappedDevicePixelRatio = Math.min(safeDevicePixelRatio, policy.maxDevicePixelRatio);
  const cssPixels = renderedWidth * renderedWidth * aspectRatio;
  if (!Number.isFinite(cssPixels) || cssPixels <= 0) {
    return cappedDevicePixelRatio;
  }

  const budgetedDevicePixelRatio = Math.sqrt(policy.maxCanvasPixels / cssPixels);
  return Math.max(0.75, Math.min(cappedDevicePixelRatio, budgetedDevicePixelRatio));
}

function isLinux(platform?: string, userAgent?: string) {
  return /linux/i.test(platform ?? "") || /linux/i.test(userAgent ?? "");
}
