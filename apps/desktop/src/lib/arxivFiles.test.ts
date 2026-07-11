import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryState } from "@lumora/shared";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  putFileBlob: vi.fn(),
  readFileBytes: vi.fn(),
  storePdfToDisk: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class<T> { onmessage = (_message: T) => undefined; }
}));
vi.mock("./localStore", () => ({ putFileBlob: mocks.putFileBlob }));
vi.mock("./fileStorage", () => ({
  buildPdfFileName: () => "paper.pdf",
  readFileBytes: mocks.readFileBytes,
  storePdfToDisk: mocks.storePdfToDisk
}));

import { downloadMissingArxivFiles, normalizeArxivId } from "./arxivFiles";

const now = "2026-07-11T00:00:00.000Z";
const state = (): LibraryState => ({
  papers: [{ id: "paper-1", title: "Paper", authors: [], arxiv: "arXiv:1706.03762v5", createdAt: now, updatedAt: now }],
  fileAssets: [], collections: [], paperCollections: [], annotations: []
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe("normalizeArxivId", () => {
  it("accepts modern, legacy and arxiv URLs", () => {
    expect(normalizeArxivId("arXiv:1706.03762v5")).toBe("1706.03762v5");
    expect(normalizeArxivId("https://arxiv.org/pdf/hep-th/9901001v2.pdf")).toBe("hep-th/9901001v2");
    expect(normalizeArxivId("not-an-id")).toBeUndefined();
  });
});

describe("downloadMissingArxivFiles", () => {
  it("downloads and attaches a PDF when no local file exists", async () => {
    mocks.invoke.mockImplementation(async (_command, args) => {
      args.onProgress.onmessage({ event: "started", totalBytes: 13 });
      args.onProgress.onmessage({ event: "progress", downloadedBytes: 13, totalBytes: 13 });
      return new TextEncoder().encode("%PDF-1.7 test").buffer;
    });
    mocks.readFileBytes.mockResolvedValue(undefined);
    const progress: number[] = [];

    const result = await downloadMissingArxivFiles(state(), { nameTemplate: "{title}" }, {
      sleep: async () => undefined,
      onProgress: (event) => {
        if (event.downloadedBytes !== undefined) progress.push(event.downloadedBytes);
      }
    });

    expect(mocks.invoke).toHaveBeenCalledWith("download_arxiv_pdf", expect.objectContaining({ arxivId: "1706.03762v5" }));
    expect(mocks.putFileBlob).toHaveBeenCalledOnce();
    expect(result.downloaded).toBe(1);
    expect(progress).toEqual([0, 13]);
    expect(result.state.fileAssets[0]).toEqual(expect.objectContaining({
      paperId: "paper-1", mime: "application/pdf", downloadState: "local", fileName: "paper.pdf"
    }));
  });

  it("does not download when an attached PDF is readable locally", async () => {
    const current = state();
    current.fileAssets = [{
      id: "file-1", paperId: "paper-1", sha256: "hash", size: 10, mime: "application/pdf",
      fileName: "paper.pdf", downloadState: "local", createdAt: now, updatedAt: now
    }];
    mocks.readFileBytes.mockResolvedValue(new Uint8Array([1]));

    const result = await downloadMissingArxivFiles(current, { nameTemplate: "{title}" });

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(result.alreadyPresent).toBe(1);
  });

  it("can restrict a Details-page download to the selected paper", async () => {
    const current = state();
    current.papers.push({
      id: "paper-2", title: "Other", authors: [], arxiv: "2401.00001", createdAt: now, updatedAt: now
    });
    mocks.invoke.mockResolvedValue(new TextEncoder().encode("%PDF-1.7 test").buffer);
    mocks.readFileBytes.mockResolvedValue(undefined);

    const result = await downloadMissingArxivFiles(current, { nameTemplate: "{title}" }, {
      paperIds: ["paper-2"],
      sleep: async () => undefined
    });

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("download_arxiv_pdf", expect.objectContaining({ arxivId: "2401.00001" }));
    expect(result.state.fileAssets[0].paperId).toBe("paper-2");
  });
});
