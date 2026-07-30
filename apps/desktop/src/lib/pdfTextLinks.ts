import type { NativePdfLink } from "./nativePdfRenderer";

/**
 * A word box from the native text layer, in page fractions (0..1).
 */
export type PdfTextWord = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const maxDetectedLinksPerPage = 200;
// Trailing characters that end a sentence rather than the URL. Closing brackets
// are only dropped when the URL does not open them itself, so
// `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its parenthesis.
const trailingPunctuation = new Set([".", ",", ";", ":", "!", "?", "。", "，", "'", '"', "”", "’"]);
const closingBrackets: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Many papers print a project or dataset URL as plain coloured text without a
 * link annotation — the LaTeX source used \textcolor instead of \url — so the
 * PDF carries nothing for the link layer to render. Recover those from the text
 * layer the same way a browser's PDF viewer does.
 */
export function detectTextUrlLinks(
  words: PdfTextWord[],
  annotatedLinks: NativePdfLink[] = []
): NativePdfLink[] {
  const links: NativePdfLink[] = [];
  for (const word of words) {
    if (links.length >= maxDetectedLinksPerPage) {
      break;
    }
    if (!isUsableRect(word)) {
      continue;
    }
    const token = word.text.trim();
    const leading = countLeadingOpeners(token);
    const trimmed = trimUrlToken(token.slice(leading));
    const url = normalizeDetectedUrl(trimmed);
    if (!url) {
      continue;
    }
    // hyperref already produced a real annotation for most URLs; a second hit
    // region stacked on the first one would only steal its clicks.
    if (annotatedLinks.some((link) => overlapsCentre(word, link))) {
      continue;
    }
    links.push({
      // Dropped punctuation is not part of the link, so move and shrink the hit
      // region by the share of the word each side represented.
      ...sliceRect(word, leading / token.length, trimmed.length / token.length),
      target: { kind: "external", url }
    });
  }
  return links;
}

export function normalizeDetectedUrl(token: string): string | undefined {
  if (!/^(https?:\/\/|www\.)/i.test(token) || /\s/.test(token) || token.length > 2048) {
    return undefined;
  }
  const candidate = /^www\./i.test(token) ? `https://${token}` : token;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  // A hostname without a dot is a bare word like `http://example`, which is far
  // more likely to be prose than a destination worth opening.
  if (!url.hostname.includes(".") || url.hostname.endsWith(".")) {
    return undefined;
  }
  return url.href;
}

function trimUrlToken(token: string): string {
  let end = token.length;
  while (end > 0) {
    const character = token[end - 1];
    if (trailingPunctuation.has(character)) {
      end -= 1;
      continue;
    }
    const opening = closingBrackets[character];
    if (opening && countOf(token.slice(0, end), opening) < countOf(token.slice(0, end), character)) {
      end -= 1;
      continue;
    }
    break;
  }
  return token.slice(0, end);
}

function countOf(value: string, character: string): number {
  let total = 0;
  for (const entry of value) {
    if (entry === character) {
      total += 1;
    }
  }
  return total;
}

function countLeadingOpeners(token: string): number {
  const match = /^[([{"'“‘]+/.exec(token);
  return match ? match[0].length : 0;
}

function sliceRect(
  word: PdfTextWord,
  startRatio: number,
  lengthRatio: number
): Omit<NativePdfLink, "target"> {
  const start = Math.min(0.9, Math.max(0, startRatio));
  const length = Math.min(1 - start, Math.max(0.1, lengthRatio));
  return {
    x: word.x + word.width * start,
    y: word.y,
    width: word.width * length,
    height: word.height
  };
}

function isUsableRect(word: PdfTextWord): boolean {
  return [word.x, word.y, word.width, word.height].every(Number.isFinite)
    && word.width > 0
    && word.height > 0;
}

function overlapsCentre(word: PdfTextWord, link: NativePdfLink): boolean {
  const centreX = word.x + word.width / 2;
  const centreY = word.y + word.height / 2;
  return centreX >= link.x
    && centreX <= link.x + link.width
    && centreY >= link.y
    && centreY <= link.y + link.height;
}
