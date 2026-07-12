import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileAsset, LibraryState, Paper } from "@lumora/shared";

const invokeMock = vi.fn();
const getFileBytesMock = vi.fn();
const deleteFileBlobMock = vi.fn();
const persistEntitiesMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("./localStore", () => ({
  getFileBytes: (...args: unknown[]) => getFileBytesMock(...args),
  deleteFileBlob: (...args: unknown[]) => deleteFileBlobMock(...args),
  putFileBlob: vi.fn(),
  importPdfFile: vi.fn()
}));
vi.mock("./libraryDb", () => ({ persistEntities: (...args: unknown[]) => persistEntitiesMock(...args) }));

import { buildPdfFileName, defaultNameTemplate, fileNameMatchesTarget, reconcileFileStorage } from "./fileStorage";

const now = "2026-07-10T00:00:00.000Z";

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: "paper-a",
    title: "Attention Is All You Need",
    authors: [{ fullName: "Ashish Vaswani", firstName: "Ashish", lastName: "Vaswani" }],
    year: 2017,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("buildPdfFileName", () => {
  it("fills the default template from paper metadata", () => {
    expect(buildPdfFileName(paper(), defaultNameTemplate)).toBe("Attention Is All You Need-2017-Vaswani.pdf");
  });

  it("falls back to the author's full name when lastName is missing", () => {
    const result = buildPdfFileName(paper({ authors: [{ fullName: "Ashish Vaswani" }] }), "{author}");
    expect(result).toBe("Ashish Vaswani.pdf");
  });

  it("collapses separators left by missing fields", () => {
    const result = buildPdfFileName(paper({ year: undefined, authors: [] }), defaultNameTemplate);
    expect(result).toBe("Attention Is All You Need.pdf");
  });

  it("strips illegal filesystem characters", () => {
    const result = buildPdfFileName(paper({ title: 'GAN: A "New" Approach? <v2>' }), "{title}");
    expect(result).toBe("GAN A New Approach v2.pdf");
  });

  it("keeps CJK characters intact", () => {
    const result = buildPdfFileName(paper({ title: "注意力就是一切", authors: [{ fullName: "王小明" }], year: 2020 }), defaultNameTemplate);
    expect(result).toBe("注意力就是一切-2020-王小明.pdf");
  });

  it("caps very long names and still appends .pdf", () => {
    const result = buildPdfFileName(paper({ title: "A".repeat(300) }), "{title}");
    expect(result.length).toBeLessThanOrEqual(124);
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("falls back to a stable name when the template resolves to nothing", () => {
    const result = buildPdfFileName(paper({ title: "???", year: undefined, authors: [] }), "{year}");
    expect(result).toBe("paper.pdf");
  });
});

describe("fileNameMatchesTarget", () => {
  it("matches exact names and collision-suffixed names", () => {
    expect(fileNameMatchesTarget("a-2017.pdf", "a-2017.pdf")).toBe(true);
    expect(fileNameMatchesTarget("a-2017-2.pdf", "a-2017.pdf")).toBe(true);
    expect(fileNameMatchesTarget("a-2017-12.pdf", "a-2017.pdf")).toBe(true);
  });

  it("rejects different names", () => {
    expect(fileNameMatchesTarget("b-2017.pdf", "a-2017.pdf")).toBe(false);
    expect(fileNameMatchesTarget("a-2018.pdf", "a-2017.pdf")).toBe(false);
  });
});

describe("reconcileFileStorage", () => {
  const settings = { directory: "/library", nameTemplate: defaultNameTemplate };

  function fileAsset(overrides: Partial<FileAsset> = {}): FileAsset {
    return {
      id: "file-a",
      paperId: "paper-a",
      sha256: "sha",
      size: 10,
      mime: "application/pdf",
      fileName: "Attention Is All You Need-2017-Vaswani.pdf",
      createdAt: now,
      updatedAt: now,
      ...overrides
    };
  }

  function library(fileAssets: FileAsset[], papers: Paper[] = [paper()]): LibraryState {
    return { papers, fileAssets, collections: [], paperCollections: [], annotations: [] };
  }

  function withDisk(names: string[]) {
    invokeMock.mockImplementation((command: string, args: { fileName?: string }) => {
      if (command === "list_stored_pdfs") return Promise.resolve(names);
      if (command === "store_pdf") return Promise.resolve(args?.fileName ?? "stored.pdf");
      return Promise.resolve(undefined);
    });
  }

  beforeEach(() => {
    invokeMock.mockReset();
    getFileBytesMock.mockReset().mockResolvedValue(undefined);
    deleteFileBlobMock.mockReset().mockResolvedValue(undefined);
    persistEntitiesMock.mockReset().mockResolvedValue(undefined);
  });

  it("re-links a record whose PDF is on disk but lost its localPath (deepseek case)", async () => {
    withDisk(["Attention Is All You Need-2017-Vaswani.pdf"]);
    const state = library([fileAsset({ localPath: undefined, downloadState: "remote" })]);
    const next = await reconcileFileStorage(state, settings);

    const linked = next.fileAssets[0];
    expect(linked.localPath).toBe("Attention Is All You Need-2017-Vaswani.pdf");
    expect(linked.downloadState).toBe("local");
    expect(persistEntitiesMock).toHaveBeenCalledOnce();
  });

  it("normalizes a record with a non-pdf fileName to the on-disk pdf (RT-2 case)", async () => {
    withDisk(["Attention Is All You Need-2017-Vaswani.pdf"]);
    const state = library([fileAsset({ mime: "application/octet-stream", fileName: "attachment", localPath: undefined, downloadState: "remote" })]);
    const next = await reconcileFileStorage(state, settings);

    expect(next.fileAssets[0].fileName).toBe("Attention Is All You Need-2017-Vaswani.pdf");
    expect(next.fileAssets[0].localPath).toBe("Attention Is All You Need-2017-Vaswani.pdf");
  });

  it("drains a leftover IndexedDB blob to disk and deletes the blob", async () => {
    withDisk([]);
    getFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const state = library([fileAsset({ localPath: undefined, downloadState: "local" })]);
    const next = await reconcileFileStorage(state, settings);

    expect(invokeMock).toHaveBeenCalledWith("store_pdf", expect.anything(), expect.anything());
    expect(deleteFileBlobMock).toHaveBeenCalledWith("file-a");
    // storePdfToDisk returns the name the Rust side actually wrote (mocked here);
    // both localPath and fileName are pinned to it.
    expect(next.fileAssets[0].localPath).toBe("stored.pdf");
    expect(next.fileAssets[0].fileName).toBe("stored.pdf");
  });

  it("clears a stale local flag when the file is gone and no blob remains", async () => {
    withDisk([]);
    const state = library([fileAsset({ localPath: "gone.pdf", downloadState: "local" })]);
    const next = await reconcileFileStorage(state, settings);

    expect(next.fileAssets[0].localPath).toBeUndefined();
    expect(next.fileAssets[0].downloadState).toBe("remote");
  });

  it("never binds the same disk file to two records", async () => {
    withDisk(["Attention Is All You Need-2017-Vaswani.pdf"]);
    const state = library([
      fileAsset({ id: "file-a", localPath: undefined, downloadState: "remote" }),
      fileAsset({ id: "file-b", localPath: undefined, downloadState: "remote" })
    ]);
    const next = await reconcileFileStorage(state, settings);

    const linked = next.fileAssets.filter((item) => item.localPath);
    expect(linked).toHaveLength(1);
  });

  it("returns the same state object when nothing needs reconciling", async () => {
    withDisk(["Attention Is All You Need-2017-Vaswani.pdf"]);
    const state = library([fileAsset({ localPath: "Attention Is All You Need-2017-Vaswani.pdf", downloadState: "local" })]);
    const next = await reconcileFileStorage(state, settings);

    expect(next).toBe(state);
    expect(persistEntitiesMock).not.toHaveBeenCalled();
  });

  it("does nothing without a configured directory", async () => {
    const state = library([fileAsset({ localPath: undefined, downloadState: "remote" })]);
    const next = await reconcileFileStorage(state, { nameTemplate: defaultNameTemplate });

    expect(next).toBe(state);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
