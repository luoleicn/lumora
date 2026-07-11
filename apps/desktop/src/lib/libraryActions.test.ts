import { describe, expect, it } from "vitest";
import type { Collection, LibraryState, Paper } from "@lumora/shared";
import {
  addPaperToCollection,
  deleteCollectionAndReassignPapers,
  deletePaperFromLibrary,
  getActivePaperCollectionIds,
  getCollectionAndDescendantIds,
  getCollectionPaperCount,
  removePaperFromCollectionTree,
  permanentlyDeletePaperFromTrash,
  renameCollection,
  restorePaperFromTrash,
  sortCollectionsAlphabetically
} from "./libraryActions";

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
      { id: "pc-parent-c", paperId: "paper-c", collectionId: "folder-parent", createdAt: now, updatedAt: now },
      { id: "pc-grandchild-a", paperId: "paper-a", collectionId: "folder-grandchild", createdAt: now, updatedAt: now },
      { id: "pc-target-a", paperId: "paper-a", collectionId: "folder-target", createdAt: now, updatedAt: now }
    ],
    annotations: []
  };
}

describe("library actions", () => {
  it("returns every active folder assigned to the selected paper and all of their ancestors", () => {
    const current = state();
    current.paperCollections.find((item) => item.id === "pc-parent-a")!.deletedAt = now;
    current.paperCollections.find((item) => item.id === "pc-target-a")!.deletedAt = now;

    expect([...getActivePaperCollectionIds(current, "paper-a")].sort()).toEqual([
      "folder-child",
      "folder-grandchild",
      "folder-parent"
    ]);
    expect(getActivePaperCollectionIds(current)).toEqual(new Set());
  });

  it("sorts folders alphabetically with case-insensitive numeric ordering", () => {
    const folders = [collection("zeta"), collection("Folder 10"), collection("alpha"), collection("Folder 2")]
      .map((item) => ({ ...item, name: item.id }));

    expect(sortCollectionsAlphabetically(folders).map((item) => item.name)).toEqual([
      "alpha", "Folder 2", "Folder 10", "zeta"
    ]);
  });

  it("permanently removes only a paper that is already in trash and its dependents", () => {
    const trashed = deletePaperFromLibrary(state(), "paper-a", now);
    const next = permanentlyDeletePaperFromTrash(trashed, "paper-a");

    expect(next.papers.find((paper) => paper.id === "paper-a")).toBeUndefined();
    expect(next.fileAssets.some((file) => file.paperId === "paper-a")).toBe(false);
    expect(next.annotations.some((annotation) => annotation.paperId === "paper-a")).toBe(false);
    expect(next.paperCollections.some((membership) => membership.paperId === "paper-a")).toBe(false);
    const active = state();
    expect(permanentlyDeletePaperFromTrash(active, "paper-a")).toBe(active);
  });
  it("collects a folder and all descendant folder ids", () => {
    expect([...getCollectionAndDescendantIds(state().collections, "folder-parent")].sort()).toEqual([
      "folder-child",
      "folder-grandchild",
      "folder-parent"
    ]);
  });

  it("counts unique active papers across a folder and descendant folders", () => {
    const current = state();

    expect(getCollectionPaperCount(current, current.collections, "folder-parent")).toBe(3);
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

  it("renames a folder and stamps updatedAt", () => {
    const next = renameCollection(state(), "folder-parent", "  Reading List  ", now);

    expect(next.collections.find((item) => item.id === "folder-parent")).toEqual(
      expect.objectContaining({ name: "Reading List", updatedAt: now })
    );
  });

  it("renames the system inbox folder since consumers key on its id", () => {
    const next = renameCollection(state(), "collection_inbox", "My Inbox", now);

    expect(next.collections.find((item) => item.id === "collection_inbox")).toEqual(
      expect.objectContaining({ name: "My Inbox", updatedAt: now })
    );
  });

  it("ignores renames for missing, deleted, empty-name, and unchanged folders", () => {
    const current = state();

    expect(renameCollection(current, "missing-folder", "New Name", now)).toBe(current);
    expect(renameCollection(current, "folder-parent", "   ", now)).toBe(current);
    expect(renameCollection(current, "folder-parent", "folder-parent", now)).toBe(current);
    const deletedFolderState = { ...current, collections: current.collections.map((item) =>
      item.id === "folder-target" ? { ...item, deletedAt: now } : item
    ) };
    expect(renameCollection(deletedFolderState, "folder-target", "New Name", now)).toBe(deletedFolderState);
  });

  it("does not delete the system inbox folder", () => {
    const current = state();
    const next = deleteCollectionAndReassignPapers(current, "collection_inbox", now);

    expect(next).toBe(current);
  });

  it("soft deletes a paper and its dependent library records", () => {
    const current: LibraryState = {
      ...state(),
      fileAssets: [{
        id: "file-a",
        paperId: "paper-a",
        sha256: "hash",
        size: 10,
        mime: "application/pdf",
        fileName: "paper-a.pdf",
        downloadState: "local",
        createdAt: now,
        updatedAt: now
      }],
      annotations: [{
        id: "annotation-a",
        paperId: "paper-a",
        fileId: "file-a",
        pageIndex: 0,
        kind: "highlight",
        color: "#f5c542",
        rects: [],
        createdAt: now,
        updatedAt: now
      }]
    };

    const next = deletePaperFromLibrary(current, "paper-a", now);

    expect(next.papers.find((item) => item.id === "paper-a")?.deletedAt).toBe(now);
    expect(next.fileAssets.find((item) => item.id === "file-a")?.deletedAt).toBe(now);
    expect(next.annotations.find((item) => item.id === "annotation-a")?.deletedAt).toBe(now);
    expect(next.paperCollections.find((item) => item.id === "pc-parent-a")?.deletedAt).toBe(now);
  });

  it("restores a trashed paper and its file/annotations, leaving folder links deleted so it lands in Unsorted", () => {
    const trashedNow = "2026-07-09T00:00:00.000Z";
    const withFile: LibraryState = {
      ...state(),
      fileAssets: [{
        id: "file-a",
        paperId: "paper-a",
        sha256: "hash",
        size: 10,
        mime: "application/pdf",
        fileName: "paper-a.pdf",
        downloadState: "local",
        createdAt: trashedNow,
        updatedAt: trashedNow
      }]
    };
    const trashed = deletePaperFromLibrary(withFile, "paper-a", trashedNow);

    const restored = restorePaperFromTrash(trashed, "paper-a", now);

    expect(restored.papers.find((item) => item.id === "paper-a")?.deletedAt).toBeUndefined();
    expect(restored.fileAssets.find((item) => item.id === "file-a")?.deletedAt).toBeUndefined();
    expect(restored.papers.find((item) => item.id === "paper-a")?.updatedAt).toBe(now);
    expect(restored.paperCollections.find((item) => item.id === "pc-parent-a")?.deletedAt).toBe(trashedNow);
    expect(restored.paperCollections.find((item) => item.id === "pc-target-a")?.deletedAt).toBe(trashedNow);
  });

  it("ignores restoring a paper that is missing or not currently trashed", () => {
    const current = state();

    expect(restorePaperFromTrash(current, "missing-paper", now)).toBe(current);
    expect(restorePaperFromTrash(current, "paper-a", now)).toBe(current);
  });

  it("moves a paper to the parent folder when removed from a child folder", () => {
    const next = removePaperFromCollectionTree(state(), "paper-b", "folder-child", now);

    expect(next.paperCollections.find((item) => item.id === "pc-child-b")).toEqual(
      expect.objectContaining({ paperId: "paper-b", collectionId: "folder-parent", updatedAt: now })
    );
    expect(next.paperCollections.find((item) => item.id === "pc-child-b")?.deletedAt).toBeUndefined();
  });

  it("removes duplicate child links when the paper already belongs to the parent folder", () => {
    const next = removePaperFromCollectionTree(state(), "paper-c", "folder-child", now);

    expect(next.paperCollections.find((item) => item.id === "pc-child-c")?.deletedAt).toBe(now);
    expect(next.paperCollections.find((item) => item.id === "pc-parent-c")?.deletedAt).toBeUndefined();
  });

  it("removes a paper from a top-level folder and its descendants so it can become unsorted", () => {
    const next = removePaperFromCollectionTree(state(), "paper-a", "folder-parent", now);

    expect(next.paperCollections.find((item) => item.id === "pc-parent-a")?.deletedAt).toBe(now);
    expect(next.paperCollections.find((item) => item.id === "pc-grandchild-a")?.deletedAt).toBe(now);
    expect(next.paperCollections.find((item) => item.id === "pc-target-a")?.deletedAt).toBeUndefined();
  });
});
