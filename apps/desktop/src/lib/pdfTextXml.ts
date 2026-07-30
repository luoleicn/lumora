// XML 1.0 forbids most control characters, and pdftotext copies unmapped glyphs
// (maths fonts, in practice) through verbatim. A strict DOM parser treats the
// first one as fatal: it keeps the prefix it already built and drops every later
// word, so a single stray byte can silently cost a page half its text layer.
// Tab, newline and carriage return are the only control characters XML allows.
const nonXmlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function stripNonXmlCharacters(markup: string): string {
  return markup.replace(nonXmlCharacters, "");
}

/**
 * True when the parsed document is the browser's "this XML is broken" report
 * rather than the requested content. WebKit and Blink both keep the partially
 * built tree alongside it, which is exactly the case worth noticing: the layer
 * would look fine while missing everything past the error.
 */
export function hasXmlParseError(document: Document): boolean {
  return document.querySelector("parsererror") !== null;
}
