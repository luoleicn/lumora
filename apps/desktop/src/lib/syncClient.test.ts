import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSyncSummary, LibraryState } from "@lumora/shared";

const invokeMock = vi.fn();
const persistEntitiesMock = vi.fn();
const loadLibraryFromDbMock = vi.fn();
const readFileBytesMock = vi.fn();
const getStoredPdfMetadataMock = vi.fn();
const storePdfToDiskMock = vi.fn();
const putFileBlobMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("./libraryDb", () => ({
  persistEntities: (...args: unknown[]) => persistEntitiesMock(...args),
  loadLibraryFromDb: (...args: unknown[]) => loadLibraryFromDbMock(...args)
}));
vi.mock("./fileStorage", () => ({
  loadFileStorageSettings: () => ({ directory: "/library", nameTemplate: "{title}" }),
  readFileBytes: (...args: unknown[]) => readFileBytesMock(...args),
  getStoredPdfMetadata: (...args: unknown[]) => getStoredPdfMetadataMock(...args),
  storePdfToDisk: (...args: unknown[]) => storePdfToDiskMock(...args)
}));
vi.mock("./localStore", () => ({ putFileBlob: (...args: unknown[]) => putFileBlobMock(...args) }));

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
    errors: [],
    requestCount: 0,
    putRequests: 0,
    getRequests: 0,
    headRequests: 0,
    deleteRequests: 0,
    uploadedBytes: 0,
    downloadedBytes: 0
  };
}

function networkStats() {
  return {
    requestCount: 2,
    putRequests: 1,
    getRequests: 0,
    headRequests: 1,
    deleteRequests: 0,
    uploadedBytes: 4,
    downloadedBytes: 0
  };
}

describe("syncLibrary arXiv boundary", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    persistEntitiesMock.mockReset().mockResolvedValue(undefined);
    loadLibraryFromDbMock.mockReset();
    readFileBytesMock.mockReset();
    getStoredPdfMetadataMock.mockReset();
    storePdfToDiskMock.mockReset();
    putFileBlobMock.mockReset();
    const local = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, value),
      removeItem: (key: string) => local.delete(key)
    });
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
      if (command === "qiniu_delete_blob") return Promise.resolve({
        requestCount: 2, putRequests: 0, getRequests: 0, headRequests: 1,
        deleteRequests: 1, uploadedBytes: 0, downloadedBytes: 0
      });
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

  it("downloads one cloud object natively for multiple FileAssets with the same SHA-256 and persists each copy", async () => {
    const sharedHash = "b".repeat(64);
    const initial: LibraryState = {
      papers: [
        { id: "paper-a", title: "A", authors: [], createdAt: now, updatedAt: now },
        { id: "paper-b", title: "B", authors: [], createdAt: now, updatedAt: now }
      ],
      fileAssets: [
        {
          id: "file-a", paperId: "paper-a", sha256: sharedHash, size: 4,
          mime: "application/pdf", fileName: "a.pdf", downloadState: "remote",
          contentRef: { kind: "object", sha256: sharedHash }, createdAt: now, updatedAt: now
        },
        {
          id: "file-b", paperId: "paper-b", sha256: sharedHash, size: 4,
          mime: "application/pdf", fileName: "b.pdf", downloadState: "remote",
          contentRef: { kind: "object", sha256: sharedHash }, createdAt: now, updatedAt: now
        }
      ],
      collections: [], paperCollections: [], annotations: []
    };
    loadLibraryFromDbMock.mockResolvedValue({ state: initial, empty: false });
    readFileBytesMock.mockResolvedValue(undefined);
    invokeMock.mockImplementation((command: string) => {
      if (command === "qiniu_sync_library") return Promise.resolve(summary());
      if (command === "qiniu_download_blob_to_files") return Promise.resolve({
        files: [
          { requested: "a.pdf", stored: "a.pdf" },
          { requested: "b.pdf", stored: "b.pdf" }
        ],
        size: 4,
        stats: {
          requestCount: 1, putRequests: 0, getRequests: 1, headRequests: 0,
          deleteRequests: 0, uploadedBytes: 0, downloadedBytes: 4
        }
      });
      return Promise.resolve(undefined);
    });

    const result = await syncLibrary(
      { accessKey: "ak", bucket: "bucket", region: "", privateDomain: "domain", prefix: "lumora/v1", configured: true },
      initial
    );

    const downloadCalls = invokeMock.mock.calls.filter(([command]) => command === "qiniu_download_blob_to_files");
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0][1]).toEqual({ sha256: sharedHash, dir: "/library", fileNames: ["a.pdf", "b.pdf"] });
    // The bytes stay in Rust: no legacy blob download and no store round trip.
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_download_blob")).toBe(false);
    expect(storePdfToDiskMock).not.toHaveBeenCalled();
    expect(persistEntitiesMock).toHaveBeenCalledTimes(2);
    expect(persistEntitiesMock.mock.calls[0][1]).toBe("remote");
    expect(persistEntitiesMock.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        entityType: "fileAsset",
        entity: expect.objectContaining({ id: "file-a", localPath: "a.pdf", downloadState: "local" })
      })
    ]);
    expect(result.summary.downloadedFiles).toBe(2);
    expect(result.summary.downloadedBytes).toBe(4);
    expect(result.summary.getRequests).toBe(1);
  });

  it("uploads disk-backed files natively without the bytes crossing the IPC boundary", async () => {
    const sha256 = "1".repeat(64);
    const initial: LibraryState = {
      papers: [{ id: "paper-a", title: "A", authors: [], createdAt: now, updatedAt: now }],
      fileAssets: [{
        id: "file-a", paperId: "paper-a", sha256, size: 4,
        mime: "application/pdf", fileName: "a.pdf", localPath: "a.pdf", downloadState: "local",
        contentRef: { kind: "object", sha256 }, createdAt: now, updatedAt: now
      }],
      collections: [], paperCollections: [], annotations: []
    };
    getStoredPdfMetadataMock.mockResolvedValue({ size: 4, modifiedMs: 123 });
    loadLibraryFromDbMock.mockResolvedValue({ state: initial, empty: false });
    invokeMock.mockImplementation((command: string) => {
      if (command === "qiniu_sync_library") return Promise.resolve(summary());
      if (command === "qiniu_upload_stored_blob") return Promise.resolve({
        sha256, size: 4, modifiedMs: 123, stable: true, uploaded: true,
        stats: {
          requestCount: 2, putRequests: 1, getRequests: 0, headRequests: 1,
          deleteRequests: 0, uploadedBytes: 4, downloadedBytes: 0
        }
      });
      return Promise.resolve(undefined);
    });

    const result = await syncLibrary(
      { accessKey: "ak", bucket: "bucket", region: "", privateDomain: "domain", prefix: "lumora/v1", configured: true },
      initial
    );

    const uploadCalls = invokeMock.mock.calls.filter(([command]) => command === "qiniu_upload_stored_blob");
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0][1]).toEqual(expect.objectContaining({ dir: "/library", fileName: "a.pdf" }));
    expect(readFileBytesMock).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_upload_blob")).toBe(false);
    expect(result.summary.uploadedFiles).toBe(1);
    expect(result.summary.uploadedBytes).toBe(4);
    const verified = JSON.parse(localStorage.getItem("lumora:qiniu-verified-local-files-v1") ?? "{}");
    expect(verified["file-a"]).toEqual(expect.objectContaining({ sha256, cloudVerifiedAt: expect.any(Number) }));
  });

  it("fills a missing copy from a local sibling via the native clone command", async () => {
    const sha256 = "2".repeat(64);
    const initial: LibraryState = {
      papers: [
        { id: "paper-a", title: "A", authors: [], createdAt: now, updatedAt: now },
        { id: "paper-b", title: "B", authors: [], createdAt: now, updatedAt: now }
      ],
      fileAssets: [
        {
          id: "file-a", paperId: "paper-a", sha256, size: 4,
          mime: "application/pdf", fileName: "a.pdf", localPath: "a.pdf", downloadState: "local",
          contentRef: { kind: "object", sha256 }, createdAt: now, updatedAt: now
        },
        {
          id: "file-b", paperId: "paper-b", sha256, size: 4,
          mime: "application/pdf", fileName: "b.pdf", downloadState: "remote",
          contentRef: { kind: "object", sha256 }, createdAt: now, updatedAt: now
        }
      ],
      collections: [], paperCollections: [], annotations: []
    };
    getStoredPdfMetadataMock.mockResolvedValue({ size: 4, modifiedMs: 123 });
    readFileBytesMock.mockResolvedValue(undefined);
    loadLibraryFromDbMock.mockResolvedValue({ state: initial, empty: false });
    invokeMock.mockImplementation((command: string) => {
      if (command === "qiniu_sync_library") return Promise.resolve(summary());
      if (command === "qiniu_upload_stored_blob") return Promise.resolve({
        sha256, size: 4, modifiedMs: 123, stable: true, uploaded: false, stats: {
          requestCount: 1, putRequests: 0, getRequests: 0, headRequests: 1,
          deleteRequests: 0, uploadedBytes: 0, downloadedBytes: 0
        }
      });
      if (command === "clone_stored_pdf") return Promise.resolve([{ requested: "b.pdf", stored: "b.pdf" }]);
      return Promise.resolve(undefined);
    });

    const result = await syncLibrary(
      { accessKey: "ak", bucket: "bucket", region: "", privateDomain: "domain", prefix: "lumora/v1", configured: true },
      initial
    );

    const cloneCalls = invokeMock.mock.calls.filter(([command]) => command === "clone_stored_pdf");
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0][1]).toEqual({
      dir: "/library", sourceFileName: "a.pdf", expectedSha256: sha256, targetFileNames: ["b.pdf"]
    });
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_download_blob")).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_download_blob_to_files")).toBe(false);
    expect(persistEntitiesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        entityType: "fileAsset",
        entity: expect.objectContaining({ id: "file-b", localPath: "b.pdf", downloadState: "local" })
      })
    ], "remote");
    expect(result.summary.downloadedFiles).toBe(1);
    expect(result.summary.getRequests).toBe(0);
  });

  it("reuses a recent cloud verification instead of issuing an hourly HEAD", async () => {
    const sha256 = "c".repeat(64);
    const initial: LibraryState = {
      papers: [{ id: "paper-a", title: "A", authors: [], createdAt: now, updatedAt: now }],
      fileAssets: [{
        id: "file-a", paperId: "paper-a", sha256, size: 4,
        mime: "application/pdf", fileName: "a.pdf", localPath: "a.pdf", downloadState: "local",
        contentRef: { kind: "object", sha256 }, createdAt: now, updatedAt: now
      }],
      collections: [], paperCollections: [], annotations: []
    };
    localStorage.setItem("lumora:qiniu-verified-local-files-v1", JSON.stringify({
      "file-a": {
        sha256,
        storage: "disk",
        path: "a.pdf",
        size: 4,
        modifiedMs: 123,
        cloudTarget: JSON.stringify(["ak", "bucket", "", "domain", "lumora/v1"]),
        cloudVerifiedAt: Date.now()
      }
    }));
    getStoredPdfMetadataMock.mockResolvedValue({ size: 4, modifiedMs: 123 });
    readFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    loadLibraryFromDbMock.mockResolvedValue({ state: initial, empty: false });
    invokeMock.mockImplementation((command: string) => {
      if (command === "qiniu_sync_library") return Promise.resolve(summary());
      return Promise.resolve(undefined);
    });

    await syncLibrary(
      { accessKey: "ak", bucket: "bucket", region: "", privateDomain: "domain", prefix: "lumora/v1", configured: true },
      initial
    );

    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_object_exists")).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_list_blobs")).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_upload_blob")).toBe(false);
  });

  it("verifies disk-backed downloads with a metadata stat and never reads bytes when nothing is missing", async () => {
    const sha256 = "9".repeat(64);
    const initial: LibraryState = {
      papers: [{ id: "paper-a", title: "A", authors: [], createdAt: now, updatedAt: now }],
      fileAssets: [{
        id: "file-a", paperId: "paper-a", sha256, size: 4,
        mime: "application/pdf", fileName: "a.pdf", localPath: "a.pdf", downloadState: "local",
        contentRef: { kind: "object", sha256 }, createdAt: now, updatedAt: now
      }],
      collections: [], paperCollections: [], annotations: []
    };
    localStorage.setItem("lumora:qiniu-verified-local-files-v1", JSON.stringify({
      "file-a": {
        sha256,
        storage: "disk",
        path: "a.pdf",
        size: 4,
        modifiedMs: 123,
        cloudTarget: JSON.stringify(["ak", "bucket", "", "domain", "lumora/v1"]),
        cloudVerifiedAt: Date.now()
      }
    }));
    getStoredPdfMetadataMock.mockResolvedValue({ size: 4, modifiedMs: 123 });
    loadLibraryFromDbMock.mockResolvedValue({ state: initial, empty: false });
    invokeMock.mockImplementation((command: string) => {
      if (command === "qiniu_sync_library") return Promise.resolve(summary());
      return Promise.resolve(undefined);
    });

    await syncLibrary(
      { accessKey: "ak", bucket: "bucket", region: "", privateDomain: "domain", prefix: "lumora/v1", configured: true },
      initial
    );

    // The steady-state sync must be byte-free: presence comes from the stat.
    expect(readFileBytesMock).not.toHaveBeenCalled();
    expect(storePdfToDiskMock).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_download_blob")).toBe(false);
  });

  it("re-verifies stale cloud state with a single blob listing instead of per-file stats", async () => {
    const shaA = "d".repeat(64);
    const shaB = "e".repeat(64);
    const initial: LibraryState = {
      papers: [{ id: "paper-a", title: "A", authors: [], createdAt: now, updatedAt: now }],
      fileAssets: [
        {
          id: "file-a", paperId: "paper-a", sha256: shaA, size: 4,
          mime: "application/pdf", fileName: "a.pdf", localPath: "a.pdf", downloadState: "local",
          contentRef: { kind: "object", sha256: shaA }, createdAt: now, updatedAt: now
        },
        {
          id: "file-b", paperId: "paper-a", sha256: shaB, size: 7,
          mime: "application/pdf", fileName: "b.pdf", localPath: "b.pdf", downloadState: "local",
          contentRef: { kind: "object", sha256: shaB }, createdAt: now, updatedAt: now
        }
      ],
      collections: [], paperCollections: [], annotations: []
    };
    const staleVerifiedAt = Date.now() - 25 * 60 * 60 * 1_000;
    localStorage.setItem("lumora:qiniu-verified-local-files-v1", JSON.stringify({
      "file-a": {
        sha256: shaA, storage: "disk", path: "a.pdf", size: 4, modifiedMs: 123,
        cloudTarget: JSON.stringify(["ak", "bucket", "", "domain", "lumora/v1"]),
        cloudVerifiedAt: staleVerifiedAt
      },
      "file-b": {
        sha256: shaB, storage: "disk", path: "b.pdf", size: 7, modifiedMs: 456,
        cloudTarget: JSON.stringify(["ak", "bucket", "", "domain", "lumora/v1"]),
        cloudVerifiedAt: staleVerifiedAt
      }
    }));
    getStoredPdfMetadataMock.mockImplementation(async (_dir: string, path: string) =>
      path === "a.pdf" ? { size: 4, modifiedMs: 123 } : { size: 7, modifiedMs: 456 });
    readFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    loadLibraryFromDbMock.mockResolvedValue({ state: initial, empty: false });
    invokeMock.mockImplementation((command: string) => {
      if (command === "qiniu_sync_library") return Promise.resolve(summary());
      if (command === "qiniu_list_blobs") return Promise.resolve({
        sizes: { [shaA]: 4, [shaB]: 7 },
        stats: {
          requestCount: 1, putRequests: 0, getRequests: 1, headRequests: 0,
          deleteRequests: 0, uploadedBytes: 0, downloadedBytes: 512
        }
      });
      if (command === "qiniu_download_blob") return Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
      return Promise.resolve(undefined);
    });

    const result = await syncLibrary(
      { accessKey: "ak", bucket: "bucket", region: "", privateDomain: "domain", prefix: "lumora/v1", configured: true },
      initial
    );

    expect(invokeMock.mock.calls.filter(([command]) => command === "qiniu_list_blobs")).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_object_exists")).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_upload_blob")).toBe(false);
    expect(result.summary.headRequests).toBe(0);
    expect(localStorage.getItem("lumora:qiniu-blob-count-v1")).toBe("2");
  });

  it("prefers a single HEAD over listing the whole bucket when only one hash is pending", async () => {
    const sha256 = "f".repeat(64);
    const initial: LibraryState = {
      papers: [{ id: "paper-a", title: "A", authors: [], createdAt: now, updatedAt: now }],
      fileAssets: [{
        id: "file-a", paperId: "paper-a", sha256, size: 4,
        mime: "application/pdf", fileName: "a.pdf", localPath: "a.pdf", downloadState: "local",
        contentRef: { kind: "object", sha256 }, createdAt: now, updatedAt: now
      }],
      collections: [], paperCollections: [], annotations: []
    };
    localStorage.setItem("lumora:qiniu-verified-local-files-v1", JSON.stringify({
      "file-a": {
        sha256, storage: "disk", path: "a.pdf", size: 4, modifiedMs: 123,
        cloudTarget: JSON.stringify(["ak", "bucket", "", "domain", "lumora/v1"]),
        cloudVerifiedAt: Date.now() - 25 * 60 * 60 * 1_000
      }
    }));
    getStoredPdfMetadataMock.mockResolvedValue({ size: 4, modifiedMs: 123 });
    readFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    loadLibraryFromDbMock.mockResolvedValue({ state: initial, empty: false });
    invokeMock.mockImplementation((command: string) => {
      if (command === "qiniu_sync_library") return Promise.resolve(summary());
      if (command === "qiniu_object_exists") return Promise.resolve({
        exists: true, size: 4,
        stats: {
          requestCount: 1, putRequests: 0, getRequests: 0, headRequests: 1,
          deleteRequests: 0, uploadedBytes: 0, downloadedBytes: 0
        }
      });
      if (command === "qiniu_download_blob") return Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
      return Promise.resolve(undefined);
    });

    const result = await syncLibrary(
      { accessKey: "ak", bucket: "bucket", region: "", privateDomain: "domain", prefix: "lumora/v1", configured: true },
      initial
    );

    expect(invokeMock).toHaveBeenCalledWith("qiniu_object_exists", { sha256 });
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_list_blobs")).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_upload_blob")).toBe(false);
    expect(result.summary.headRequests).toBe(1);
  });

  it("records a file-specific upload failure and still syncs metadata", async () => {
    const initial: LibraryState = {
      papers: [{ id: "paper-a", title: "A", authors: [], createdAt: now, updatedAt: now }],
      fileAssets: [{
        id: "file-a", paperId: "paper-a", sha256: "pending", size: 4,
        mime: "application/pdf", fileName: "too-large.pdf", downloadState: "local",
        createdAt: now, updatedAt: now
      }],
      collections: [], paperCollections: [], annotations: []
    };
    readFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    loadLibraryFromDbMock.mockResolvedValue({ state: initial, empty: false });
    invokeMock.mockImplementation((command: string) => {
      if (command === "qiniu_upload_blob") return Promise.resolve({
        uploaded: false,
        stats: networkStats(),
        error: { kind: "file", message: "413 Payload Too Large" }
      });
      if (command === "qiniu_sync_library") return Promise.resolve(summary());
      return Promise.resolve(undefined);
    });

    const result = await syncLibrary(
      { accessKey: "ak", bucket: "bucket", region: "", privateDomain: "domain", prefix: "lumora/v1", configured: true },
      initial
    );

    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_sync_library")).toBe(true);
    expect(result.summary.errors).toContain("too-large.pdf: 413 Payload Too Large");
    expect(result.summary.putRequests).toBe(1);
    expect(result.summary.uploadedBytes).toBe(4);
  });

  it("stops before metadata sync for a fatal upload error", async () => {
    const initial: LibraryState = {
      papers: [{ id: "paper-a", title: "A", authors: [], createdAt: now, updatedAt: now }],
      fileAssets: [{
        id: "file-a", paperId: "paper-a", sha256: "pending", size: 4,
        mime: "application/pdf", fileName: "paper.pdf", downloadState: "local",
        createdAt: now, updatedAt: now
      }],
      collections: [], paperCollections: [], annotations: []
    };
    readFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    invokeMock.mockImplementation((command: string) => {
      if (command === "qiniu_upload_blob") return Promise.resolve({
        uploaded: false,
        stats: networkStats(),
        error: { kind: "fatal", message: "403 signature mismatch" }
      });
      if (command === "qiniu_sync_library") return Promise.resolve(summary());
      return Promise.resolve(undefined);
    });

    await expect(syncLibrary(
      { accessKey: "ak", bucket: "bucket", region: "", privateDomain: "domain", prefix: "lumora/v1", configured: true },
      initial
    )).rejects.toThrow("403 signature mismatch");
    expect(invokeMock.mock.calls.some(([command]) => command === "qiniu_sync_library")).toBe(false);
  });
});
