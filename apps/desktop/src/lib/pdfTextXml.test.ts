import { describe, expect, it } from "vitest";
import { stripNonXmlCharacters } from "./pdfTextXml";

describe("stripNonXmlCharacters", () => {
  it("removes the control characters that abort a strict XML parse", () => {
    // pdftotext emits the raw glyph code for characters with no Unicode mapping,
    // which is how a maths font drops U+0001 into the middle of a page.
    const markup = `<word xMin="1">\u0001</word><word xMin="2">after</word>`;
    expect(stripNonXmlCharacters(markup))
      .toBe(`<word xMin="1"></word><word xMin="2">after</word>`);
    expect(stripNonXmlCharacters("a\u0000b\u0008c\u001Fd\uFFFEe")).toBe("abcde");
  });

  it("keeps the whitespace and text XML does allow", () => {
    expect(stripNonXmlCharacters("tab\there\r\nline")).toBe("tab\there\r\nline");
    expect(stripNonXmlCharacters("\u00e9moji \ud83d\ude42 \u2713")).toBe("\u00e9moji \ud83d\ude42 \u2713");
  });
});
