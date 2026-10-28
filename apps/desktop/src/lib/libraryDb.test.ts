import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryState, Paper } from "@lumora/shared";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import {
  deletePersistedEntities,
  diffLibraryStates,
  diffLibraryStateValues,
  enqueueLibraryPersist,
  flushLibraryPersist,
  loadAnnotationsFromDb,
  loadLibraryFromDb,
  mergeLibraryReload,
  persistLibraryStateSnapshot
} from "./libraryDb";

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

describe("diffLibraryStateValues", () => {
  it("ignores entities rebuilt from SQLite with equal values", () => {
    const persisted = state();
    const inMemory = JSON.parse(JSON.stringify(persisted)) as LibraryState;
    inMemory.papers[0] = {
      updatedAt: inMemory.papers[0].updatedAt,
      createdAt: inMemory.papers[0].createdAt,
      authors: inMemory.papers[0].authors,
      title: inMemory.papers[0].title,
      id: inMemory.papers[0].id,
      deletedAt: undefined
    };

    expect(diffLibraryStateValues(persisted, inMemory)).toEqual([]);
  });

  it("repairs a DB membership that is active while the UI shows it removed", () => {
    const oldMembership = {
      id: "membership-unread",
      paperId: "paper-a",
      collectionId: "collection-unread",
      createdAt: now,
      updatedAt: now
    };
    const newMembership = {
      id: "membership-manipulation",
      paperId: "paper-a",
      collectionId: "collection-manipulation",
      createdAt: now,
      updatedAt: now
    };
    const persisted = state({ paperCollections: [oldMembership] });
    const removedMembership = { ...oldMembership, deletedAt: now };
    const inMemory = state({ paperCollections: [removedMembership, newMembership] });

    expect(diffLibraryStateValues(persisted, inMemory)).toEqual([
      { entityType: "paperCollection", entity: removedMembership },
      { entityType: "paperCollection", entity: newMembership }
    ]);
  });
});

describe("scoped database snapshots", () => {
  beforeEach(() => invokeMock.mockReset());

  it("passes annotation scopes and respects database emptiness independently of returned rows", async () => {
    invokeMock.mockResolvedValue({ entities: [], meta: {}, empty: false });
    const loaded = await loadLibraryFromDb({ annotationPaperIds: [] });
    expect(invokeMock).toHaveBeenCalledWith("db_load_library", { annotationPaperIds: [] });
    expect(loaded.empty).toBe(false);
    expect(loaded.state.annotations).toEqual([]);
  });

  it("retains all annotation fields and tombstones in a paper load", async () => {
    const annotation = { id: "a1", paperId: "paper-a", deletedAt: now, commentContent: { type: "doc" } };
    invokeMock.mockResolvedValue([JSON.stringify(annotation)]);
    expect(await loadAnnotationsFromDb("paper-a")).toEqual([annotation]);
    expect(invokeMock).toHaveBeenCalledWith("db_load_annotations", { paperId: "paper-a" });
  });

  it("checks sync integrity without loading or writing annotations outside the UI cache", async () => {
    const current = state();
    invokeMock.mockResolvedValue({
      entities: [
        ...current.papers.map((entity) => ({ entityType: "paper", data: JSON.stringify(entity) })),
        ...current.collections.map((entity) => ({ entityType: "collection", data: JSON.stringify(entity) }))
      ],
      meta: {}, empty: false
    });
    await persistLibraryStateSnapshot(current);
    expect(invokeMock).toHaveBeenCalledWith("db_load_library", { annotationPaperIds: [] });
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["db_load_library"]);
  });
});

describe("mergeLibraryReload", () => {
  it("preserves concurrent edits and removals while adopting unrelated database changes", () => {
    const base = state();
    const current = { ...base, papers: [{ ...base.papers[0], title: "Local" }] };
    const remote = { ...base, papers: [...base.papers, paper("remote")] };
    expect(mergeLibraryReload(base, remote, current).papers.map((item) => [item.id, item.title])).toEqual([
      ["paper-a", "Local"], ["remote", "remote"]
    ]);
  });
});

type UpsertPayload = { changes: Array<{ id: string; data: string }> };

describe("enqueueLibraryPersist debouncing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await flushLibraryPersist();
    vi.useRealTimers();
  });

  it("coalesces a chained burst of states into a single upsert", async () => {
    const base = state();
    const step1 = { ...base, papers: [{ ...base.papers[0], title: "ab" }, base.papers[1]] };
    const step2 = { ...step1, papers: [{ ...step1.papers[0], title: "abc" }, step1.papers[1]] };

    enqueueLibraryPersist(base, step1);
    enqueueLibraryPersist(step1, step2);
    await vi.advanceTimersByTimeAsync(250);
    await flushLibraryPersist();

    const upserts = invokeMock.mock.calls.filter(([command]) => command === "db_upsert_entities");
    expect(upserts).toHaveLength(1);
    const payload = upserts[0][1] as UpsertPayload;
    expect(payload.changes).toHaveLength(1);
    expect(JSON.parse(payload.changes[0].data).title).toBe("abc");
  });

  it("does not write before the debounce window elapses", async () => {
    const base = state();
    const edited = { ...base, papers: [{ ...base.papers[0], title: "edited" }, base.papers[1]] };

    enqueueLibraryPersist(base, edited);
    await vi.advanceTimersByTimeAsync(200);
    expect(invokeMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    await flushLibraryPersist();
    expect(invokeMock.mock.calls.filter(([command]) => command === "db_upsert_entities")).toHaveLength(1);
  });

  it("flushes the pending write before a state that does not chain onto it", async () => {
    const base = state();
    const edited = { ...base, papers: [{ ...base.papers[0], title: "edited" }, base.papers[1]] };
    // A cloud sync adopts a fresh baseline: same papers, new object identities.
    const syncBaseline = state();
    const afterSync = { ...syncBaseline, papers: [{ ...syncBaseline.papers[0], title: "from-sync" }, syncBaseline.papers[1]] };

    enqueueLibraryPersist(base, edited);
    enqueueLibraryPersist(syncBaseline, afterSync);
    await vi.advanceTimersByTimeAsync(250);
    await flushLibraryPersist();

    const upserts = invokeMock.mock.calls.filter(([command]) => command === "db_upsert_entities");
    expect(upserts).toHaveLength(2);
    expect(JSON.parse((upserts[0][1] as UpsertPayload).changes[0].data).title).toBe("edited");
    expect(JSON.parse((upserts[1][1] as UpsertPayload).changes[0].data).title).toBe("from-sync");
  });

  it("orders a pending upsert before a permanent delete", async () => {
    const base = state();
    const edited = { ...base, papers: [{ ...base.papers[0], title: "edited" }, base.papers[1]] };
    enqueueLibraryPersist(base, edited);

    await deletePersistedEntities([{ entityType: "paper", id: "paper-a" }]);

    const commands = invokeMock.mock.calls.map(([command]) => command);
    expect(commands).toEqual(["db_upsert_entities", "db_delete_entities"]);
  });
});
