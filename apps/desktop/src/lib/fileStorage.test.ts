import { describe, expect, it } from "vitest";
import type { Paper } from "@lumora/shared";
import { buildPdfFileName, defaultNameTemplate, fileNameMatchesTarget } from "./fileStorage";

const now = "2026-07-10T00:00:00.000Z";

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: "paper-a",
    title: "Attention Is All You Need",
    authors: [{ fullName: "Ashish Vaswani", firstName: "Ashish", lastName: "Vaswani" }],
    year: 2017,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("buildPdfFileName", () => {
  it("fills the default template from paper metadata", () => {
    expect(buildPdfFileName(paper(), defaultNameTemplate)).toBe("Attention Is All You Need-2017-Vaswani.pdf");
  });

  it("falls back to the author's full name when lastName is missing", () => {
    const result = buildPdfFileName(paper({ authors: [{ fullName: "Ashish Vaswani" }] }), "{author}");
    expect(result).toBe("Ashish Vaswani.pdf");
  });

  it("collapses separators left by missing fields", () => {
    const result = buildPdfFileName(paper({ year: undefined, authors: [] }), defaultNameTemplate);
    expect(result).toBe("Attention Is All You Need.pdf");
  });

  it("strips illegal filesystem characters", () => {
    const result = buildPdfFileName(paper({ title: 'GAN: A "New" Approach? <v2>' }), "{title}");
    expect(result).toBe("GAN A New Approach v2.pdf");
  });

  it("keeps CJK characters intact", () => {
    const result = buildPdfFileName(paper({ title: "注意力就是一切", authors: [{ fullName: "王小明" }], year: 2020 }), defaultNameTemplate);
    expect(result).toBe("注意力就是一切-2020-王小明.pdf");
  });

  it("caps very long names and still appends .pdf", () => {
    const result = buildPdfFileName(paper({ title: "A".repeat(300) }), "{title}");
    expect(result.length).toBeLessThanOrEqual(124);
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("falls back to a stable name when the template resolves to nothing", () => {
    const result = buildPdfFileName(paper({ title: "???", year: undefined, authors: [] }), "{year}");
    expect(result).toBe("paper.pdf");
  });
});

describe("fileNameMatchesTarget", () => {
  it("matches exact names and collision-suffixed names", () => {
    expect(fileNameMatchesTarget("a-2017.pdf", "a-2017.pdf")).toBe(true);
    expect(fileNameMatchesTarget("a-2017-2.pdf", "a-2017.pdf")).toBe(true);
    expect(fileNameMatchesTarget("a-2017-12.pdf", "a-2017.pdf")).toBe(true);
  });

  it("rejects different names", () => {
    expect(fileNameMatchesTarget("b-2017.pdf", "a-2017.pdf")).toBe(false);
    expect(fileNameMatchesTarget("a-2018.pdf", "a-2017.pdf")).toBe(false);
  });
});
