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
