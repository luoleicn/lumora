import { describe, expect, it } from "vitest";
import { detectTextUrlLinks, normalizeDetectedUrl, type PdfTextWord } from "./pdfTextLinks";
import type { NativePdfLink } from "./nativePdfRenderer";

function word(text: string, overrides: Partial<PdfTextWord> = {}): PdfTextWord {
  return { text, x: 0.2, y: 0.3, width: 0.25, height: 0.012, ...overrides };
}

describe("normalizeDetectedUrl", () => {
  it("accepts the web URLs papers print as plain text", () => {
    expect(normalizeDetectedUrl("https://pku-epic.github.io/LDA")).toBe("https://pku-epic.github.io/LDA");
    expect(normalizeDetectedUrl("http://dx.doi.org/10.1109/LRA.2025.3544909"))
      .toBe("http://dx.doi.org/10.1109/LRA.2025.3544909");
    expect(normalizeDetectedUrl("www.example.com/paper")).toBe("https://www.example.com/paper");
  });

  it("rejects prose, non-web schemes and hostless URLs", () => {
    expect(normalizeDetectedUrl("Code")).toBeUndefined();
    expect(normalizeDetectedUrl("mailto:someone@example.com")).toBeUndefined();
    expect(normalizeDetectedUrl("file:///etc/passwd")).toBeUndefined();
    expect(normalizeDetectedUrl("javascript:alert(1)")).toBeUndefined();
    // A hostname without a dot reads as a word, not a destination.
    expect(normalizeDetectedUrl("http://localhost")).toBeUndefined();
    expect(normalizeDetectedUrl("https://example.com two")).toBeUndefined();
  });
});

describe("detectTextUrlLinks", () => {
  it("recovers a URL that the PDF only draws as coloured text", () => {
    const links = detectTextUrlLinks([
      word("Code"),
      word("Data:"),
      word("https://pku-epic.github.io/LDA", { x: 0.31, y: 0.233, width: 0.19, height: 0.01 })
    ]);

    expect(links).toEqual([{
      x: 0.31,
      y: 0.233,
      width: 0.19,
      height: 0.01,
      target: { kind: "external", url: "https://pku-epic.github.io/LDA" }
    }]);
  });

  it("drops sentence punctuation without dropping brackets the URL opened", () => {
    const [sentence] = detectTextUrlLinks([word("https://example.com/paper.", { width: 0.26 })]);
    expect(sentence.target).toEqual({ kind: "external", url: "https://example.com/paper" });
    // The hit region shrinks with the trimmed text instead of covering the period.
    expect(sentence.width).toBeLessThan(0.26);

    const [bracketed] = detectTextUrlLinks([word("https://en.wikipedia.org/wiki/Foo_(bar)")]);
    expect(bracketed.target).toEqual({
      kind: "external",
      url: "https://en.wikipedia.org/wiki/Foo_(bar)"
    });

    const [bracketedWhole] = detectTextUrlLinks([word("(https://example.com/x)", { x: 0.2, width: 0.23 })]);
    expect(bracketedWhole.target).toEqual({ kind: "external", url: "https://example.com/x" });
    // The region starts after the opening bracket rather than on it.
    expect(bracketedWhole.x).toBeGreaterThan(0.2);
    expect(bracketedWhole.x + bracketedWhole.width).toBeLessThan(0.43);
  });

  it("leaves URLs that already have a link annotation to the annotation", () => {
    const annotated: NativePdfLink[] = [{
      x: 0.19,
      y: 0.29,
      width: 0.3,
      height: 0.02,
      target: { kind: "external", url: "https://arxiv.org/abs/2509.23655" }
    }];

    expect(detectTextUrlLinks([word("https://arxiv.org/abs/2509.23655")], annotated)).toEqual([]);
  });

  it("ignores words with an unusable box", () => {
    expect(detectTextUrlLinks([
      word("https://example.com/a", { width: 0 }),
      word("https://example.com/b", { height: Number.NaN })
    ])).toEqual([]);
  });
});
