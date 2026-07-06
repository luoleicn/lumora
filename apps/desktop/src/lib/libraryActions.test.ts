import { describe, expect, it } from "vitest";
import type { Collection, LibraryState, Paper } from "@lumora/shared";
import { addPaperToCollection, deleteCollectionAndReassignPapers, getCollectionAndDescendantIds } from "./libraryActions";

const now = "2026-07-06T00:00:00.000Z";

function paper(id: string): Paper {
  return {
    id,
    title: id,
    authors: [],
    createdAt: now,
    updatedAt: now
  };
}

function collection(id: string, parentId?: string): Collection {
  return {
    id,
    name: id,
    parentId,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now
  };
}

function state(): LibraryState {
  return {
    papers: [paper("paper-a"), paper("paper-b"), paper("paper-c")],
    fileAssets: [],
    collections: [
      collection("collection_inbox"),
      collection("folder-parent"),
      collection("folder-child", "folder-parent"),
      collection("folder-grandchild", "folder-child"),
      collection("folder-target")
    ],
    paperCollections: [
      { id: "pc-parent-a", paperId: "paper-a", collectionId: "folder-parent", createdAt: now, updatedAt: now },
      { id: "pc-child-b", paperId: "paper-b", collectionId: "folder-child", createdAt: now, updatedAt: now },
      { id: "pc-child-c", paperId: "paper-c", collectionId: "folder-child", createdAt: now, updatedAt: now },
      { id: "pc-parent-c", paperId: "paper-c", collectionId: "folder-parent", createdAt: now, updatedAt: now }
    ],
    annotations: []
  };
}

describe("library actions", () => {
  it("collects a folder and all descendant folder ids", () => {
    expect([...getCollectionAndDescendantIds(state().collections, "folder-parent")].sort()).toEqual([
      "folder-child",
      "folder-grandchild",
      "folder-parent"
    ]);
  });

  it("adds a paper to a target folder as a copied organization link", () => {
    const next = addPaperToCollection(state(), "paper-a", "folder-target", now);

    expect(next.paperCollections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paperId: "paper-a", collectionId: "folder-parent" }),
        expect.objectContaining({ paperId: "paper-a", collectionId: "folder-target" })
      ])
    );
  });

  it("does not duplicate an existing paper-folder link", () => {
    const current = state();
    const next = addPaperToCollection(current, "paper-a", "folder-parent", now);

    expect(next).toBe(current);
    expect(next.paperCollections.filter((item) => item.paperId === "paper-a" && item.collectionId === "folder-parent")).toHaveLength(1);
  });

  it("ignores drag organization for missing or deleted papers and folders", () => {
    const current = state();

    expect(addPaperToCollection(current, "missing-paper", "folder-target", now)).toBe(current);
    expect(addPaperToCollection(current, "paper-a", "missing-folder", now)).toBe(current);
    const deletedFolderState = { ...current, collections: current.collections.map((item) =>
      item.id === "folder-target" ? { ...item, deletedAt: now } : item
    ) };
    expect(addPaperToCollection(deletedFolderState, "paper-a", "folder-target", now)).toBe(deletedFolderState);
  });

  it("deletes a child folder and moves its papers to the parent folder without duplicates", () => {
    const next = deleteCollectionAndReassignPapers(state(), "folder-child", now);

    expect(next.collections.find((item) => item.id === "folder-child")?.deletedAt).toBe(now);
    expect(next.collections.find((item) => item.id === "folder-grandchild")?.parentId).toBe("folder-parent");
    expect(next.paperCollections.find((item) => item.id === "pc-child-b")).toEqual(
      expect.objectContaining({ paperId: "paper-b", collectionId: "folder-parent" })
    );
    expect(next.paperCollections.find((item) => item.id === "pc-child-b")?.deletedAt).toBeUndefined();
    expect(next.paperCollections.find((item) => item.id === "pc-child-c")?.deletedAt).toBe(now);
  });

  it("deletes a top-level folder and moves its papers to Unsorted", () => {
    const next = deleteCollectionAndReassignPapers(state(), "folder-parent", now);

    expect(next.collections.find((item) => item.id === "folder-parent")?.deletedAt).toBe(now);
    expect(next.collections.find((item) => item.id === "folder-child")?.parentId).toBeUndefined();
    expect(next.paperCollections.find((item) => item.id === "pc-parent-a")?.deletedAt).toBe(now);
  });

  it("does not delete the system inbox folder", () => {
    const current = state();
    const next = deleteCollectionAndReassignPapers(current, "collection_inbox", now);

    expect(next).toBe(current);
  });
});
