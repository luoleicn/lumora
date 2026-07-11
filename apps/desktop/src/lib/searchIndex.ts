import { invoke } from "@tauri-apps/api/core";
import type { FileAsset, LibraryState, Paper } from "@lumora/shared";

// Frontend half of the library full-text search: invoke wrappers for the FTS5
// commands, PDF body extraction (pdf.js), and pure helpers for the backfill
// planner and result rendering. The Rust side segments CJK text into
// single-character tokens by injecting spaces, so snippets come back with those
// spaces and are collapsed again before display (collapseCjkSpaces).

export type SearchMatchedField = "title" | "body" | "authors" | "notes";

export type SearchHit = {
  paperId: string;
  tier: number;
  score: number;
  matchedFields: SearchMatchedField[];
  snippet: string;
};

export type BodyIndexStatus = {
  paperId: string;
  bodySha: string;
};

export type BodyBackfillItem = {
  paperId: string;
  fileAsset: FileAsset;
};

export type SnippetSegment = {
  text: string;
  highlighted: boolean;
};

export type PaperSearchMeta = {
  matchedFields: SearchMatchedField[];
  snippet: string;
};

export const SNIPPET_HIGHLIGHT_START = "\u0001";
export const SNIPPET_HIGHLIGHT_END = "\u0002";

const defaultSearchLimit = 200;
const maxBodyPages = 300;
const maxBodyChars = 600_000;

export async function searchLibrary(query: string, limit = defaultSearchLimit): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("db_search_library", { query, limit });
}

export async function indexPaperBody(paperId: string, sha256: string, text: string): Promise<void> {
  await invoke("db_index_paper_body", { paperId, sha256, text });
}

export async function getSearchIndexStatus(): Promise<BodyIndexStatus[]> {
  return invoke<BodyIndexStatus[]>("db_search_index_status");
}

// Bag-of-words is all FTS needs, so this skips the layout reconstruction that
// pdfMetadata.ts does for the first page and just joins every page's items.
export async function extractPdfBodyText(
  fileData: Uint8Array,
  { maxPages = maxBodyPages, maxChars = maxBodyChars }: { maxPages?: number; maxChars?: number } = {}
): Promise<string> {
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!GlobalWorkerOptions.workerSrc) {
    GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
  }

  const loadingTask = getDocument({ data: fileData.slice().buffer });
  const document = await loadingTask.promise;
  try {
    const pages: string[] = [];
    let totalChars = 0;
    const pageCount = Math.min(document.numPages, maxPages);
    for (let pageNumber = 1; pageNumber <= pageCount && totalChars < maxChars; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = (content.items as Array<{ str?: unknown }>)
        .map((item) => (typeof item.str === "string" ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        pages.push(text);
        totalChars += text.length + 1;
      }
    }
    const body = pages.join("\n");
    return body.length > maxChars ? body.slice(0, maxChars) : body;
  } finally {
    await document.destroy();
  }
}

function isLocalPdf(fileAsset: FileAsset): boolean {
  return (
    !fileAsset.deletedAt
    && fileAsset.downloadState === "local"
    && (fileAsset.mime === "application/pdf" || /\.pdf$/i.test(fileAsset.fileName))
  );
}

// Papers whose local PDF has never been extracted, or whose PDF changed since
// (sha mismatch). Recently updated papers first so fresh imports index early.
export function planBodyBackfill(state: LibraryState, status: BodyIndexStatus[]): BodyBackfillItem[] {
  const indexedShaByPaperId = new Map(status.map((item) => [item.paperId, item.bodySha]));
  const items: Array<BodyBackfillItem & { updatedAt: string }> = [];

  for (const paper of state.papers) {
    if (paper.deletedAt) {
      continue;
    }
    const fileAsset = state.fileAssets.find((item) => item.paperId === paper.id && isLocalPdf(item));
    if (!fileAsset?.sha256 || indexedShaByPaperId.get(paper.id) === fileAsset.sha256) {
      continue;
    }
    items.push({ paperId: paper.id, fileAsset, updatedAt: paper.updatedAt });
  }

  return items
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ paperId, fileAsset }) => ({ paperId, fileAsset }));
}

export function mapHitsToPapers(hits: SearchHit[], papers: Paper[]): Paper[] {
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  const result: Paper[] = [];
  for (const hit of hits) {
    const paper = paperById.get(hit.paperId);
    if (paper && !paper.deletedAt) {
      result.push(paper);
    }
  }
  return result;
}

export function splitSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let highlighted = false;
  let current = "";
  for (const char of snippet) {
    if (char === SNIPPET_HIGHLIGHT_START || char === SNIPPET_HIGHLIGHT_END) {
      if (current) {
        segments.push({ text: current, highlighted });
      }
      current = "";
      highlighted = char === SNIPPET_HIGHLIGHT_START;
    } else {
      current += char;
    }
  }
  if (current) {
    segments.push({ text: current, highlighted });
  }
  return segments;
}

const cjkChar = "[\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF]";
const highlightMarker = "[\\u0001\\u0002]";
const spaceBetweenCjk = new RegExp(`(${cjkChar}${highlightMarker}?) (?=${highlightMarker}?${cjkChar})`, "g");

// Only the space between two CJK chars is provably segmentation noise; a space
// at a CJK-latin boundary may be genuine, so it stays. Snippet highlight
// markers may sit between the two chars (at a match boundary) and are ignored.
export function collapseCjkSpaces(text: string): string {
  return text.replace(spaceBetweenCjk, "$1");
}
