import { describe, expect, it } from "vitest";
import type { Annotation, Collection, FileAsset, LibraryState, Paper, PaperCollection } from "@lumora/shared";
import {
  getLibraryIndexes, getFileIndex, getCollectionPaperCounts, getSidebarCounts,
  selectDetailsFile, selectReaderFile
} from "./libraryIndexes";
import { planBodyBackfill } from "./searchIndex";

const now = "2026-10-01T00:00:00Z";
function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return { id, title: id, authors: [{ fullName: "Author" }], createdAt: now, updatedAt: now, ...overrides };
}
function file(id: string, paperId: string, overrides: Partial<FileAsset> = {}): FileAsset {
  return { id, paperId, mime: "application/pdf", fileName: `${id}.pdf`, sha256: id, size: 10, downloadState: "local", createdAt: now, updatedAt: now, ...overrides };
}
function membership(id: string, paperId: string, collectionId: string, overrides: Partial<PaperCollection> = {}): PaperCollection {
  return { id, paperId, collectionId, createdAt: now, updatedAt: now, ...overrides };
}
function collection(id: string, overrides: Partial<Collection> = {}): Collection {
  return { id, name: id, sortOrder: 0, createdAt: now, updatedAt: now, ...overrides };
}
function state(overrides: Partial<LibraryState> = {}): LibraryState {
  return { papers: [paper("a"), paper("b")], fileAssets: [], collections: [], paperCollections: [], annotations: [], ...overrides };
}

describe("library indexes", () => {
  it("invalidates only indexes whose immutable source array changed", () => {
    const current = state({ fileAssets: [file("f", "a")] });
    const first = getLibraryIndexes(current);
    expect(getLibraryIndexes({ ...current }).papers).toBe(first.papers);
    const annotation: Annotation = { id: "n", paperId: "a", fileId: "f", pageIndex: 0, kind: "note", color: "yellow", rects: [], createdAt: now, updatedAt: now };
    const next = getLibraryIndexes({ ...current, annotations: [annotation] });
    expect(next.annotations).not.toBe(first.annotations);
    expect(next.papers).toBe(first.papers);
    expect(next.files).toBe(first.files);
    expect(next.memberships).toBe(first.memberships);
    expect(next.annotations.get("a")).toEqual([annotation]);
    const edited = { ...current, papers: [paper("a", { title: "New title" }), current.papers[1]] };
    expect(getLibraryIndexes(edited).papers).not.toBe(first.papers);
    expect(getLibraryIndexes(edited).files).toBe(first.files);
    expect(getLibraryIndexes(edited).papers.activeById.get("a")?.title).toBe("New title");
  });

  it("preserves attachment order, reader path priority and the details fallback", () => {
    const remote = file("remote", "a", { downloadState: "remote" });
    const deleted = file("deleted", "a", { deletedAt: now });
    const pathOnly = file("path", "a", { mime: "application/octet-stream", fileName: "attachment", localPath: "paper.pdf", downloadState: "remote" });
    const local = file("local", "a");
    const files = [remote, deleted, pathOnly, local];
    expect(getFileIndex(files).byPaperId.get("a")).toEqual(files);
    expect(selectReaderFile(files)).toBe(pathOnly);
    expect(selectDetailsFile(files)).toBe(pathOnly);
    const nonPdf = file("doc", "b", { mime: "text/plain", fileName: "note.txt", downloadState: "remote" });
    expect(selectReaderFile([nonPdf])).toBeUndefined();
    expect(selectDetailsFile([nonPdf])).toBe(nonPdf);
    expect(selectReaderFile([deleted, remote])).toBe(remote);
  });

  it("retains the stricter sidebar/backfill local-PDF policy", () => {
    const pathOnly = file("path", "a", { mime: "application/octet-stream", fileName: "attachment", localPath: "a.pdf", downloadState: "remote" });
    const current = state({ fileAssets: [pathOnly, file("b", "b", { mime: "application/octet-stream", fileName: "B.PDF" })] });
    expect(getLibraryIndexes(current).files.readerLocalPaperIds.has("a")).toBe(true);
    expect(getSidebarCounts(current).noPdfCount).toBe(1);
    expect(planBodyBackfill(current, []).map((item) => item.paperId)).toEqual(["b"]);
  });

  it("counts memberships and local PDFs exactly like the previous nested scans", () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const current = state({
        papers: Array.from({ length: 30 }, (_, index) => paper(String(index), { deletedAt: (index + seed) % 11 === 0 ? now : undefined })),
        fileAssets: Array.from({ length: 70 }, (_, index) => file(String(index), String((index * 7 + seed) % 30), {
          deletedAt: index % 17 === 0 ? now : undefined, downloadState: index % 4 === 0 ? "remote" : "local",
          mime: index % 3 === 0 ? "text/plain" : "application/pdf", fileName: index % 3 === 0 ? "x.txt" : "x.pdf"
        })),
        paperCollections: Array.from({ length: 50 }, (_, index) => membership(String(index), String((index * 3 + seed) % 30), "c", { deletedAt: index % 7 === 0 ? now : undefined }))
      });
      const active = current.papers.filter((item) => !item.deletedAt);
      expect(getSidebarCounts(current)).toEqual({
        unfiledPaperCount: active.filter((p) => !current.paperCollections.some((m) => m.paperId === p.id && !m.deletedAt)).length,
        noPdfCount: active.filter((p) => !current.fileAssets.some((f) => f.paperId === p.id && !f.deletedAt && (f.mime === "application/pdf" || /\.pdf$/i.test(f.fileName)) && f.downloadState === "local")).length
      });
    }
  });

  it("deduplicates subtree memberships and excludes deleted papers/collections", () => {
    const current = state({
      papers: [paper("a"), paper("b"), paper("gone", { deletedAt: now })],
      collections: [collection("root"), collection("child", { parentId: "root" }), collection("gone", { parentId: "root", deletedAt: now })],
      paperCollections: [membership("1", "a", "root"), membership("2", "a", "child"), membership("3", "b", "child"), membership("4", "gone", "child"), membership("5", "b", "root", { deletedAt: now })]
    });
    expect(getCollectionPaperCounts(current)).toEqual({ root: 2, child: 2 });
    expect(getSidebarCounts(current).unfiledPaperCount).toBe(0);
    const cycle = { ...current, collections: [collection("root", { parentId: "child" }), collection("child", { parentId: "root" })] };
    expect(getCollectionPaperCounts(cycle)).toEqual({ root: 2, child: 2 });
  });

  it("keeps first qualifying attachment semantics, including an empty SHA", () => {
    const first = file("first", "a", { sha256: "" });
    const second = file("second", "a");
    const current = state({ fileAssets: [file("deleted", "a", { deletedAt: now }), first, second, file("b", "b")] });
    expect(planBodyBackfill(current, []).map((item) => item.paperId)).toEqual(["b"]);
    const changed = { ...current, fileAssets: [second, file("b", "b")] };
    expect(planBodyBackfill(changed, [{ paperId: "a", bodySha: second.sha256 }]).map((item) => item.paperId)).toEqual(["b"]);
    expect(planBodyBackfill(changed, []).map((item) => item.fileAsset.id)).toEqual(["second", "b"]);
  });
});
