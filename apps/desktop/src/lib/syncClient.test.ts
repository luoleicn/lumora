import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSyncSummary, LibraryState } from "@lumora/shared";

const invokeMock = vi.fn();
const persistEntitiesMock = vi.fn();
const loadLibraryFromDbMock = vi.fn();
const readFileBytesMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("./libraryDb", () => ({
  persistEntities: (...args: unknown[]) => persistEntitiesMock(...args),
  loadLibraryFromDb: (...args: unknown[]) => loadLibraryFromDbMock(...args)
}));
vi.mock("./fileStorage", () => ({
  loadFileStorageSettings: () => ({ directory: "/library", nameTemplate: "{title}" }),
  readFileBytes: (...args: unknown[]) => readFileBytesMock(...args),
  getStoredPdfMetadata: vi.fn(),
  storePdfToDisk: vi.fn()
}));
vi.mock("./localStore", () => ({ putFileBlob: vi.fn() }));

import { syncLibrary } from "./syncClient";

const now = "2026-07-12T00:00:00.000Z";
const oldHash = "a".repeat(64);

function summary(): CloudSyncSummary {
  return {
    uploadedChanges: 0,
    downloadedChanges: 0,
    uploadedFiles: 0,
    downloadedFiles: 0,
    arxivDownloads: 0,
    pendingChanges: 0,
    lastSyncedAt: now,
    errors: []
  };
}

describe("syncLibrary arXiv boundary", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    persistEntitiesMock.mockReset().mockResolvedValue(undefined);
    loadLibraryFromDbMock.mockReset();
    readFileBytesMock.mockReset();
  });

  it("syncs only metadata and deletes the old blob when a paper has an arXiv ID", async () => {
    const initial: LibraryState = {
      papers: [{ id: "paper-a", title: "Paper", authors: [], arxiv: "2401.12345v2", createdAt: now, updatedAt: now }],
      fileAssets: [{
        id: "file-a", paperId: "paper-a", sha256: oldHash, size: 42,
        mime: "application/pdf", fileName: "paper.pdf", localPath: "paper.pdf",
        contentRef: { kind: "object", sha256: oldHash }, createdAt: now, updatedAt: now
      }],
      collections: [], paperCollections: [], annotations: []
    };
    const converted: LibraryState = {
      ...initial,
      fileAssets: [{ ...initial.fileAssets[0], contentRef: { kind: "arxiv", arxivId: "2401.12345v2" } }]
    };
    loadLibraryFromDbMock.mockResolvedValue({ state: converted, empty: false });
    invokeMock.mockImplementation((command: string) => {
      if (command === "qiniu_sync_library") return Promise.resolve(summary());
      return Promise.resolve(undefined);
    });

    await syncLibrary({ accessKey: "ak", bucket: "bucket", region: "", privateDomain: "domain", prefix: "lumora/v1", configured: true }, initial);

    expect(readFileBytesMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("download_arxiv_pdf_silent", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("download_arxiv_pdf", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("qiniu_upload_blob", expect.anything(), expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("qiniu_delete_blob", { sha256: oldHash });
    expect(persistEntitiesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        entityType: "fileAsset",
        entity: expect.objectContaining({ contentRef: { kind: "arxiv", arxivId: "2401.12345v2" } })
      })
    ]);
  });
});
