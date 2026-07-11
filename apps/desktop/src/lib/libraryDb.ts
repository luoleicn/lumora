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
    const previousItems = previous[key] as LibraryEntity[];
    const nextItems = next[key] as LibraryEntity[];
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
    for (const entity of state[key] as LibraryEntity[]) {
      changes.push({ entityType, entity });
    }
  }

  await persistEntities(changes, "local");
  if (state.lastSyncCursor !== undefined) {
    await persistSyncCursor(state.lastSyncCursor);
  }
}

// Serializes writes so rapid successive state changes land in order; each queued
// job diffs against the state that the previous job persisted.
let writeQueue: Promise<void> = Promise.resolve();

export function enqueueLibraryPersist(previous: LibraryState, next: LibraryState, onError?: (error: unknown) => void) {
  writeQueue = writeQueue.then(async () => {
    try {
      await persistEntities(diffLibraryStates(previous, next));
      if (previous.lastSyncCursor !== next.lastSyncCursor && next.lastSyncCursor !== undefined) {
        await persistSyncCursor(next.lastSyncCursor);
      }
    } catch (error) {
      onError?.(error);
    }
  });
  return writeQueue;
}
