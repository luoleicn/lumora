// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation, LibraryState } from "@lumora/shared";
import { useLibraryStore, type LibraryStore } from "./useLibraryStore";
import {
  diffLibraryStates, enqueueLibraryPersist, flushLibraryPersist, importStateToDb,
  loadAnnotationsFromDb, loadLibraryFromDb
} from "../lib/libraryDb";
import { createDefaultState, loadLibraryState, saveLibraryState } from "../lib/localStore";
import { mergeBackgroundSyncState } from "../lib/mendeleyClient";

vi.mock("../lib/libraryDb", async (original) => ({
  ...await original<typeof import("../lib/libraryDb")>(),
  enqueueLibraryPersist: vi.fn().mockResolvedValue(undefined),
  flushLibraryPersist: vi.fn().mockResolvedValue(undefined),
  importStateToDb: vi.fn().mockResolvedValue(undefined),
  loadLibraryFromDb: vi.fn(),
  loadAnnotationsFromDb: vi.fn()
}));
vi.mock("../lib/localStore", async (original) => ({
  ...await original<typeof import("../lib/localStore")>(),
  loadLibraryState: vi.fn(), saveLibraryState: vi.fn()
}));

const now = "2026-10-28T00:00:00.000Z";
const note = (id: string, paperId = "p1"): Annotation => ({
  id, paperId, fileId: `file-${paperId}`, kind: "highlight", pageIndex: 0,
  color: "#ffee58", rects: [], quote: id, createdAt: now, updatedAt: now
});
function state(): LibraryState {
  return { ...createDefaultState(), papers: ["p1", "p2"].map((id) => ({ id, title: id, authors: [], createdAt: now, updatedAt: now })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("on-demand library annotations", () => {
  let host: HTMLDivElement;
  let root: Root;
  let store: LibraryStore;
  const onError = vi.fn();
  let reconcile: ((library: LibraryState) => Promise<LibraryState>) | undefined;
  const load = vi.mocked(loadLibraryFromDb);
  const loadNotes = vi.mocked(loadAnnotationsFromDb);
  function Harness() { store = useLibraryStore({ onError, reconcile }); return null; }
  async function mount() { await act(async () => { root.render(<Harness />); }); }
  function writtenChanges() {
    return vi.mocked(enqueueLibraryPersist).mock.calls.flatMap(([before, after]) => diffLibraryStates(before, after));
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    load.mockReset().mockImplementation(async () => ({ state: state(), empty: false }));
    loadNotes.mockReset().mockResolvedValue([]);
    vi.mocked(loadLibraryState).mockReturnValue(state());
    reconcile = undefined;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("starts with metadata only without parsing legacy storage or fetching annotations", async () => {
    await mount();
    expect(load).toHaveBeenCalledWith({ annotationPaperIds: [] });
    expect(loadLibraryState).not.toHaveBeenCalled();
    expect(loadNotes).not.toHaveBeenCalled();
    expect(store.loaded).toBe(true);
    expect(store.library.annotations).toEqual([]);
    expect(store.getAnnotationPaperIds()).toEqual([]);
    expect(writtenChanges()).toEqual([]);
  });

  it("keeps metadata-only startup safe under StrictMode", async () => {
    await act(async () => { root.render(<StrictMode><Harness /></StrictMode>); });
    expect(store.loaded).toBe(true);
    expect(store.library.papers).toHaveLength(2);
    expect(load.mock.calls.every(([options]) => options?.annotationPaperIds?.length === 0)).toBe(true);
    expect(loadNotes).not.toHaveBeenCalled();
    expect(writtenChanges()).toEqual([]);
  });

  it("loads notes during disk reconciliation and preserves them when reconciliation finishes", async () => {
    const query = deferred<LibraryState>(); reconcile = () => query.promise;
    await mount();
    loadNotes.mockResolvedValueOnce([note("a1")]);
    await act(async () => { await store.ensureAnnotationsLoaded("p1"); });
    act(() => store.setLibrary((current) => ({ ...current, papers: current.papers.map((paper) => paper.id === "p1" ? { ...paper, title: "Edited" } : paper) })));
    await act(async () => { query.resolve(state()); });
    expect(store.library.annotations).toEqual([note("a1")]);
    expect(store.library.papers[0].title).toBe("Edited");
    expect(loadLibraryState).not.toHaveBeenCalled();
  });

  it("deduplicates paper requests and caches empty papers without marking hydration dirty", async () => {
    await mount();
    loadNotes.mockResolvedValueOnce([note("a1")]);
    await act(async () => { await Promise.all([store.ensureAnnotationsLoaded("p1"), store.ensureAnnotationsLoaded("p1")]); });
    expect(loadNotes).toHaveBeenCalledTimes(1);
    expect(loadNotes).toHaveBeenCalledWith("p1");
    expect(store.library.annotations).toEqual([note("a1")]);
    expect(store.areAnnotationsLoaded("p1")).toBe(true);
    expect(store.areAnnotationsLoaded("p2")).toBe(false);
    expect(writtenChanges()).toEqual([]);
    await act(async () => { await store.ensureAnnotationsLoaded("p2"); await store.ensureAnnotationsLoaded("p2"); });
    expect(loadNotes).toHaveBeenCalledTimes(2);
    expect(store.areAnnotationsLoaded("p2")).toBe(true);
  });

  it("preserves edits and tombstones made while a paper query is in flight", async () => {
    await mount();
    const query = deferred<Annotation[]>(); loadNotes.mockReturnValueOnce(query.promise);
    let pending!: Promise<LibraryState>;
    act(() => { pending = store.ensureAnnotationsLoaded("p1"); });
    await act(async () => { await Promise.resolve(); });
    const deleted = { ...note("a1"), deletedAt: now };
    const added = { ...note("new"), comment: "Unsaved local note" };
    act(() => store.setLibrary((current) => ({
      ...current, annotations: [deleted, added],
      papers: current.papers.map((paper) => paper.id === "p2" ? { ...paper, title: "Edited" } : paper)
    })));
    await act(async () => { query.resolve([note("a1"), note("a2")]); await pending; });
    expect(store.library.annotations).toEqual([deleted, added, note("a2")]);
    expect(store.library.papers[1].title).toBe("Edited");
    expect(writtenChanges().filter((change) => change.entity.id === "a2")).toEqual([]);
    expect(writtenChanges()).toEqual(expect.arrayContaining([
      { entityType: "annotation", entity: deleted }, { entityType: "annotation", entity: added }
    ]));
  });

  it("requests the full cache only for an explicit global consumer", async () => {
    await mount();
    loadNotes.mockResolvedValueOnce([note("a1")]);
    await act(async () => { await store.ensureAnnotationsLoaded("p1"); });
    loadNotes.mockResolvedValueOnce([note("a1"), note("a2", "p2")]);
    let complete!: LibraryState;
    await act(async () => { complete = await store.ensureAnnotationsLoaded(); });
    expect(complete.annotations).toHaveLength(2);
    expect(loadNotes).toHaveBeenLastCalledWith(undefined);
    expect(store.getAnnotationPaperIds()).toBeUndefined();
    await act(async () => { await store.ensureAnnotationsLoaded("p2"); });
    expect(loadNotes).toHaveBeenCalledTimes(2);
    expect(writtenChanges()).toEqual([]);
  });

  it("refreshes only hydrated papers, including remote edits and deleted rows", async () => {
    await mount(); loadNotes.mockResolvedValueOnce([note("a1")]);
    await act(async () => { await store.ensureAnnotationsLoaded("p1"); });
    const remote = { ...note("a1"), deletedAt: now };
    load.mockResolvedValueOnce({ state: { ...state(), annotations: [remote] }, empty: false });
    await act(async () => { await store.adoptFromDb(); });
    expect(load).toHaveBeenLastCalledWith({ annotationPaperIds: ["p1"] });
    expect(flushLibraryPersist).toHaveBeenCalled();
    expect(store.library.annotations).toEqual([remote]);
    expect(writtenChanges()).toEqual([]);
  });

  it("discards annotation responses from before a database refresh", async () => {
    await mount(); const old = deferred<Annotation[]>(); loadNotes.mockReturnValueOnce(old.promise);
    let pending!: Promise<LibraryState>;
    act(() => { pending = store.ensureAnnotationsLoaded("p1"); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await store.adoptFromDb(); });
    loadNotes.mockResolvedValueOnce([note("fresh")]);
    await act(async () => { old.resolve([note("stale")]); await pending; });
    expect(store.library.annotations).toEqual([note("fresh")]);
    expect(loadNotes).toHaveBeenCalledTimes(2);
    expect(writtenChanges()).toEqual([]);
  });

  it("preserves edits made while a metadata reload is in flight", async () => {
    await mount();
    const query = deferred<{ state: LibraryState; empty: boolean }>();
    load.mockReturnValueOnce(query.promise);
    let pending!: Promise<boolean>;
    act(() => { pending = store.adoptFromDb(); });
    await act(async () => { await Promise.resolve(); });
    act(() => store.setLibrary((current) => ({ ...current, papers: current.papers.map((paper) => paper.id === "p1" ? { ...paper, title: "Local" } : paper) })));
    const remote = state(); remote.papers[1] = { ...remote.papers[1], title: "Remote" };
    await act(async () => { query.resolve({ state: remote, empty: false }); await pending; });
    expect(store.library.papers.map((paper) => paper.title)).toEqual(["Local", "Remote"]);
  });

  it("does not reintroduce annotations when their paper was permanently removed during loading", async () => {
    await mount(); const query = deferred<Annotation[]>(); loadNotes.mockReturnValueOnce(query.promise);
    let pending!: Promise<LibraryState>;
    act(() => { pending = store.ensureAnnotationsLoaded("p1"); });
    await act(async () => { await Promise.resolve(); });
    act(() => store.setLibrary((current) => ({ ...current, papers: current.papers.filter((paper) => paper.id !== "p1") })));
    await act(async () => { query.resolve([note("orphan")]); await pending; });
    expect(store.library.annotations).toEqual([]);
  });

  it("surfaces failures and permits a retry without caching an empty result", async () => {
    await mount(); loadNotes.mockRejectedValueOnce(new Error("Disk unavailable"));
    await act(async () => { await expect(store.ensureAnnotationsLoaded("p1")).rejects.toThrow("Disk unavailable"); });
    expect(store.areAnnotationsLoaded("p1")).toBe(false);
    expect(store.annotationErrors.p1).toContain("Disk unavailable");
    expect(onError).toHaveBeenCalled();
    loadNotes.mockResolvedValueOnce([note("retried")]);
    await act(async () => { await store.ensureAnnotationsLoaded("p1"); });
    expect(store.areAnnotationsLoaded("p1")).toBe(true);
    expect(store.annotationErrors.p1).toBe("");
  });

  it("retains newly hydrated rows in the cloud-sync persistence baseline", async () => {
    await mount(); const base = store.library;
    loadNotes.mockResolvedValueOnce([note("a1")]);
    await act(async () => { await store.ensureAnnotationsLoaded("p1"); });
    act(() => {
      store.markPersisted(base);
      store.setLibrary((current) => ({ ...base, annotations: current.annotations }));
    });
    expect(writtenChanges()).toEqual([]);
  });

  it("accepts remote changes to rows hydrated during sync while preserving actual local edits", async () => {
    await mount(); const base = store.library;
    loadNotes.mockResolvedValueOnce([note("a1"), note("a2")]);
    await act(async () => { await store.ensureAnnotationsLoaded("p1"); });
    const local = { ...note("a2"), comment: "Local edit" };
    act(() => store.setLibrary((current) => ({ ...current, annotations: current.annotations.map((annotation) => annotation.id === local.id ? local : annotation) })));
    const synced = { ...base, annotations: [
      { ...note("a1"), comment: "Remote edit" }, { ...note("a2"), comment: "Remote copy" }
    ] };
    act(() => {
      const mergeBase = store.withHydratedAnnotations(base, store.libraryRef.current, synced);
      store.markPersisted(synced);
      store.setLibrary((current) => mergeBackgroundSyncState(mergeBase, synced, current, now));
    });
    expect(store.library.annotations.find((annotation) => annotation.id === "a1")?.comment).toBe("Remote edit");
    expect(store.library.annotations.find((annotation) => annotation.id === "a2")).toBe(local);
  });

  it("keeps annotations hydrated after the cloud snapshot scope was captured", async () => {
    await mount(); const base = store.library;
    loadNotes.mockResolvedValueOnce([note("late")]);
    await act(async () => { await store.ensureAnnotationsLoaded("p1"); });
    act(() => {
      const mergeBase = store.withHydratedAnnotations(base, store.libraryRef.current, base);
      store.markPersisted(base);
      store.setLibrary((current) => mergeBackgroundSyncState(mergeBase, base, current, now));
    });
    expect(store.library.annotations).toEqual([note("late")]);
    expect(store.areAnnotationsLoaded("p1")).toBe(true);
    expect(writtenChanges()).toEqual([]);
  });

  it("imports legacy annotations only when SQLite is empty", async () => {
    load.mockResolvedValueOnce({ state: createDefaultState(), empty: true });
    const legacy = { ...state(), annotations: [note("legacy")] };
    vi.mocked(loadLibraryState).mockReturnValue(legacy);
    await mount();
    expect(importStateToDb).toHaveBeenCalledWith(legacy);
    expect(store.library.annotations).toEqual(legacy.annotations);
    expect(store.areAnnotationsLoaded()).toBe(true);
  });

  it("keeps a fresh empty library scoped so its first cloud sync stays lazy", async () => {
    load.mockResolvedValueOnce({ state: createDefaultState(), empty: true });
    vi.mocked(loadLibraryState).mockReturnValue(createDefaultState());
    await mount();
    expect(store.loaded).toBe(true);
    expect(store.getAnnotationPaperIds()).toEqual([]);
    expect(store.areAnnotationsLoaded()).toBe(false);
    expect(loadNotes).not.toHaveBeenCalled();
  });

  it("keeps legacy annotation persistence available when SQLite fails", async () => {
    load.mockRejectedValueOnce(new Error("No database"));
    const legacy = { ...state(), annotations: [note("legacy")] };
    vi.mocked(loadLibraryState).mockReturnValue(legacy);
    await mount();
    expect(store.areAnnotationsLoaded()).toBe(true);
    expect(store.library.annotations).toEqual(legacy.annotations);
    act(() => store.setLibrary((current) => ({ ...current, annotations: [note("new")] })));
    expect(saveLibraryState).toHaveBeenLastCalledWith(store.library);
  });
});
