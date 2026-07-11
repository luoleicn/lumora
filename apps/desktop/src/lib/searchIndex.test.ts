import { describe, expect, it } from "vitest";
import type { FileAsset, LibraryState, Paper } from "@lumora/shared";
import {
  collapseCjkSpaces,
  mapHitsToPapers,
  planBodyBackfill,
  splitSnippet,
  SNIPPET_HIGHLIGHT_END,
  SNIPPET_HIGHLIGHT_START,
  type SearchHit
} from "./searchIndex";

const now = "2026-07-11T00:00:00.000Z";
const earlier = "2026-07-01T00:00:00.000Z";

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return { id, title: `Paper ${id}`, authors: [], createdAt: now, updatedAt: now, ...overrides };
}

function pdfAsset(id: string, paperId: string, overrides: Partial<FileAsset> = {}): FileAsset {
  return {
    id,
    paperId,
    sha256: `sha-${id}`,
    size: 10,
    mime: "application/pdf",
    fileName: `${id}.pdf`,
    downloadState: "local",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function state(papers: Paper[], fileAssets: FileAsset[]): LibraryState {
  return { papers, fileAssets, collections: [], paperCollections: [], annotations: [] };
}

function hit(paperId: string): SearchHit {
  return { paperId, tier: 1, score: -1, matchedFields: ["title"], snippet: "" };
}

describe("planBodyBackfill", () => {
  it("includes papers whose PDF is unindexed or whose sha changed, newest first", () => {
    const library = state(
      [paper("stale"), paper("fresh", { updatedAt: earlier }), paper("indexed")],
      [pdfAsset("f1", "stale"), pdfAsset("f2", "fresh"), pdfAsset("f3", "indexed")]
    );
    const status = [
      { paperId: "stale", bodySha: "outdated" },
      { paperId: "indexed", bodySha: "sha-f3" }
    ];

    const planned = planBodyBackfill(library, status);
    expect(planned.map((item) => item.paperId)).toEqual(["stale", "fresh"]);
    expect(planned[0].fileAsset.id).toBe("f1");
  });

  it("skips deleted papers, deleted or remote files, and non-PDF assets", () => {
    const library = state(
      [paper("trashed", { deletedAt: now }), paper("remote"), paper("gone"), paper("word")],
      [
        pdfAsset("f1", "trashed"),
        pdfAsset("f2", "remote", { downloadState: "remote" }),
        pdfAsset("f3", "gone", { deletedAt: now }),
        pdfAsset("f4", "word", { mime: "application/msword", fileName: "f4.doc" })
      ]
    );

    expect(planBodyBackfill(library, [])).toEqual([]);
  });
});

describe("mapHitsToPapers", () => {
  it("preserves hit order and drops deleted or unknown papers", () => {
    const papers = [paper("a"), paper("b", { deletedAt: now }), paper("c")];
    const hits = [hit("c"), hit("b"), hit("missing"), hit("a")];

    expect(mapHitsToPapers(hits, papers).map((item) => item.id)).toEqual(["c", "a"]);
  });
});

describe("splitSnippet", () => {
  it("splits highlight markers into segments", () => {
    expect(splitSnippet(`…the ${SNIPPET_HIGHLIGHT_START}quantum${SNIPPET_HIGHLIGHT_END} leap`)).toEqual([
      { text: "…the ", highlighted: false },
      { text: "quantum", highlighted: true },
      { text: " leap", highlighted: false }
    ]);
  });

  it("handles marker-free and empty snippets", () => {
    expect(splitSnippet("plain")).toEqual([{ text: "plain", highlighted: false }]);
    expect(splitSnippet("")).toEqual([]);
  });
});

describe("collapseCjkSpaces", () => {
  it("removes the spaces injected by index-time CJK segmentation", () => {
    expect(collapseCjkSpaces("机 器 学 习")).toBe("机器学习");
    expect(collapseCjkSpaces("GPT 模 型")).toBe("GPT 模型");
    expect(collapseCjkSpaces("注 意 力 is all you need")).toBe("注意力 is all you need");
  });

  it("leaves latin-only text untouched", () => {
    expect(collapseCjkSpaces("attention is all you need")).toBe("attention is all you need");
  });

  it("collapses across snippet highlight boundaries", () => {
    const marked = `的 ${SNIPPET_HIGHLIGHT_START}注 意 力${SNIPPET_HIGHLIGHT_END} 机 制`;
    expect(collapseCjkSpaces(marked)).toBe(`的${SNIPPET_HIGHLIGHT_START}注意力${SNIPPET_HIGHLIGHT_END}机制`);
  });
});
