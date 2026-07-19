import type { LibraryState } from "@lumora/shared";
import type { PdfViewState } from "./pdfViewState";

export const workspaceSessionKey = "lumora:workspace-session-v1";

export type WorkspaceTab =
  | { id: "documents"; kind: "documents"; title: "Documents" }
  | { id: "notebook"; kind: "notebook"; title: "Notebook" }
  | { id: string; kind: "paper"; paperId: string; title: string };

export type WorkspacePdfViewState = PdfViewState;

export type WorkspaceSessionV1 = {
  version: 1;
  tabs: WorkspaceTab[];
  activeTabId: string;
  selectedCollectionId: string;
  selectedPaperId?: string;
  pdfViewStates: Record<string, WorkspacePdfViewState>;
};

export const documentsTab: WorkspaceTab = { id: "documents", kind: "documents", title: "Documents" };

export type WorkspaceTabDropEdge = "before" | "after";

const virtualCollectionIds = new Set([
  "all",
  "recently_added",
  "no_arxiv",
  "no_pdf",
  "favorites",
  "unsorted",
  "trash"
]);

type WorkspaceSessionStorage = Pick<Storage, "getItem" | "setItem">;

export function createDefaultWorkspaceSession(): WorkspaceSessionV1 {
  return {
    version: 1,
    tabs: [documentsTab],
    activeTabId: documentsTab.id,
    selectedCollectionId: "all",
    pdfViewStates: {}
  };
}

export function loadWorkspaceSession(storage: WorkspaceSessionStorage = localStorage): WorkspaceSessionV1 {
  try {
    return parseWorkspaceSession(storage.getItem(workspaceSessionKey));
  } catch {
    return createDefaultWorkspaceSession();
  }
}

export function saveWorkspaceSession(
  session: WorkspaceSessionV1,
  storage: WorkspaceSessionStorage = localStorage
): void {
  try {
    storage.setItem(workspaceSessionKey, JSON.stringify(session));
  } catch {
    // A workspace snapshot is best-effort UI state; storage failures must not
    // interrupt reading or application shutdown.
  }
}

export function parseWorkspaceSession(raw: string | null): WorkspaceSessionV1 {
  if (!raw) {
    return createDefaultWorkspaceSession();
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) {
      return createDefaultWorkspaceSession();
    }

    const tabs = normalizeTabs(parsed.tabs);
    const tabIds = new Set(tabs.map((tab) => tab.id));
    const activeTabId = typeof parsed.activeTabId === "string" && tabIds.has(parsed.activeTabId)
      ? parsed.activeTabId
      : documentsTab.id;

    return {
      version: 1,
      tabs,
      activeTabId,
      selectedCollectionId: nonEmptyString(parsed.selectedCollectionId) ?? "all",
      selectedPaperId: nonEmptyString(parsed.selectedPaperId),
      pdfViewStates: normalizePdfViewStates(parsed.pdfViewStates)
    };
  } catch {
    return createDefaultWorkspaceSession();
  }
}

/** Remove session references that are no longer valid in the loaded library. */
export function reconcileWorkspaceSession(
  session: WorkspaceSessionV1,
  library: LibraryState
): WorkspaceSessionV1 {
  const papersById = new Map(
    library.papers.filter((paper) => !paper.deletedAt).map((paper) => [paper.id, paper])
  );
  const collectionIds = new Set(
    library.collections.filter((collection) => !collection.deletedAt).map((collection) => collection.id)
  );

  const tabs = session.tabs.flatMap((tab): WorkspaceTab[] => {
    if (tab.kind !== "paper") {
      return [tab];
    }
    const paper = papersById.get(tab.paperId);
    return paper ? [{ ...tab, title: paper.title }] : [];
  });
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const activeTabId = tabIds.has(session.activeTabId) ? session.activeTabId : documentsTab.id;
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const selectedPaperId = activeTab?.kind === "paper"
    ? activeTab.paperId
    : session.selectedPaperId && papersById.has(session.selectedPaperId)
      ? session.selectedPaperId
      : undefined;

  return {
    version: 1,
    tabs,
    activeTabId,
    selectedCollectionId: virtualCollectionIds.has(session.selectedCollectionId)
      || collectionIds.has(session.selectedCollectionId)
      ? session.selectedCollectionId
      : "all",
    selectedPaperId,
    pdfViewStates: Object.fromEntries(
      Object.entries(session.pdfViewStates).filter(([paperId]) => papersById.has(paperId))
    )
  };
}

/** Reorders a movable tab while preserving Documents as the pinned first tab. */
export function reorderWorkspaceTabs(
  tabs: WorkspaceTab[],
  draggedTabId: string,
  targetTabId: string,
  edge: WorkspaceTabDropEdge
): WorkspaceTab[] {
  if (draggedTabId === documentsTab.id || draggedTabId === targetTabId) {
    return tabs;
  }

  const draggedTab = tabs.find((tab) => tab.id === draggedTabId);
  const targetTab = tabs.find((tab) => tab.id === targetTabId);
  if (!draggedTab || !targetTab) {
    return tabs;
  }

  const next = tabs.filter((tab) => tab.id !== draggedTabId);
  const targetIndex = next.findIndex((tab) => tab.id === targetTabId);
  const requestedIndex = targetTabId === documentsTab.id
    ? 1
    : targetIndex + (edge === "after" ? 1 : 0);
  const insertIndex = Math.min(Math.max(requestedIndex, 1), next.length);
  next.splice(insertIndex, 0, draggedTab);

  return next.every((tab, index) => tab === tabs[index]) ? tabs : next;
}

function normalizeTabs(value: unknown): WorkspaceTab[] {
  const tabs: WorkspaceTab[] = [documentsTab];
  if (!Array.isArray(value)) {
    return tabs;
  }

  const seenIds = new Set<string>([documentsTab.id]);
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      continue;
    }

    let tab: WorkspaceTab | undefined;
    if (candidate.kind === "notebook") {
      tab = { id: "notebook", kind: "notebook", title: "Notebook" };
    } else if (candidate.kind === "paper") {
      const paperId = nonEmptyString(candidate.paperId);
      if (paperId) {
        tab = {
          id: `paper:${paperId}`,
          kind: "paper",
          paperId,
          title: nonEmptyString(candidate.title) ?? "Untitled"
        };
      }
    }

    if (tab && !seenIds.has(tab.id)) {
      seenIds.add(tab.id);
      tabs.push(tab);
    }
  }

  return tabs;
}

function normalizePdfViewStates(value: unknown): Record<string, WorkspacePdfViewState> {
  if (!isRecord(value)) {
    return {};
  }

  const states: Record<string, WorkspacePdfViewState> = {};
  for (const [paperId, candidate] of Object.entries(value)) {
    if (!paperId || !isRecord(candidate) || !finiteNumber(candidate.scrollTop)) {
      continue;
    }
    const zoom = finiteNumber(candidate.zoom) && candidate.zoom >= 0.5 && candidate.zoom <= 3
      ? candidate.zoom
      : undefined;
    states[paperId] = {
      scrollTop: Math.max(0, candidate.scrollTop),
      ...(zoom === undefined ? {} : { zoom })
    };
  }
  return states;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
