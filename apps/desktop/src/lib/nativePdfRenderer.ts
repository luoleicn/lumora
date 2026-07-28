import { invoke } from "@tauri-apps/api/core";
import type { PdfRenderPolicy } from "./pdfRenderPolicy";
import type { PdfSearchTarget } from "./pdfSearch";

export type NativePdfPageInfo = {
  width: number;
  height: number;
  links: NativePdfLink[];
};

export type NativePdfDocumentInfo = {
  sessionId: string;
  pages: NativePdfPageInfo[];
};

export type NativePdfInternalLinkTarget = {
  kind: "internal";
  pageIndex: number;
  top?: number;
};

export type NativePdfLinkTarget =
  | NativePdfInternalLinkTarget
  | { kind: "external"; url: string };

export type NativePdfLink = {
  x: number;
  y: number;
  width: number;
  height: number;
  target: NativePdfLinkTarget;
};

const pendingPageRenders = new Map<string, Promise<Uint8Array>>();
const pageRenderQueue: Array<() => void> = [];
const maxConcurrentPageRenders = 2;
let activePageRenders = 0;

export function shouldUseNativePdfRenderer(policy: PdfRenderPolicy): boolean {
  return policy.tier.startsWith("linux-");
}

export function isLinuxNativePdfPlatform(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent
): boolean {
  return /linux/i.test(platform) || /linux/i.test(userAgent);
}

export async function openNativePdfDocument(bytes: Uint8Array): Promise<NativePdfDocumentInfo> {
  // Legacy IndexedDB PDFs have no native path. Transfer them in bounded raw
  // chunks: sending one 50–100 MB ArrayBuffer makes affected JavaScriptCore
  // versions atomize millions of numeric properties before Rust sees it.
  const uploadId = crypto.randomUUID();
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + chunkSize));
    await invoke("native_pdf_stage_chunk", chunk.buffer as ArrayBuffer, {
      headers: {
        "x-lumora-pdf-upload-id": encodeURIComponent(uploadId),
        "x-lumora-pdf-upload-reset": offset === 0 ? "1" : "0"
      }
    });
  }
  return invoke<NativePdfDocumentInfo>("native_pdf_open_upload", { uploadId });
}

export function openNativePdfPath(directory: string, fileName: string): Promise<NativePdfDocumentInfo> {
  return invoke<NativePdfDocumentInfo>("native_pdf_open_path", {
    dir: directory,
    fileName
  });
}

export async function renderNativePdfPage(
  sessionId: string,
  pageNumber: number,
  pixelWidth: number
): Promise<Uint8Array> {
  const normalizedWidth = normalizeNativePdfPixelWidth(pixelWidth);
  const key = `${sessionId}:${pageNumber}:${normalizedWidth}`;
  const existing = pendingPageRenders.get(key);
  if (existing) {
    return existing;
  }

  const request = schedulePageRender(async () => {
    const buffer = await invoke<ArrayBuffer>("native_pdf_render_page", {
      sessionId,
      pageNumber,
      pixelWidth: normalizedWidth
    });
    return new Uint8Array(buffer);
  });
  pendingPageRenders.set(key, request);
  const clearPending = () => {
    if (pendingPageRenders.get(key) === request) {
      pendingPageRenders.delete(key);
    }
  };
  void request.then(clearPending, clearPending);
  return request;
}

export function loadNativePdfPageText(sessionId: string, pageNumber: number): Promise<string> {
  return invoke<string>("native_pdf_page_text", { sessionId, pageNumber });
}

export function findInNativePdfText(sessionId: string, query: string): Promise<PdfSearchTarget[]> {
  return invoke<PdfSearchTarget[]>("native_pdf_search", { sessionId, query });
}

export function normalizeNativePdfPixelWidth(pixelWidth: number): number {
  if (!Number.isFinite(pixelWidth)) {
    return 1024;
  }
  return Math.min(8192, Math.max(256, Math.round(pixelWidth)));
}

function schedulePageRender<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activePageRenders += 1;
      void task().then(resolve, reject).finally(() => {
        activePageRenders -= 1;
        pageRenderQueue.shift()?.();
      });
    };
    if (activePageRenders < maxConcurrentPageRenders) {
      run();
    } else {
      pageRenderQueue.push(run);
    }
  });
}
