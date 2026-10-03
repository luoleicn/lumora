import type { Annotation, FileAsset, LibraryState, Paper, PaperCollection } from "@lumora/shared";

// Library mutations are immutable. Cache each index against its own source
// array, so editing a note does not invalidate paper/file/membership indexes.
// Weak keys let abandoned states (including large sync snapshots) be collected.
const paperCache = new WeakMap<Paper[], ReturnType<typeof buildPaperIndex>>();
const fileCache = new WeakMap<FileAsset[], ReturnType<typeof buildFileIndex>>();
const annotationCache = new WeakMap<Annotation[], ReturnType<typeof groupByPaperId<Annotation>>>();
const membershipCache = new WeakMap<PaperCollection[], ReturnType<typeof buildMembershipIndex>>();

export const emptyAnnotations: Annotation[] = [];
export const emptyFileAssets: FileAsset[] = [];

function cached<T, R>(cache: WeakMap<T[], R>, items: T[], build: (items: T[]) => R): R {
  const existing = cache.get(items);
  if (existing) return existing;
  const index = build(items);
  cache.set(items, index);
  return index;
}

function firstById<T extends { id: string }>(items: T[]): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const item of items) if (!result.has(item.id)) result.set(item.id, item);
  return result;
}

function groupByPaperId<T extends { paperId: string }>(items: T[]): ReadonlyMap<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const group = result.get(item.paperId);
    if (group) group.push(item);
    else result.set(item.paperId, [item]);
  }
  return result;
}

function buildPaperIndex(papers: Paper[]) {
  const active = papers.filter((paper) => !paper.deletedAt);
  return {
    byId: firstById(papers),
    activeById: firstById(active),
    active,
    deleted: papers.filter((paper) => paper.deletedAt),
    noArxivCount: active.filter((paper) => !paper.arxiv).length,
    authors: [...new Set(active.flatMap((paper) => paper.authors.map((author) => author.fullName)).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b)),
    tags: [...new Set(active.flatMap((paper) => paper.tags ?? []).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  };
}

export function isPdfFile(file: FileAsset): boolean {
  return file.mime === "application/pdf" || /\.pdf$/i.test(file.fileName);
}

/** Reader/library view policy: a reconciled disk path is authoritative. */
export function isLocalPdfFile(file: FileAsset): boolean {
  return Boolean(file.localPath) || (isPdfFile(file) && file.downloadState === "local");
}

function buildFileIndex(files: FileAsset[]) {
  const readerLocalPaperIds = new Set<string>();
  const searchPdfByPaperId = new Map<string, FileAsset>();
  for (const file of files) {
    if (file.deletedAt) continue;
    if (isLocalPdfFile(file)) readerLocalPaperIds.add(file.paperId);
    // Sidebar and body backfill deliberately retain their stricter historical
    // policy (PDF name/mime + local flag), rather than changing their behavior
    // to match the reader's path-first policy as part of this optimization.
    if (isPdfFile(file) && file.downloadState === "local" && !searchPdfByPaperId.has(file.paperId)) {
      searchPdfByPaperId.set(file.paperId, file);
    }
  }
  return { byId: firstById(files), byPaperId: groupByPaperId(files), readerLocalPaperIds, searchPdfByPaperId };
}

function buildMembershipIndex(memberships: PaperCollection[]) {
  const active = memberships.filter((item) => !item.deletedAt);
  return { byPaperId: groupByPaperId(active), paperIds: new Set(active.map((item) => item.paperId)) };
}

export function getPaperIndex(papers: Paper[]) { return cached(paperCache, papers, buildPaperIndex); }
export function getFileIndex(files: FileAsset[]) { return cached(fileCache, files, buildFileIndex); }
export function getAnnotationIndex(annotations: Annotation[]) { return cached(annotationCache, annotations, groupByPaperId<Annotation>); }
export function getMembershipIndex(memberships: PaperCollection[]) { return cached(membershipCache, memberships, buildMembershipIndex); }

export function getLibraryIndexes(state: LibraryState) {
  return {
    papers: getPaperIndex(state.papers),
    files: getFileIndex(state.fileAssets),
    annotations: getAnnotationIndex(state.annotations),
    memberships: getMembershipIndex(state.paperCollections)
  };
}

export function selectReaderFile(files: FileAsset[]): FileAsset | undefined {
  return files.find((file) => !file.deletedAt && isLocalPdfFile(file))
    ?? files.find((file) => !file.deletedAt && isPdfFile(file));
}

export function selectDetailsFile(files: FileAsset[]): FileAsset | undefined {
  return files.find((file) => !file.deletedAt && isLocalPdfFile(file)) ?? files.find((file) => !file.deletedAt);
}

export function getSidebarCounts(state: Pick<LibraryState, "papers" | "fileAssets" | "paperCollections">) {
  const papers = getPaperIndex(state.papers);
  const files = getFileIndex(state.fileAssets);
  const memberships = getMembershipIndex(state.paperCollections);
  return {
    unfiledPaperCount: papers.active.filter((paper) => !memberships.paperIds.has(paper.id)).length,
    noPdfCount: papers.active.filter((paper) => !files.searchPdfByPaperId.has(paper.id)).length
  };
}

/** Union each subtree's active papers once, preserving duplicate/cycle guards. */
export function getCollectionPaperCounts(state: Pick<LibraryState, "papers" | "collections" | "paperCollections">) {
  const activeCollections = state.collections.filter((collection) => !collection.deletedAt);
  const activePaperIds = getPaperIndex(state.papers).activeById;
  const directMemberIdsByCollection = new Map<string, string[]>();
  for (const item of state.paperCollections) {
    if (item.deletedAt || !activePaperIds.has(item.paperId)) continue;
    const members = directMemberIdsByCollection.get(item.collectionId);
    if (members) members.push(item.paperId);
    else directMemberIdsByCollection.set(item.collectionId, [item.paperId]);
  }
  const childIdsByParent = new Map<string, string[]>();
  for (const collection of activeCollections) {
    if (!collection.parentId) continue;
    const children = childIdsByParent.get(collection.parentId);
    if (children) children.push(collection.id);
    else childIdsByParent.set(collection.parentId, [collection.id]);
  }
  return Object.fromEntries(activeCollections.map((collection) => {
    const subtree = [collection.id];
    const visited = new Set(subtree);
    for (let cursor = 0; cursor < subtree.length; cursor += 1) {
      for (const childId of childIdsByParent.get(subtree[cursor]) ?? []) {
        if (!visited.has(childId)) { visited.add(childId); subtree.push(childId); }
      }
    }
    const countedPaperIds = new Set<string>();
    for (const id of subtree) for (const paperId of directMemberIdsByCollection.get(id) ?? []) countedPaperIds.add(paperId);
    return [collection.id, countedPaperIds.size];
  }));
}
