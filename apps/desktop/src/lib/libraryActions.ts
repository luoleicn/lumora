import type { Collection, EntityId, LibraryState, PaperCollection } from "@lumora/shared";
import { createId } from "./id";

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

  const paperCollection: PaperCollection = {
    id: createId("paper_collection"),
    paperId,
    collectionId,
    createdAt: now,
    updatedAt: now
  };

  return {
    ...state,
    paperCollections: [paperCollection, ...state.paperCollections]
  };
}

export function deletePaperFromLibrary(state: LibraryState, paperId: EntityId, now = new Date().toISOString()) {
  const paper = state.papers.find((item) => item.id === paperId && !item.deletedAt);
  if (!paper) {
    return state;
  }

  return {
    ...state,
    papers: state.papers.map((item) =>
      item.id === paperId ? { ...item, deletedAt: now, updatedAt: now } : item
    ),
    fileAssets: state.fileAssets.map((item) =>
      item.paperId === paperId && !item.deletedAt ? { ...item, deletedAt: now, updatedAt: now } : item
    ),
    paperCollections: state.paperCollections.map((item) =>
      item.paperId === paperId && !item.deletedAt ? { ...item, deletedAt: now, updatedAt: now } : item
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

  const removableLinkIds = new Set(removableLinks.map((item) => item.id));
  const parentId = collection.parentId;
  const parentLink = parentId
    ? state.paperCollections.find((item) => !item.deletedAt && item.paperId === paperId && item.collectionId === parentId)
    : undefined;
  const moveTargetCollectionId = parentId && !parentLink ? parentId : undefined;
  const linkToMove = moveTargetCollectionId
    ? removableLinks.find((item) => item.collectionId === collectionId) ?? removableLinks[0]
    : undefined;

  return {
    ...state,
    paperCollections: state.paperCollections.map((item) => {
      if (!removableLinkIds.has(item.id)) {
        return item;
      }

      if (linkToMove && moveTargetCollectionId && item.id === linkToMove.id) {
        return { ...item, collectionId: moveTargetCollectionId, updatedAt: now };
      }

      return { ...item, deletedAt: now, updatedAt: now };
    })
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
    paperCollections: state.paperCollections.map((paperCollection) => {
      if (paperCollection.deletedAt || paperCollection.collectionId !== target.id) {
        return paperCollection;
      }

      if (!parentId || activeParentPaperIds.has(paperCollection.paperId)) {
        return { ...paperCollection, deletedAt: now, updatedAt: now };
      }

      activeParentPaperIds.add(paperCollection.paperId);
      return { ...paperCollection, collectionId: parentId, updatedAt: now };
    })
  };
}
