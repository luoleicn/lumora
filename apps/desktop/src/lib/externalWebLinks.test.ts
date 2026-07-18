import { describe, expect, it } from "vitest";
import { normalizeExternalWebUrl } from "./externalWebLinks";

describe("normalizeExternalWebUrl", () => {
  it("normalizes absolute web links", () => {
    expect(normalizeExternalWebUrl("https://example.com/paper?section=2"))
      .toBe("https://example.com/paper?section=2");
  });

  it("allows http links but rejects non-web protocols", () => {
    expect(normalizeExternalWebUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeExternalWebUrl("mailto:reader@example.com")).toBeUndefined();
    expect(normalizeExternalWebUrl("javascript:alert(1)")).toBeUndefined();
  });

  it("leaves PDF-internal destinations to PDF.js", () => {
    expect(normalizeExternalWebUrl("#page=12")).toBeUndefined();
    expect(normalizeExternalWebUrl("#cite.bib7")).toBeUndefined();
    expect(normalizeExternalWebUrl("")).toBeUndefined();
    expect(normalizeExternalWebUrl("/reader#page=12")).toBeUndefined();
  });
});
