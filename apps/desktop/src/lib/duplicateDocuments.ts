import type { EntityId, LibraryState, Paper } from "@lumora/shared";

export type DuplicateDocument = {
  paper: Paper;
  fileName: string;
  folderPaths: string[];
};

export type DuplicateDocumentGroup = {
  hash: string;
  documents: DuplicateDocument[];
};

export function findDuplicateDocuments(state: LibraryState): DuplicateDocumentGroup[] {
  const papers = new Map(state.papers.filter((paper) => !paper.deletedAt).map((paper) => [paper.id, paper]));
  const byHash = new Map<string, Map<EntityId, DuplicateDocument>>();

  for (const file of state.fileAssets) {
    const paper = papers.get(file.paperId);
    const hash = file.sha256?.trim().toLowerCase();
    if (!paper || file.deletedAt || !hash || !(file.mime === "application/pdf" || /\.pdf$/i.test(file.fileName))) continue;
    const documents = byHash.get(hash) ?? new Map<EntityId, DuplicateDocument>();
    if (!documents.has(paper.id)) {
      documents.set(paper.id, { paper, fileName: file.fileName, folderPaths: getPaperFolderPaths(state, paper.id) });
    }
    byHash.set(hash, documents);
  }

  return [...byHash.entries()]
    .filter(([, documents]) => documents.size > 1)
    .map(([hash, documents]) => ({ hash, documents: [...documents.values()] }))
    .sort((a, b) => a.documents[0].paper.title.localeCompare(b.documents[0].paper.title));
}

export function getPaperFolderPaths(state: LibraryState, paperId: EntityId): string[] {
  const collections = new Map(state.collections.filter((item) => !item.deletedAt).map((item) => [item.id, item]));
  const directIds = state.paperCollections
    .filter((item) => item.paperId === paperId && !item.deletedAt && collections.has(item.collectionId))
    .map((item) => item.collectionId);

  const paths = directIds.map((collectionId) => {
    const names: string[] = [];
    const visited = new Set<EntityId>();
    let currentId: EntityId | undefined = collectionId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const collection = collections.get(currentId);
      if (!collection) break;
      names.unshift(collection.name);
      currentId = collection.parentId;
    }
    return names.join(" / ");
  }).filter(Boolean);

  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}
