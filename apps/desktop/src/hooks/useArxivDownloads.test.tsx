// @vitest-environment jsdom
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileAsset, LibraryState, Paper } from "@lumora/shared";
import { downloadMissingArxivFiles } from "../lib/arxivFiles";
import { useArxivDownloads } from "./useArxivDownloads";
import type { LibraryStore } from "./useLibraryStore";

vi.mock("../lib/arxivFiles", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/arxivFiles")>(),
  downloadMissingArxivFiles: vi.fn()
}));

const downloadMock = vi.mocked(downloadMissingArxivFiles);
const now = "2026-10-28T00:00:00.000Z";
const paper: Paper = {
  id: "imported", title: "Imported paper", arxiv: "1706.03762v7", authors: [], createdAt: now, updatedAt: now
};
const pdf: FileAsset = {
  id: "pdf", paperId: paper.id, sha256: "hash", size: 100, mime: "application/pdf",
  fileName: "paper.pdf", downloadState: "local", createdAt: now, updatedAt: now
};

function emptyState(): LibraryState {
  return { papers: [], fileAssets: [], collections: [], paperCollections: [], annotations: [] };
}

describe("automatic arXiv import downloads", () => {
  let host: HTMLDivElement;
  let root: Root;
  let downloads: ReturnType<typeof useArxivDownloads>;
  let store: Pick<LibraryStore, "library" | "setLibrary" | "libraryRef">;
  const onStatus = vi.fn();

  function Harness() {
    const [library, setLibrary] = useState(emptyState);
    const libraryRef = useRef<LibraryState>(library);
    useEffect(() => { libraryRef.current = library; }, [library]);
    store = { library, setLibrary, libraryRef };
    downloads = useArxivDownloads({
      store: store as LibraryStore,
      fileStorageSettings: { directory: "/papers", nameTemplate: "{title}" },
      onStatus
    });
    return null;
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    downloadMock.mockReset();
    onStatus.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("downloads a newly imported paper before React commits it and preserves concurrent edits", async () => {
    let finish!: () => void;
    downloadMock.mockImplementation(async (current, settings, options) => {
      expect(current.papers).toEqual([paper]);
      expect(settings.directory).toBe("/papers");
      expect(options?.paperIds).toEqual([paper.id]);
      options?.onProgress?.({ phase: "downloading", done: 0, total: 1, arxivId: paper.arxiv });
      await new Promise<void>((resolve) => { finish = resolve; });
      const state = { ...current, fileAssets: [pdf] };
      options?.onStateUpdate?.(state);
      return { state, downloaded: 1, alreadyPresent: 0, failed: [] };
    });
    let pending!: Promise<string>;
    act(() => {
      store.setLibrary((current) => ({ ...current, papers: [paper] }));
      pending = downloads.downloadImportedPaper(paper);
    });
    expect(downloads.downloadBusy).toBe(true);
    expect(downloads.batchProgress?.arxivId).toBe(paper.arxiv);
    act(() => store.setLibrary((current) => ({
      ...current, papers: current.papers.map((item) => ({ ...item, title: "Edited during download" }))
    })));
    await act(async () => { finish(); await pending; });

    expect(store.library.papers[0].title).toBe("Edited during download");
    expect(store.library.fileAssets).toEqual([pdf]);
    expect(downloads.downloadBusy).toBe(false);
    expect(downloads.batchProgress).toBeUndefined();
  });

  it("queues imported PDFs behind an active batch instead of dropping them", async () => {
    let finishBatch!: () => void;
    downloadMock.mockImplementationOnce(async (state) => {
      await new Promise<void>((resolve) => { finishBatch = resolve; });
      return { state, downloaded: 0, alreadyPresent: 0, failed: [] };
    });
    downloadMock.mockImplementation(async (state) => ({ state, downloaded: 1, alreadyPresent: 0, failed: [] }));
    const secondPaper = { ...paper, id: "second", arxiv: "2401.00001" };
    let batch!: Promise<string>;
    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      batch = downloads.download();
      first = downloads.downloadImportedPaper(paper);
      second = downloads.downloadImportedPaper(secondPaper);
    });
    expect(downloadMock).toHaveBeenCalledTimes(1);
    await act(async () => { finishBatch(); await Promise.all([batch, first, second]); });

    expect(downloadMock).toHaveBeenCalledTimes(3);
    expect(downloadMock.mock.calls[1][2]?.paperIds).toEqual([paper.id]);
    expect(downloadMock.mock.calls[2][2]?.paperIds).toEqual([secondPaper.id]);
    expect(downloads.downloadBusy).toBe(false);
  });

  it("keeps the imported paper and permits retry when its PDF download fails", async () => {
    downloadMock.mockImplementationOnce(async (state) => ({
      state, downloaded: 0, alreadyPresent: 0, failed: [{ arxivId: paper.arxiv!, error: "Network unavailable" }]
    }));
    let message = "";
    await act(async () => {
      store.setLibrary((current) => ({ ...current, papers: [paper] }));
      message = await downloads.downloadImportedPaper(paper);
    });
    expect(message).toContain("1 failed");
    expect(store.library.papers).toEqual([paper]);
    expect(store.library.fileAssets).toEqual([]);
    expect(downloads.downloadBusy).toBe(false);

    downloadMock.mockImplementationOnce(async (state, _settings, options) => {
      const next = { ...state, fileAssets: [pdf] };
      options?.onStateUpdate?.(next);
      return { state: next, downloaded: 1, alreadyPresent: 0, failed: [] };
    });
    await act(async () => { await downloads.download(paper.id); });
    expect(store.library.fileAssets).toEqual([pdf]);
  });
});
