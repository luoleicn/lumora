import { describe, expect, it } from "vitest";
import type { LibraryState, Paper } from "@lumora/shared";
import { diffLibraryStates } from "./libraryDb";

const now = "2026-07-10T00:00:00.000Z";

function paper(id: string): Paper {
  return { id, title: id, authors: [], createdAt: now, updatedAt: now };
}

function state(overrides: Partial<LibraryState> = {}): LibraryState {
  return {
    papers: [paper("paper-a"), paper("paper-b")],
    fileAssets: [],
    collections: [{ id: "collection_inbox", name: "Inbox", sortOrder: 0, createdAt: now, updatedAt: now }],
    paperCollections: [],
    annotations: [],
    ...overrides
  };
}

describe("diffLibraryStates", () => {
  it("returns nothing when every collection keeps its reference", () => {
    const current = state();
    expect(diffLibraryStates(current, current)).toEqual([]);
    expect(diffLibraryStates(current, { ...current })).toEqual([]);
  });

  it("detects a replaced entity while skipping reference-equal siblings", () => {
    const current = state();
    const updated = { ...current.papers[0], title: "Renamed", updatedAt: "2026-07-11T00:00:00.000Z" };
    const next = { ...current, papers: [updated, current.papers[1]] };

    expect(diffLibraryStates(current, next)).toEqual([{ entityType: "paper", entity: updated }]);
  });

  it("detects newly added entities", () => {
    const current = state();
    const added = paper("paper-c");
    const next = { ...current, papers: [added, ...current.papers] };

    expect(diffLibraryStates(current, next)).toEqual([{ entityType: "paper", entity: added }]);
  });

  it("detects soft deletions as changes and covers every entity type", () => {
    const current = state();
    const deletedPaper = { ...current.papers[1], deletedAt: now, updatedAt: now };
    const renamedCollection = { ...current.collections[0], name: "Renamed", updatedAt: now };
    const next = {
      ...current,
      papers: [current.papers[0], deletedPaper],
      collections: [renamedCollection]
    };

    const changes = diffLibraryStates(current, next);
    expect(changes).toHaveLength(2);
    expect(changes).toEqual(
      expect.arrayContaining([
        { entityType: "paper", entity: deletedPaper },
        { entityType: "collection", entity: renamedCollection }
      ])
    );
  });

  it("treats a rebuilt array with identical references as unchanged", () => {
    const current = state();
    const next = { ...current, papers: [...current.papers] };

    expect(diffLibraryStates(current, next)).toEqual([]);
  });
});
