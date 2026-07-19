import type { LibraryState } from "@lumora/shared";
import { describe, expect, it } from "vitest";
import {
  createDefaultWorkspaceSession,
  loadWorkspaceSession,
  parseWorkspaceSession,
  reconcileWorkspaceSession,
  saveWorkspaceSession,
  workspaceSessionKey,
  type WorkspaceSessionV1
} from "./workspaceSession";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(workspaceSessionKey, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

const session: WorkspaceSessionV1 = {
  version: 1,
  tabs: [
    { id: "documents", kind: "documents", title: "Documents" },
    { id: "paper:paper-a", kind: "paper", paperId: "paper-a", title: "Old title" },
    { id: "notebook", kind: "notebook", title: "Notebook" }
  ],
  activeTabId: "paper:paper-a",
  selectedCollectionId: "collection-a",
  selectedPaperId: "paper-a",
  pdfViewStates: {
    "paper-a": { scrollTop: 420, zoom: 1.25 },
    missing: { scrollTop: 10 }
  }
};

const library: LibraryState = {
  papers: [
    { id: "paper-a", title: "Current title", authors: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    { id: "deleted", title: "Deleted", authors: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", deletedAt: "2026-01-02" }
  ],
  fileAssets: [],
  collections: [
    { id: "collection-a", name: "A", sortOrder: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" }
  ],
  paperCollections: [],
  annotations: []
};

describe("workspace session", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    saveWorkspaceSession(session, storage);
    expect(loadWorkspaceSession(storage)).toEqual(session);
  });

  it("falls back for malformed or unknown session data", () => {
    expect(parseWorkspaceSession("not-json")).toEqual(createDefaultWorkspaceSession());
    expect(parseWorkspaceSession('{"version":2}')).toEqual(createDefaultWorkspaceSession());
  });

  it("normalizes duplicate tabs, IDs, and unsafe PDF view state", () => {
    const parsed = parseWorkspaceSession(JSON.stringify({
      version: 1,
      tabs: [
        { kind: "paper", id: "forged", paperId: "paper-a", title: "A" },
        { kind: "paper", paperId: "paper-a", title: "Duplicate" },
        { kind: "notebook" },
        { kind: "notebook" }
      ],
      activeTabId: "forged",
      selectedCollectionId: "",
      pdfViewStates: {
        "paper-a": { scrollTop: -20, zoom: 9 },
        bad: { scrollTop: "nope" }
      }
    }));

    expect(parsed.tabs.map((tab) => tab.id)).toEqual(["documents", "paper:paper-a", "notebook"]);
    expect(parsed.activeTabId).toBe("documents");
    expect(parsed.selectedCollectionId).toBe("all");
    expect(parsed.pdfViewStates).toEqual({ "paper-a": { scrollTop: 0 } });
  });

  it("reconciles session references against the loaded library", () => {
    const reconciled = reconcileWorkspaceSession(session, library);
    expect(reconciled.tabs[1]).toMatchObject({ paperId: "paper-a", title: "Current title" });
    expect(reconciled.activeTabId).toBe("paper:paper-a");
    expect(reconciled.selectedPaperId).toBe("paper-a");
    expect(reconciled.selectedCollectionId).toBe("collection-a");
    expect(reconciled.pdfViewStates).toEqual({ "paper-a": { scrollTop: 420, zoom: 1.25 } });
  });

  it("falls back when the active paper and collection were removed", () => {
    const reconciled = reconcileWorkspaceSession({
      ...session,
      tabs: [...session.tabs, { id: "paper:missing", kind: "paper", paperId: "missing", title: "Missing" }],
      activeTabId: "paper:missing",
      selectedCollectionId: "missing-collection",
      selectedPaperId: "missing"
    }, library);

    expect(reconciled.tabs.some((tab) => tab.id === "paper:missing")).toBe(false);
    expect(reconciled.activeTabId).toBe("documents");
    expect(reconciled.selectedCollectionId).toBe("all");
    expect(reconciled.selectedPaperId).toBeUndefined();
  });
});
