import { invoke } from "@tauri-apps/api/core";
import type { LibraryEntity, LibraryState, SyncEntity } from "@lumora/shared";
import { createDefaultState } from "./localStore";

export type EntityChange = {
  entityType: SyncEntity;
  entity: LibraryEntity;
};

export type WriteSource = "local" | "remote";

const entityCollections: Array<{ entityType: SyncEntity; key: keyof LibraryState }> = [
  { entityType: "paper", key: "papers" },
  { entityType: "fileAsset", key: "fileAssets" },
  { entityType: "collection", key: "collections" },
  { entityType: "paperCollection", key: "paperCollections" },
  { entityType: "paperCollectionReset", key: "paperCollectionResets" },
  { entityType: "annotation", key: "annotations" }
];

const lastSyncCursorMetaKey = "lastSyncCursor";

// Every library mutation is an immutable update, so an entity object that was
// not touched keeps its reference. Diffing by reference finds exactly the rows
// that need upserting; entities are only ever soft-deleted, never removed from
// the arrays, so disappearance is not a case this diff needs to handle.
export function diffLibraryStates(previous: LibraryState, next: LibraryState): EntityChange[] {
  const changes: EntityChange[] = [];

  for (const { entityType, key } of entityCollections) {
    const previousItems = (previous[key] as LibraryEntity[] | undefined) ?? [];
    const nextItems = (next[key] as LibraryEntity[] | undefined) ?? [];
    if (previousItems === nextItems) {
      continue;
    }

    const previousById = new Map(previousItems.map((item) => [item.id, item]));
    for (const item of nextItems) {
      if (previousById.get(item.id) !== item) {
        changes.push({ entityType, entity: item });
      }
    }
  }

  return changes;
}

function entityValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => entityValuesEqual(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
      && entityValuesEqual(leftRecord[key], rightRecord[key]));
}

// The normal React-store path can use object identity because immutable edits
// preserve references. A sync integrity check compares a freshly parsed DB
// snapshot with the in-memory state, so it must compare entity values instead.
export function diffLibraryStateValues(persisted: LibraryState, inMemory: LibraryState): EntityChange[] {
  const changes: EntityChange[] = [];

  for (const { entityType, key } of entityCollections) {
    const persistedItems = (persisted[key] as LibraryEntity[] | undefined) ?? [];
    const inMemoryItems = (inMemory[key] as LibraryEntity[] | undefined) ?? [];
    const persistedById = new Map(persistedItems.map((item) => [item.id, item]));
    for (const item of inMemoryItems) {
      const stored = persistedById.get(item.id);
      if (!stored || !entityValuesEqual(stored, item)) {
        changes.push({ entityType, entity: item });
      }
    }
  }

  return changes;
}

export async function persistEntities(changes: EntityChange[], source: WriteSource = "local"): Promise<void> {
  if (changes.length === 0) {
    return;
  }

  await invoke("db_upsert_entities", {
    changes: changes.map(({ entityType, entity }) => ({
      entityType,
      id: entity.id,
      data: JSON.stringify(entity),
      updatedAt: entity.updatedAt,
      deletedAt: "deletedAt" in entity ? entity.deletedAt : undefined
    })),
    source
  });
}

export async function deletePersistedEntities(entities: Array<{ entityType: SyncEntity; id: string }>): Promise<void> {
  if (entities.length === 0) {
    return;
  }
  // A debounced upsert may still hold a state in which these entities exist;
  // flushing first keeps the write order (upsert, then delete) that the
  // pre-debounce code guaranteed, so deleted rows can never be resurrected.
  await flushLibraryPersist();
  await invoke("db_delete_entities", { entities });
}

export async function persistSyncCursor(cursor: number): Promise<void> {
  await invoke("db_set_meta", { key: lastSyncCursorMetaKey, value: String(cursor) });
}

export async function loadLibraryFromDb(): Promise<{ state: LibraryState; empty: boolean }> {
  const loaded = await invoke<{
    entities: Array<{ entityType: string; data: string }>;
    meta: Record<string, string>;
  }>("db_load_library");

  const byType = new Map<string, LibraryEntity[]>(entityCollections.map(({ entityType }) => [entityType, []]));
  for (const row of loaded.entities) {
    byType.get(row.entityType)?.push(JSON.parse(row.data) as LibraryEntity);
  }

  // createDefaultState seeds the inbox collection; keep the seeds only when the
  // database holds nothing for that entity type.
  const base = createDefaultState();
  const pick = <T extends LibraryEntity>(entityType: SyncEntity, fallback: T[]): T[] => {
    const items = byType.get(entityType) as T[] | undefined;
    return items && items.length > 0 ? items : fallback;
  };

  const state: LibraryState = {
    papers: pick("paper", base.papers),
    fileAssets: pick("fileAsset", base.fileAssets),
    collections: pick("collection", base.collections),
    paperCollections: pick("paperCollection", base.paperCollections),
    paperCollectionResets: pick("paperCollectionReset", []),
    annotations: pick("annotation", base.annotations)
  };

  const cursor = Number.parseInt(loaded.meta[lastSyncCursorMetaKey] ?? "", 10);
  if (Number.isFinite(cursor)) {
    state.lastSyncCursor = cursor;
  }

  return { state, empty: loaded.entities.length === 0 };
}

export async function importStateToDb(state: LibraryState): Promise<void> {
  const changes: EntityChange[] = [];
  for (const { entityType, key } of entityCollections) {
    for (const entity of (state[key] as LibraryEntity[] | undefined) ?? []) {
      changes.push({ entityType, entity });
    }
  }

  await persistEntities(changes, "local");
  if (state.lastSyncCursor !== undefined) {
    await persistSyncCursor(state.lastSyncCursor);
  }
}

/**
 * Makes the state currently shown by the UI authoritative before native cloud
 * sync scans SQLite. The regular debounced queue should already keep both in
 * lockstep; the value comparison is an integrity boundary for interrupted or
 * incorrectly-baselined writes, and only marks genuinely divergent rows dirty.
 */
export async function persistLibraryStateSnapshot(state: LibraryState): Promise<void> {
  await flushLibraryPersist();
  const persisted = await loadLibraryFromDb();
  if (persisted.empty) {
    await importStateToDb(state);
    return;
  }
  await persistEntities(diffLibraryStateValues(persisted.state, state), "local");
}

// Serializes writes so rapid successive state changes land in order. On top of
// the queue sits a debounce: consecutive states that chain onto the pending
// pair (the new `previous` is exactly the pending `next`) are coalesced, so a
// typing burst persists as one diff previous→latest instead of one SQLite
// write (and one FTS row update) per keystroke. A state that does not chain —
// e.g. a sync adopted a fresh baseline via markPersisted — flushes the pending
// write first so a diff never straddles a baseline reset.
let writeQueue: Promise<void> = Promise.resolve();

const persistDebounceMs = 250;

type PendingPersist = {
  previous: LibraryState;
  next: LibraryState;
  onError?: (error: unknown) => void;
};

let pendingPersist: PendingPersist | undefined;
let pendingPersistTimer: ReturnType<typeof setTimeout> | undefined;

export function enqueueLibraryPersist(previous: LibraryState, next: LibraryState, onError?: (error: unknown) => void) {
  if (pendingPersist && pendingPersist.next === previous) {
    pendingPersist.next = next;
    pendingPersist.onError = onError ?? pendingPersist.onError;
  } else {
    void flushLibraryPersist();
    pendingPersist = { previous, next, onError };
  }
  if (pendingPersistTimer !== undefined) {
    clearTimeout(pendingPersistTimer);
  }
  pendingPersistTimer = setTimeout(() => {
    void flushLibraryPersist();
  }, persistDebounceMs);
  return writeQueue;
}

/**
 * Push the pending debounced write into the queue immediately. The returned
 * promise resolves once every write queued so far has been persisted.
 */
export function flushLibraryPersist(): Promise<void> {
  if (pendingPersistTimer !== undefined) {
    clearTimeout(pendingPersistTimer);
    pendingPersistTimer = undefined;
  }
  const pending = pendingPersist;
  if (!pending) {
    return writeQueue;
  }
  pendingPersist = undefined;
  writeQueue = writeQueue.then(async () => {
    try {
      await persistEntities(diffLibraryStates(pending.previous, pending.next));
      if (pending.previous.lastSyncCursor !== pending.next.lastSyncCursor && pending.next.lastSyncCursor !== undefined) {
        await persistSyncCursor(pending.next.lastSyncCursor);
      }
    } catch (error) {
      pending.onError?.(error);
    }
  });
  return writeQueue;
}

// The debounce window must not survive the page: flush when the app hides or
// unloads so at most an in-flight IPC call is at risk, not a whole edit burst.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    void flushLibraryPersist();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushLibraryPersist();
    }
  });
}
