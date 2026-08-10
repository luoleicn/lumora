export type PaperSelection = {
  selectedIds: string[];
  primaryId?: string;
  anchorId?: string;
};

export type PaperSelectionMode = "replace" | "toggle" | "range" | "add-range";

export function createPaperSelection(paperId?: string): PaperSelection {
  return paperId
    ? { selectedIds: [paperId], primaryId: paperId, anchorId: paperId }
    : { selectedIds: [] };
}

export function updatePaperSelection(
  current: PaperSelection,
  paperId: string,
  orderedPaperIds: string[],
  mode: PaperSelectionMode
): PaperSelection {
  const orderedIds = uniqueIds(orderedPaperIds);

  if (mode === "replace") {
    return createPaperSelection(paperId);
  }

  if (mode === "toggle") {
    if (!current.selectedIds.includes(paperId)) {
      return {
        selectedIds: orderSelectedIds([...current.selectedIds, paperId], orderedIds),
        primaryId: paperId,
        anchorId: paperId
      };
    }

    const selectedIds = current.selectedIds.filter((id) => id !== paperId);
    const primaryId = current.primaryId === paperId
      ? selectedIds.at(-1)
      : current.primaryId;
    return selectedIds.length > 0
      ? {
          selectedIds,
          primaryId,
          anchorId: current.anchorId === paperId ? primaryId : current.anchorId
        }
      : createPaperSelection();
  }

  const clickedIndex = orderedIds.indexOf(paperId);
  if (clickedIndex < 0) {
    return createPaperSelection(paperId);
  }
  const anchorId = current.anchorId && orderedIds.includes(current.anchorId)
    ? current.anchorId
    : current.primaryId && orderedIds.includes(current.primaryId)
      ? current.primaryId
      : paperId;
  const anchorIndex = orderedIds.indexOf(anchorId);
  const rangeIds = orderedIds.slice(
    Math.min(anchorIndex, clickedIndex),
    Math.max(anchorIndex, clickedIndex) + 1
  );
  const selectedIds = mode === "add-range"
    ? orderSelectedIds([...current.selectedIds, ...rangeIds], orderedIds)
    : rangeIds;

  return {
    selectedIds,
    primaryId: paperId,
    anchorId
  };
}

export function selectAllPapers(current: PaperSelection, orderedPaperIds: string[]): PaperSelection {
  const selectedIds = uniqueIds(orderedPaperIds);
  if (selectedIds.length === 0) {
    return createPaperSelection();
  }
  const primaryId = current.primaryId && selectedIds.includes(current.primaryId)
    ? current.primaryId
    : selectedIds[0];
  return { selectedIds, primaryId, anchorId: primaryId };
}

export function reconcilePaperSelection(
  current: PaperSelection,
  eligiblePaperIds: string[]
): PaperSelection {
  const eligibleIds = new Set(eligiblePaperIds);
  const selectedIds = current.selectedIds.filter((id) => eligibleIds.has(id));
  if (selectedIds.length === 0) {
    return current.selectedIds.length === 0 ? current : createPaperSelection();
  }
  const primaryId = current.primaryId && selectedIds.includes(current.primaryId)
    ? current.primaryId
    : selectedIds.at(-1);
  const anchorId = current.anchorId && selectedIds.includes(current.anchorId)
    ? current.anchorId
    : primaryId;

  if (
    selectedIds.length === current.selectedIds.length
    && selectedIds.every((id, index) => id === current.selectedIds[index])
    && primaryId === current.primaryId
    && anchorId === current.anchorId
  ) {
    return current;
  }

  return { selectedIds, primaryId, anchorId };
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function orderSelectedIds(selectedIds: string[], orderedIds: string[]): string[] {
  const selected = new Set(selectedIds);
  const inOrder = orderedIds.filter((id) => selected.delete(id));
  return [...inOrder, ...selected];
}
