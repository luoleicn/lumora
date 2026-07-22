import {
  canonicalPaperCollectionId,
  canonicalPaperCollectionResetId,
  reconcilePaperCollections,
  type Collection,
  type EntityId,
  type LibraryState,
  type PaperCollection,
  type PaperCollectionReset
} from "@lumora/shared";
import { nextMembershipVersion } from "./membershipClock";

export type CollectionOption = {
  id: EntityId;
  path: string;
};

export function sortCollectionsAlphabetically(collections: Collection[]): Collection[] {
  return [...collections].sort((a, b) => a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
    numeric: true
  }));
}

export function getCollectionOptions(collections: Collection[]): CollectionOption[] {
  const activeCollections = collections.filter((collection) => !collection.deletedAt);
  const collectionById = new Map(activeCollections.map((collection) => [collection.id, collection]));

  return activeCollections
    .map((collection) => {
      const names = [collection.name];
      const visited = new Set<EntityId>([collection.id]);
      let parentId = collection.parentId;

      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = collectionById.get(parentId);
        if (!parent) break;
        names.unshift(parent.name);
        parentId = parent.parentId;
      }

      return {
        id: collection.id,
        path: names.join(" / ")
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, undefined, {
      sensitivity: "base",
      numeric: true
    }));
}

export function getActivePaperCollectionIds(state: LibraryState, paperId?: EntityId): Set<EntityId> {
  if (!paperId) return new Set();
  const collectionById = new Map(
    state.collections
      .filter((collection) => !collection.deletedAt)
      .map((collection) => [collection.id, collection])
  );
  const highlightedIds = new Set(state.paperCollections
    .filter((membership) => membership.paperId === paperId && !membership.deletedAt)
    .map((membership) => membership.collectionId));

  for (const collectionId of [...highlightedIds]) {
    let parentId = collectionById.get(collectionId)?.parentId;
    const visited = new Set<EntityId>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = collectionById.get(parentId);
      if (!parent) break;
      highlightedIds.add(parent.id);
      parentId = parent.parentId;
    }
  }

  return highlightedIds;
}

export function getCollectionAndDescendantIds(collections: Collection[], collectionId: string) {
  const ids = new Set<string>([collectionId]);
  let added = true;

  while (added) {
    added = false;
    for (const collection of collections) {
      if (!collection.deletedAt && collection.parentId && ids.has(collection.parentId) && !ids.has(collection.id)) {
        ids.add(collection.id);
        added = true;
      }
    }
  }

  return ids;
}

export function getCollectionPaperCount(state: LibraryState, collections: Collection[], collectionId: EntityId) {
  const collectionIds = getCollectionAndDescendantIds(collections, collectionId);
  const activePaperIds = new Set(state.papers.filter((paper) => !paper.deletedAt).map((paper) => paper.id));
  const countedPaperIds = new Set<EntityId>();

  for (const item of state.paperCollections) {
    if (!item.deletedAt && collectionIds.has(item.collectionId) && activePaperIds.has(item.paperId)) {
      countedPaperIds.add(item.paperId);
    }
  }

  return countedPaperIds.size;
}

export function addPaperToCollection(state: LibraryState, paperId: EntityId, collectionId: EntityId, now = new Date().toISOString()) {
  const paper = state.papers.find((item) => item.id === paperId && !item.deletedAt);
  const collection = state.collections.find((item) => item.id === collectionId && !item.deletedAt);
  if (!paper || !collection) {
    return state;
  }

  const existing = state.paperCollections.find((item) =>
    item.paperId === paperId && item.collectionId === collectionId && !item.deletedAt
  );
  if (existing) {
    return state;
  }

  const membershipVersion = nextMembershipVersion(state);
  const paperCollection: PaperCollection = {
    id: canonicalPaperCollectionId(paperId, collectionId),
    paperId,
    collectionId,
    membershipVersion,
    createdAt: now,
    updatedAt: now
  };

  return {
    ...state,
    paperCollections: reconcilePaperCollections(
      [paperCollection, ...state.paperCollections],
      state.paperCollectionResets ?? []
    )
  };
}

/**
 * Moves a paper to exactly one target collection. This is deliberately
 * independent of the currently selected view: the context-menu action says
 * "Move", so invoking it from All Documents or search must not silently turn
 * into "Add" and leave old memberships active. Drag-and-drop uses
 * addPaperToCollection when multi-collection filing is intended.
 *
 * Equivalent memberships can be created independently on different devices.
 * Keep one deterministic target link and tombstone every other active link so
 * the move also repairs those cross-device duplicates.
 */
export function movePaperToCollection(
  state: LibraryState,
  paperId: EntityId,
  targetCollectionId: EntityId,
  now = new Date().toISOString()
) {
  const paper = state.papers.find((item) => item.id === paperId && !item.deletedAt);
  const target = state.collections.find((item) => item.id === targetCollectionId && !item.deletedAt);
  if (!paper || !target) {
    return state;
  }

  const membershipVersion = nextMembershipVersion(state);
  const activeLinks = state.paperCollections.filter((item) => !item.deletedAt && item.paperId === paperId);
  const targetLink = activeLinks
    .filter((item) => item.collectionId === target.id)
    .sort((a, b) => Number(Boolean(b.mendeleyId)) - Number(Boolean(a.mendeleyId)) || a.id.localeCompare(b.id))[0];
  const removableLinkIds = new Set(activeLinks
    .filter((item) => item.collectionId !== target.id)
    .map((item) => item.id));

  let paperCollections = state.paperCollections.map((item) =>
    removableLinkIds.has(item.id)
      ? { ...item, membershipVersion, deletedAt: now, updatedAt: now }
      : item
  );
  const newTargetLink: PaperCollection = {
    ...(targetLink ?? {} as PaperCollection),
    id: canonicalPaperCollectionId(paperId, target.id),
    paperId,
    collectionId: target.id,
    membershipVersion,
    createdAt: targetLink?.createdAt ?? now,
    deletedAt: undefined,
    updatedAt: now
  };
  paperCollections = [newTargetLink, ...paperCollections.filter((item) => !(
    item.paperId === paperId && item.collectionId === target.id
  ))];
  const reset: PaperCollectionReset = {
    id: canonicalPaperCollectionResetId(paperId),
    paperId,
    targetCollectionId: target.id,
    membershipVersion,
    createdAt: state.paperCollectionResets?.find((item) => item.paperId === paperId)?.createdAt ?? now,
    updatedAt: now
  };
  return {
    ...state,
    paperCollections: reconcilePaperCollections(paperCollections, [reset, ...(state.paperCollectionResets ?? [])]),
    paperCollectionResets: [reset, ...(state.paperCollectionResets ?? []).filter((item) => item.paperId !== paperId)]
  };
}

export function deletePaperFromLibrary(state: LibraryState, paperId: EntityId, now = new Date().toISOString()) {
  const paper = state.papers.find((item) => item.id === paperId && !item.deletedAt);
  if (!paper) {
    return state;
  }

  const membershipVersion = nextMembershipVersion(state);
  return {
    ...state,
    papers: state.papers.map((item) =>
      item.id === paperId ? { ...item, deletedAt: now, updatedAt: now } : item
    ),
    fileAssets: state.fileAssets.map((item) =>
      item.paperId === paperId && !item.deletedAt ? { ...item, deletedAt: now, updatedAt: now } : item
    ),
    paperCollections: state.paperCollections.map((item) =>
      item.paperId === paperId && !item.deletedAt
        ? { ...item, membershipVersion, deletedAt: now, updatedAt: now }
        : item
    ),
    annotations: state.annotations.map((item) =>
      item.paperId === paperId && !item.deletedAt ? { ...item, deletedAt: now, updatedAt: now } : item
    )
  };
}

// Restores the paper (and its file/annotations) but leaves its old
// paperCollections links deleted, so it lands in Unsorted rather than
// reappearing in whatever folder it was in before deletion.
export function restorePaperFromTrash(state: LibraryState, paperId: EntityId, now = new Date().toISOString()) {
  const paper = state.papers.find((item) => item.id === paperId && item.deletedAt);
  if (!paper) {
    return state;
  }

  return {
    ...state,
    papers: state.papers.map((item) =>
      item.id === paperId ? { ...item, deletedAt: undefined, updatedAt: now } : item
    ),
    fileAssets: state.fileAssets.map((item) =>
      item.paperId === paperId && item.deletedAt ? { ...item, deletedAt: undefined, updatedAt: now } : item
    ),
    annotations: state.annotations.map((item) =>
      item.paperId === paperId && item.deletedAt ? { ...item, deletedAt: undefined, updatedAt: now } : item
    )
  };
}

// Removes an already-trashed paper and every local entity that belongs to it.
// This is intentionally separate from ordinary delete, which remains a
// reversible soft-delete so sync can propagate the tombstone.
export function permanentlyDeletePaperFromTrash(state: LibraryState, paperId: EntityId): LibraryState {
  const paper = state.papers.find((item) => item.id === paperId && item.deletedAt);
  if (!paper) {
    return state;
  }

  return {
    ...state,
    papers: state.papers.filter((item) => item.id !== paperId),
    fileAssets: state.fileAssets.filter((item) => item.paperId !== paperId),
    paperCollections: state.paperCollections.filter((item) => item.paperId !== paperId),
    paperCollectionResets: (state.paperCollectionResets ?? []).filter((item) => item.paperId !== paperId),
    annotations: state.annotations.filter((item) => item.paperId !== paperId)
  };
}

// Permanently removes every trashed paper and all of their associated entities.
// Returns the set of removed paper IDs so callers can clean up blobs and disk
// files that aren't represented in the library state.
export function permanentlyDeleteAllFromTrash(state: LibraryState): { state: LibraryState; removedPaperIds: EntityId[] } {
  const trashedPaperIds = new Set(
    state.papers.filter((paper) => paper.deletedAt).map((paper) => paper.id)
  );

  if (trashedPaperIds.size === 0) {
    return { state, removedPaperIds: [] };
  }

  return {
    state: {
      ...state,
      papers: state.papers.filter((item) => !trashedPaperIds.has(item.id)),
      fileAssets: state.fileAssets.filter((item) => !trashedPaperIds.has(item.paperId)),
      paperCollections: state.paperCollections.filter((item) => !trashedPaperIds.has(item.paperId)),
      paperCollectionResets: (state.paperCollectionResets ?? []).filter((item) => !trashedPaperIds.has(item.paperId)),
      annotations: state.annotations.filter((item) => !trashedPaperIds.has(item.paperId))
    },
    removedPaperIds: [...trashedPaperIds]
  };
}

export function removePaperFromCollectionTree(
  state: LibraryState,
  paperId: EntityId,
  collectionId: EntityId,
  now = new Date().toISOString()
) {
  const paper = state.papers.find((item) => item.id === paperId && !item.deletedAt);
  const collection = state.collections.find((item) => item.id === collectionId && !item.deletedAt);
  if (!paper || !collection) {
    return state;
  }

  const collectionIds = getCollectionAndDescendantIds(state.collections, collectionId);
  const removableLinks = state.paperCollections.filter((item) =>
    !item.deletedAt && item.paperId === paperId && collectionIds.has(item.collectionId)
  );
  if (removableLinks.length === 0) {
    return state;
  }

  const membershipVersion = nextMembershipVersion(state);
  const removableLinkIds = new Set(removableLinks.map((item) => item.id));
  const parentId = collection.parentId;
  const parentLink = parentId
    ? state.paperCollections.find((item) => !item.deletedAt && item.paperId === paperId && item.collectionId === parentId)
    : undefined;
  const moveTargetCollectionId = parentId && !parentLink ? parentId : undefined;
  let paperCollections = state.paperCollections.map((item) => removableLinkIds.has(item.id)
    ? { ...item, membershipVersion, deletedAt: now, updatedAt: now }
    : item);
  if (moveTargetCollectionId) {
    paperCollections = [{
      id: canonicalPaperCollectionId(paperId, moveTargetCollectionId),
      paperId,
      collectionId: moveTargetCollectionId,
      membershipVersion,
      createdAt: now,
      updatedAt: now
    }, ...paperCollections.filter((item) => !(
      item.paperId === paperId && item.collectionId === moveTargetCollectionId
    ))];
  }

  return {
    ...state,
    paperCollections: reconcilePaperCollections(paperCollections, state.paperCollectionResets ?? [])
  };
}

// Unlike deletion, renaming the system inbox is allowed: every consumer keys on
// the fixed "collection_inbox" id, so the display name is free to change.
export function renameCollection(state: LibraryState, collectionId: EntityId, name: string, now = new Date().toISOString()) {
  const trimmedName = name.trim();
  const target = state.collections.find((collection) => collection.id === collectionId && !collection.deletedAt);
  if (!target || !trimmedName || target.name === trimmedName) {
    return state;
  }

  return {
    ...state,
    collections: state.collections.map((collection) =>
      collection.id === collectionId ? { ...collection, name: trimmedName, updatedAt: now } : collection
    )
  };
}

export function deleteCollectionAndReassignPapers(state: LibraryState, collectionId: EntityId, now = new Date().toISOString()) {
  const target = state.collections.find((collection) => collection.id === collectionId && !collection.deletedAt);
  if (!target || target.id === "collection_inbox") {
    return state;
  }

  const parentId = target.parentId;
  const activeParentPaperIds = new Set(
    parentId
      ? state.paperCollections
        .filter((item) => !item.deletedAt && item.collectionId === parentId)
        .map((item) => item.paperId)
      : []
  );

  const membershipVersion = nextMembershipVersion(state);
  let paperCollections = state.paperCollections.map((paperCollection) => {
    if (paperCollection.deletedAt || paperCollection.collectionId !== target.id) return paperCollection;
    return { ...paperCollection, membershipVersion, deletedAt: now, updatedAt: now };
  });
  if (parentId) {
    const reassignedPaperIds = new Set(state.paperCollections
      .filter((item) => !item.deletedAt && item.collectionId === target.id && !activeParentPaperIds.has(item.paperId))
      .map((item) => item.paperId));
    for (const paperId of reassignedPaperIds) {
      paperCollections = [{
        id: canonicalPaperCollectionId(paperId, parentId),
        paperId,
        collectionId: parentId,
        membershipVersion,
        createdAt: now,
        updatedAt: now
      }, ...paperCollections.filter((item) => !(item.paperId === paperId && item.collectionId === parentId))];
    }
  }

  return {
    ...state,
    collections: state.collections.map((collection) => {
      if (collection.id === target.id) {
        return { ...collection, deletedAt: now, updatedAt: now };
      }

      if (!collection.deletedAt && collection.parentId === target.id) {
        return { ...collection, parentId, updatedAt: now };
      }

      return collection;
    }),
    paperCollections: reconcilePaperCollections(paperCollections, state.paperCollectionResets ?? [])
  };
}
