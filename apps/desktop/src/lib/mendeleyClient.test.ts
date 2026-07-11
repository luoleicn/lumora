import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryState, Paper } from "@lumora/shared";
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import {
  localAnnotationToMendeley,
  MendeleySyncCancelledError,
  mendeleyAnnotationToLocal,
  mendeleyDocumentToPaper,
  mergeBackgroundSyncState,
  paperToMendeleyDocument,
  syncWithMendeley,
  type MendeleyDocument
} from "./mendeleyClient";

const now = "2026-07-10T00:00:00.000Z";

beforeEach(() => {
  invokeMock.mockReset();
});

const remoteDocument: MendeleyDocument = {
  id: "md-1",
  title: "Attention Is All You Need",
  type: "conference_proceedings",
  authors: [{ first_name: "Ashish", last_name: "Vaswani" }],
  year: 2017,
  source: "NeurIPS",
  abstract: "Transformers.",
  identifiers: { doi: "10.1000/xyz", arxiv: "1706.03762v5" },
  keywords: ["attention"],
  tags: ["ml"],
  pages: "1-15",
  volume: "30",
  websites: ["https://example.test/paper"],
  starred: true,
  read: true,
  created: "2020-01-01T00:00:00.000Z",
  last_modified: "2021-01-01T00:00:00.000Z"
};

describe("mendeleyDocumentToPaper", () => {
  it("maps a remote document to a new paper", () => {
    const paper = mendeleyDocumentToPaper(remoteDocument);

    expect(paper.title).toBe("Attention Is All You Need");
    expect(paper.mendeleyId).toBe("md-1");
    expect(paper.documentType).toBe("conferencePaper");
    expect(paper.authors).toEqual([{ firstName: "Ashish", lastName: "Vaswani", fullName: "Ashish Vaswani" }]);
    expect(paper.arxiv).toBe("1706.03762v5");
    expect(paper.venue).toBe("NeurIPS");
    expect(paper.pages).toBe("1-15");
    expect(paper.websites).toEqual(["https://example.test/paper"]);
    expect(paper.favorite).toBe(true);
    expect(paper.unread).toBe(false);
    expect(paper.source).toBe("mendeley");
    expect(paper.createdAt).toBe("2020-01-01T00:00:00.000Z");
    expect(paper.updatedAt).toBe("2021-01-01T00:00:00.000Z");
    expect(paper.deletedAt).toBeUndefined();
  });

  it("preserves the local id and fills gaps when merging into an existing paper", () => {
    const existing: Paper = {
      id: "paper-local",
      title: "Old Title",
      authors: [],
      favorite: true,
      createdAt: now,
      updatedAt: now
    };

    const merged = mendeleyDocumentToPaper({ ...remoteDocument, abstract: undefined }, existing);

    expect(merged.id).toBe("paper-local");
    expect(merged.title).toBe("Attention Is All You Need");
    expect(merged.abstract).toBeUndefined();
    expect(merged.favorite).toBe(true);
    expect(merged.mendeleyId).toBe("md-1");
  });
});

describe("Mendeley annotations", () => {
  it("preserves PDF point positions and maps them to a visible local annotation", () => {
    const annotation = mendeleyAnnotationToLocal({
      id: "ma-1",
      type: "highlight",
      document_id: "md-1",
      filehash: "sha1",
      text: "important",
      color: { r: 255, g: 128, b: 0 },
      positions: [{
        page: 2,
        top_left: { x: 61.2, y: 712.8 },
        bottom_right: { x: 122.4, y: 633.6 }
      }]
    }, "paper-1", "file-1");

    expect(annotation.pageIndex).toBe(1);
    expect(annotation.color).toBe("#ff8000");
    expect(annotation.rects[0].x).toBeCloseTo(0.1);
    expect(annotation.rects[0].y).toBeCloseTo(0.1);
    expect(annotation.rects[0].width).toBeCloseTo(0.1);
    expect(annotation.rects[0].height).toBeCloseTo(0.1);
    expect(annotation.mendeleyPositions?.[0].page).toBe(2);

    const remote = localAnnotationToMendeley(annotation, { ...mendeleyDocumentToPaper(remoteDocument), id: "paper-1" });
    expect(remote.positions?.[0].top_left).toEqual({ x: 61.2, y: 712.8 });
    expect(remote.filehash).toBe("sha1");
  });

  it("maps native Mendeley corners, which store the smaller y in top_left, to a full-height block", () => {
    const annotation = mendeleyAnnotationToLocal({
      id: "ma-2",
      type: "highlight",
      document_id: "md-1",
      color: { r: 255, g: 245, b: 173 },
      positions: [{
        page: 1,
        top_left: { x: 180.2, y: 359.7 },
        bottom_right: { x: 280.1, y: 371.1 }
      }]
    }, "paper-1", "file-1");

    const rect = annotation.rects[0];
    expect(rect.x).toBeCloseTo(180.2 / 612);
    expect(rect.y).toBeCloseTo(1 - 371.1 / 792);
    expect(rect.width).toBeCloseTo((280.1 - 180.2) / 612);
    expect(rect.height).toBeCloseTo((371.1 - 359.7) / 792);
  });
});

describe("syncWithMendeley", () => {
  it("retries annotations with a smaller page when Mendeley rejects the requested size", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "db_get_meta") return null;
      if (command === "db_set_meta") return undefined;
      if (command !== "mendeley_request") throw new Error(`Unexpected command: ${command}`);
      const path = String(args?.path);
      if (path.startsWith("/trash")) return { status: 404, body: "not available" };
      if (path.startsWith("/annotations?limit=200")) {
        return { status: 400, body: '{"message":"Requested page size is too large."}' };
      }
      return { status: 200, body: "[]" };
    });

    await syncWithMendeley({
      papers: [], fileAssets: [], collections: [], paperCollections: [], annotations: []
    }, { clientId: "id", clientSecret: "secret" }, { nameTemplate: "{title}-{year}-{author}" });

    expect(invokeMock.mock.calls.some(([, args]) => String(args?.path).startsWith("/annotations?limit=100"))).toBe(true);
  });

  it("continues when Mendeley does not expose its documented trash service", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "db_get_meta") return null;
      if (command === "db_set_meta") return undefined;
      if (command === "mendeley_request") {
        const path = String(args?.path);
        if (path.startsWith("/trash")) {
          return { status: 404, body: '{"message":"No service found for your request"}' };
        }
        return { status: 200, body: "[]" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await syncWithMendeley({
      papers: [], fileAssets: [], collections: [], paperCollections: [], annotations: []
    }, { clientId: "id", clientSecret: "secret" }, { nameTemplate: "{title}-{year}-{author}" });

    expect(result.summary.unavailableResources).toEqual(["trash"]);
    expect(result.state.papers).toEqual([]);
  });

  it("keeps edits made while a background sync is running", () => {
    const basePaper: Paper = { id: "p1", title: "Before", authors: [], createdAt: now, updatedAt: now };
    const empty = { fileAssets: [], collections: [], paperCollections: [], annotations: [] };
    const merged = mergeBackgroundSyncState(
      { ...empty, papers: [basePaper] },
      { ...empty, papers: [
        { ...basePaper, title: "Remote", updatedAt: "2026-07-10T00:00:01.000Z" },
        { ...basePaper, id: "p2", title: "Remote new", updatedAt: "2026-07-10T00:00:01.000Z" }
      ] },
      { ...empty, papers: [{ ...basePaper, title: "Edited while syncing", updatedAt: "2026-07-10T00:00:03.000Z" }] },
      "2026-07-10T00:00:02.000Z"
    );

    expect(merged.papers.find((paper) => paper.id === "p1")?.title).toBe("Edited while syncing");
    expect(merged.papers.find((paper) => paper.id === "p2")?.title).toBe("Remote new");
  });

  it("publishes folders and membership before PDF download and then honors cancellation", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "db_get_meta") return null;
      if (command !== "mendeley_request") throw new Error(`Unexpected command: ${command}`);
      const path = String(args?.path);
      if (path.startsWith("/documents?")) return { status: 200, body: JSON.stringify([remoteDocument]) };
      if (path.startsWith("/trash")) return { status: 404, body: "not available" };
      if (path === "/folders?limit=500") return { status: 200, body: JSON.stringify([{ id: "mf-1", name: "Research" }]) };
      if (path === "/files?limit=500") return { status: 200, body: JSON.stringify([{
        id: "file-remote", document_id: "md-1", file_name: "paper.pdf", mime_type: "application/pdf", filehash: "sha1", size: 12
      }]) };
      if (path.startsWith("/annotations?")) return { status: 200, body: "[]" };
      if (path === "/folders/mf-1/documents?limit=500") return { status: 200, body: JSON.stringify([{ id: "md-1" }]) };
      throw new Error(`Unexpected path: ${path}`);
    });

    let cancelled = false;
    let partialState: LibraryState | undefined;
    const task = syncWithMendeley(
      { papers: [], fileAssets: [], collections: [], paperCollections: [], annotations: [] },
      { clientId: "id", clientSecret: "secret" },
      { nameTemplate: "{title}-{year}-{author}" },
      undefined,
      {
        isCancelled: () => cancelled,
        onStateUpdate: (state) => {
          partialState = state;
          if (state.paperCollections.length > 0) cancelled = true;
        }
      }
    );

    await expect(task).rejects.toBeInstanceOf(MendeleySyncCancelledError);
    expect(partialState?.collections.map((folder) => folder.name)).toContain("Research");
    expect(partialState?.paperCollections).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([command]) => command === "mendeley_download_file")).toBe(false);
  });

  it("only pulls changes since the stored cursor on subsequent syncs", async () => {
    const cursor = "2026-07-01T00:00:00.000Z";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "db_get_meta") return cursor;
      if (command === "db_set_meta") return undefined;
      if (command !== "mendeley_request") throw new Error(`Unexpected command: ${command}`);
      const path = String(args?.path);
      if (path === "/folders?limit=500") {
        return { status: 200, body: JSON.stringify([{ id: "mf-1", name: "Research", modified: "2026-06-01T00:00:00.000Z" }]) };
      }
      return { status: 200, body: "[]" };
    });

    const result = await syncWithMendeley({
      papers: [{ id: "p1", title: "T", authors: [], mendeleyId: "md-1", createdAt: now, updatedAt: "2026-06-01T00:00:00.000Z" }],
      fileAssets: [{
        id: "f1", paperId: "p1", sha256: "abc", size: 1, mime: "application/pdf", fileName: "a.pdf",
        mendeleyId: "file-1", downloadState: "local", createdAt: now, updatedAt: "2026-06-01T00:00:00.000Z"
      }],
      collections: [{ id: "col-1", name: "Research", mendeleyId: "mf-1", sortOrder: 0, createdAt: now, updatedAt: "2026-06-01T00:00:00.000Z" }],
      paperCollections: [{
        id: "rel-1", paperId: "p1", collectionId: "col-1", mendeleyId: "mendeley_relation_mf-1_md-1",
        createdAt: now, updatedAt: "2026-06-01T00:00:00.000Z"
      }],
      annotations: []
    }, { clientId: "id", clientSecret: "secret" }, { nameTemplate: "{title}-{year}-{author}" });

    const since = encodeURIComponent(cursor);
    const paths = invokeMock.mock.calls
      .filter(([command]) => command === "mendeley_request")
      .map(([, args]) => String((args as Record<string, unknown>)?.path));
    expect(paths).toContain(`/documents?limit=500&view=all&modified_since=${since}`);
    expect(paths).toContain(`/trash?limit=500&view=all&modified_since=${since}`);
    expect(paths).toContain(`/files?limit=500&added_since=${since}`);
    expect(paths).toContain(`/files?limit=500&deleted_since=${since}`);
    expect(paths.some((path) => path.startsWith("/folders/mf-1/documents"))).toBe(false);
    expect(result.state.fileAssets[0].deletedAt).toBeUndefined();
    expect(result.state.paperCollections[0].deletedAt).toBeUndefined();
    expect(result.summary.pushed).toBe(0);
  });

  it("applies membership removals for folders modified since the cursor", async () => {
    const cursor = "2026-07-01T00:00:00.000Z";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "db_get_meta") return cursor;
      if (command === "db_set_meta") return undefined;
      if (command !== "mendeley_request") throw new Error(`Unexpected command: ${command}`);
      const path = String(args?.path);
      if (path === "/folders?limit=500") {
        return { status: 200, body: JSON.stringify([{ id: "mf-1", name: "Research", modified: "2026-07-05T00:00:00.000Z" }]) };
      }
      return { status: 200, body: "[]" };
    });

    const result = await syncWithMendeley({
      papers: [{ id: "p1", title: "T", authors: [], mendeleyId: "md-1", createdAt: now, updatedAt: "2026-06-01T00:00:00.000Z" }],
      fileAssets: [],
      collections: [{ id: "col-1", name: "Research", mendeleyId: "mf-1", sortOrder: 0, createdAt: now, updatedAt: "2026-06-01T00:00:00.000Z" }],
      paperCollections: [{
        id: "rel-1", paperId: "p1", collectionId: "col-1", mendeleyId: "mendeley_relation_mf-1_md-1",
        createdAt: now, updatedAt: "2026-06-01T00:00:00.000Z"
      }],
      annotations: []
    }, { clientId: "id", clientSecret: "secret" }, { nameTemplate: "{title}-{year}-{author}" });

    expect(invokeMock.mock.calls.some(([, args]) =>
      String((args as Record<string, unknown>)?.path).startsWith("/folders/mf-1/documents")
    )).toBe(true);
    expect(result.state.paperCollections[0].deletedAt).toBeDefined();
  });

  it("does not POST folder membership that was just pulled from Mendeley", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "db_get_meta") return null;
      if (command === "db_set_meta") return undefined;
      if (command !== "mendeley_request") throw new Error(`Unexpected command: ${command}`);
      const path = String(args?.path);
      if (path.startsWith("/documents?")) return { status: 200, body: JSON.stringify([remoteDocument]) };
      if (path.startsWith("/trash")) return { status: 404, body: "not available" };
      if (path === "/folders?limit=500") return { status: 200, body: JSON.stringify([{ id: "mf-1", name: "Research" }]) };
      if (path === "/files?limit=500" || path.startsWith("/annotations?")) return { status: 200, body: "[]" };
      if (path === "/folders/mf-1/documents?limit=500") return { status: 200, body: JSON.stringify([{ id: "md-1" }]) };
      throw new Error(`Unexpected path: ${path}`);
    });

    const result = await syncWithMendeley({
      papers: [], fileAssets: [], collections: [], paperCollections: [], annotations: []
    }, { clientId: "id", clientSecret: "secret" }, { nameTemplate: "{title}-{year}-{author}" });

    expect(result.state.paperCollections).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([command, args]) =>
      command === "mendeley_request"
      && args?.method === "POST"
      && args?.path === "/folders/mf-1/documents"
    )).toBe(false);
  });
});

describe("paperToMendeleyDocument", () => {
  it("maps a paper to the Mendeley document shape", () => {
    const paper: Paper = {
      id: "paper-a",
      title: "My Paper",
      authors: [{ fullName: "Jane Van Doe" }],
      year: 2024,
      venue: "ICML",
      doi: "10.1/abc",
      documentType: "preprint",
      tags: ["x"],
      keywords: [],
      createdAt: now,
      updatedAt: now
    };

    const document = paperToMendeleyDocument(paper);

    expect(document.type).toBe("working_paper");
    expect(document.authors).toEqual([{ first_name: "Jane Van", last_name: "Doe" }]);
    expect(document.identifiers).toEqual({ doi: "10.1/abc" });
    expect(document.keywords).toBeUndefined();
    expect(document.tags).toEqual(["x"]);
  });

  it("falls back to generic for unmapped document types", () => {
    const paper: Paper = { id: "p", title: "T", authors: [], createdAt: now, updatedAt: now };
    expect(paperToMendeleyDocument(paper).type).toBe("generic");
  });
});
