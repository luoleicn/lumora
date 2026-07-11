import { describe, expect, it } from "vitest";
import type { LibraryState } from "@lumora/shared";
import { findDuplicateDocuments, getPaperFolderPaths } from "./duplicateDocuments";

const now = "2026-07-11T00:00:00.000Z";
const state: LibraryState = {
  papers: ["a", "b", "c"].map((id) => ({ id, title: `Paper ${id}`, authors: [], createdAt: now, updatedAt: now })),
  collections: [
    { id: "parent", name: "Research", sortOrder: 0, createdAt: now, updatedAt: now },
    { id: "child", name: "Vision", parentId: "parent", sortOrder: 0, createdAt: now, updatedAt: now }
  ],
  paperCollections: [
    { id: "pa", paperId: "a", collectionId: "child", createdAt: now, updatedAt: now },
    { id: "pb", paperId: "b", collectionId: "parent", createdAt: now, updatedAt: now }
  ],
  fileAssets: [
    { id: "fa", paperId: "a", sha256: "ABC", size: 10, mime: "application/pdf", fileName: "a.pdf", downloadState: "local", createdAt: now, updatedAt: now },
    { id: "fb", paperId: "b", sha256: "abc", size: 10, mime: "application/pdf", fileName: "b.pdf", downloadState: "local", createdAt: now, updatedAt: now },
    { id: "fc", paperId: "c", sha256: "unique", size: 10, mime: "application/pdf", fileName: "c.pdf", downloadState: "local", createdAt: now, updatedAt: now }
  ],
  annotations: []
};

describe("duplicate documents", () => {
  it("groups distinct documents with the same normalized PDF hash", () => {
    const groups = findDuplicateDocuments(state);
    expect(groups).toHaveLength(1);
    expect(groups[0].hash).toBe("abc");
    expect(groups[0].documents.map((item) => item.paper.id)).toEqual(["a", "b"]);
  });

  it("shows direct folders as complete ancestor paths", () => {
    expect(getPaperFolderPaths(state, "a")).toEqual(["Research / Vision"]);
    expect(getPaperFolderPaths(state, "c")).toEqual([]);
  });
});
