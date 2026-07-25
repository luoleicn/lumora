import { Channel, invoke } from "@tauri-apps/api/core";
import type { ArxivMetadata, FileAsset, LibraryState, Paper } from "@lumora/shared";
import { createId } from "./id";
import { putFileBlob } from "./localStore";
import {
  buildPdfFileName,
  readFileBytes,
  storePdfToDisk,
  type FileStorageSettings
} from "./fileStorage";

export type ArxivDownloadProgress = {
  phase: "checking" | "downloading" | "waiting";
  done: number;
  total: number;
  arxivId?: string;
  downloadedBytes?: number;
  totalBytes?: number;
};

type ArxivDownloadEvent =
  | { event: "started"; totalBytes?: number }
  | { event: "progress"; downloadedBytes: number; totalBytes?: number };

export type ArxivDownloadResult = {
  state: LibraryState;
  downloaded: number;
  alreadyPresent: number;
  failed: Array<{ arxivId: string; error: string }>;
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

type ArxivDownloadOptions = {
  paperIds?: string[];
  onProgress?: (progress: ArxivDownloadProgress) => void;
  onStateUpdate?: (state: LibraryState) => void;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function normalizeArxivId(value: string): string | undefined {
  const trimmed = value.trim()
    .replace(/^arxiv:\s*/i, "")
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf(?:\?.*)?$/i, "")
    .replace(/[?#].*$/, "");
  return /^(?:\d{4}\.\d{4,5}|[A-Za-z-]+(?:\.[A-Za-z-]+)?\/\d{7})(?:v\d+)?$/.test(trimmed)
    ? trimmed
    : undefined;
}

export function arxivMetadataToPaperPatch(metadata: ArxivMetadata): Partial<Paper> {
  return {
    arxiv: metadata.arxivId,
    title: metadata.title,
    authors: metadata.authors,
    year: metadata.year,
    venue: metadata.venue ?? "arXiv",
    doi: metadata.doi,
    abstract: metadata.abstract,
    url: metadata.url,
    documentType: "preprint",
    keywords: metadata.categories ?? [],
    needsReview: false
  };
}

export function buildArxivPaper(metadata: ArxivMetadata, now: string): Paper {
  const patch = arxivMetadataToPaperPatch(metadata);
  return {
    ...patch,
    id: createId("paper"),
    // Paper.title is required, so keep the id as a readable last resort.
    title: patch.title?.trim() || `arXiv:${metadata.arxivId}`,
    authors: patch.authors ?? [],
    source: "manual",
    favorite: false,
    needsReview: false,
    unread: true,
    createdAt: now,
    updatedAt: now
  };
}

export async function downloadMissingArxivFiles(
  current: LibraryState,
  settings: FileStorageSettings,
  options: ArxivDownloadOptions = {}
): Promise<ArxivDownloadResult> {
  const papers = current.papers
    .filter((paper) =>
      !paper.deletedAt
      && paper.arxiv
      && normalizeArxivId(paper.arxiv)
      && (!options.paperIds || options.paperIds.includes(paper.id))
    )
    .map((paper) => ({ paper, arxivId: normalizeArxivId(paper.arxiv!)! }));
  const missing: Array<{ paper: Paper; arxivId: string; reusableFile?: FileAsset }> = [];
  let alreadyPresent = 0;

  for (const [index, entry] of papers.entries()) {
    options.onProgress?.({ phase: "checking", done: index, total: papers.length, arxivId: entry.arxivId });
    const pdfAssets = current.fileAssets.filter((file) =>
      file.paperId === entry.paper.id
      && !file.deletedAt
      && (file.mime === "application/pdf" || /\.pdf$/i.test(file.fileName))
    );
    let hasLocalPdf = false;
    for (const file of pdfAssets) {
      const bytes = await readFileBytes(file, settings);
      if (bytes?.length) {
        hasLocalPdf = true;
        break;
      }
    }
    if (hasLocalPdf) {
      alreadyPresent += 1;
    } else {
      missing.push({ ...entry, reusableFile: pdfAssets[0] });
    }
  }

  let state = current;
  let downloaded = 0;
  const failed: ArxivDownloadResult["failed"] = [];
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (const [index, entry] of missing.entries()) {
    if (index > 0) {
      options.onProgress?.({ phase: "waiting", done: index, total: missing.length, arxivId: entry.arxivId });
      await sleep(3_000);
    }
    options.onProgress?.({ phase: "downloading", done: index, total: missing.length, arxivId: entry.arxivId });
    try {
      const onProgress = new Channel<ArxivDownloadEvent>();
      onProgress.onmessage = (event) => {
        options.onProgress?.({
          phase: "downloading",
          done: index,
          total: missing.length,
          arxivId: entry.arxivId,
          downloadedBytes: event.event === "progress" ? event.downloadedBytes : 0,
          totalBytes: event.totalBytes
        });
      };
      const buffer = await invoke<ArrayBuffer>("download_arxiv_pdf", { arxivId: entry.arxivId, onProgress });
      const bytes = new Uint8Array(buffer);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const targetName = buildPdfFileName(entry.paper, settings.nameTemplate);
      const base: FileAsset = entry.reusableFile ?? {
        id: createId("file"),
        paperId: entry.paper.id,
        sha256,
        size: bytes.length,
        mime: "application/pdf",
        fileName: targetName,
        downloadState: "local",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      let storedName = targetName;
      if (settings.directory) {
        storedName = await storePdfToDisk(settings.directory, targetName, bytes);
      } else {
        await putFileBlob(base.id, new Blob([bytes], { type: "application/pdf" }));
      }
      const now = new Date().toISOString();
      const file: FileAsset = {
        ...base,
        paperId: entry.paper.id,
        sha256,
        size: bytes.length,
        mime: "application/pdf",
        fileName: storedName,
        contentRef: { kind: "arxiv", arxivId: entry.arxivId },
        localPath: settings.directory ? storedName : undefined,
        downloadState: "local",
        updatedAt: now,
        deletedAt: undefined
      };
      state = {
        ...state,
        fileAssets: state.fileAssets.some((item) => item.id === file.id)
          ? state.fileAssets.map((item) => item.id === file.id ? file : item)
          : [file, ...state.fileAssets]
      };
      downloaded += 1;
      options.onStateUpdate?.(state);
    } catch (error) {
      failed.push({ arxivId: entry.arxivId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { state, downloaded, alreadyPresent, failed };
}
