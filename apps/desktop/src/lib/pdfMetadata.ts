import type { Author, Paper } from "@lumora/shared";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

type PdfInfo = {
  Title?: unknown;
  Author?: unknown;
  Subject?: unknown;
  Keywords?: unknown;
  CreationDate?: unknown;
};

type PdfMetadataResult = {
  patch: Partial<Paper>;
  fields: string[];
};

type PdfTextLine = {
  text: string;
  x: number;
  y: number;
  right: number;
  height: number;
};

type PdfTextItem = {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
};

export async function extractPdfMetadataPatch(fileData: Uint8Array, fileName?: string): Promise<PdfMetadataResult> {
  const loadingTask = getDocument({ data: fileData.slice().buffer });
  const document = await loadingTask.promise;

  try {
    const metadata = await document.getMetadata().catch(() => undefined);
    const info = metadata?.info as PdfInfo | undefined;
    const firstPageLines = await readFirstPageLines(document).catch(() => []);
    const firstPageText = linesToText(firstPageLines);
    const inferredTitle = inferTitleFromFirstPageLines(firstPageLines);
    const title = cleanTitle(readString(info?.Title)) ?? inferredTitle ?? inferTitleFromFileName(fileName);
    const authors = parseAuthors(readString(info?.Author)) || inferAuthorsFromFirstPageLines(firstPageLines, inferredTitle ?? title);
    const abstract = readString(info?.Subject) ?? inferAbstractFromFirstPageLines(firstPageLines);
    const keywords = parseKeywords(readString(info?.Keywords));
    const combinedText = `${title ?? ""}\n${abstract ?? ""}\n${firstPageText}`;
    const year = inferYear(readString(info?.CreationDate), combinedText);
    const doi = inferDoi(combinedText);
    const arxiv = inferArxivId(combinedText);

    const patch: Partial<Paper> = {
      updatedAt: new Date().toISOString()
    };
    const fields: string[] = [];

    if (title) {
      patch.title = title;
      fields.push("title");
    }
    if (authors.length > 0) {
      patch.authors = authors;
      fields.push("authors");
    }
    if (year) {
      patch.year = year;
      fields.push("year");
    }
    if (abstract) {
      patch.abstract = abstract;
      fields.push("abstract");
    }
    if (keywords.length > 0) {
      patch.keywords = keywords;
      fields.push("keywords");
    }
    if (doi) {
      patch.doi = doi;
      fields.push("doi");
    }
    if (arxiv) {
      patch.arxiv = arxiv;
      patch.venue = "arXiv";
      patch.documentType = "preprint";
      fields.push("arxiv");
    }

    return { patch, fields };
  } finally {
    await document.destroy();
  }
}

async function readFirstPageLines(document: Awaited<ReturnType<typeof getDocument>["promise"]>) {
  if (document.numPages < 1) {
    return [];
  }

  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const textItems: PdfTextItem[] = (content.items as unknown[])
    .filter(isPdfTextItem)
    .filter((item) => item.str.trim());
  const items = textItems
    .map((item) => {
      const [, , , , x, y] = item.transform;
      return {
        text: item.str.trim(),
        x,
        y,
        right: x + (item.width ?? 0),
        height: item.height || Math.abs(item.transform[3]) || 10
      };
    })
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: PdfTextLine[] = [];

  for (const item of items) {
    const existing = lines.find((line) => Math.abs(line.y - item.y) <= Math.max(2.5, item.height * 0.35));
    if (!existing) {
      lines.push({
        text: item.text,
        x: item.x,
        y: item.y,
        right: item.right,
        height: item.height
      });
      continue;
    }

    const separator = item.x - existing.right > 7 ? "; " : " ";
    existing.text = `${existing.text}${separator}${item.text}`.replace(/\s+/g, " ").trim();
    existing.x = Math.min(existing.x, item.x);
    existing.right = Math.max(existing.right, item.right);
    existing.height = Math.max(existing.height, item.height);
  }

  return lines
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((line) => ({
      ...line,
      text: normalizeLineText(line.text)
    }))
    .filter((line) => line.text);
}

function readString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed && !looksLikePdfProducer(trimmed) ? trimmed : undefined;
}

function cleanTitle(value?: string) {
  if (!value) {
    return undefined;
  }

  const cleaned = value
    .replace(/\.pdf$/i, "")
    .replace(/_/g, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && !looksLikePdfProducer(cleaned) ? cleaned : undefined;
}

function inferTitleFromFirstPageLines(lines: PdfTextLine[]) {
  const candidateLines = lines
    .slice(0, 12)
    .filter((line) => line.text.length >= 4 && !isFrontMatterNoise(line.text));
  const maxHeight = Math.max(...candidateLines.map((line) => line.height), 0);
  const titleLines = candidateLines
    .filter((line) => line.height >= Math.max(11, maxHeight * 0.82))
    .slice(0, 6);
  const title = joinHyphenatedLines(titleLines.map((line) => line.text));
  return title.length >= 12 && title.length <= 260 ? cleanTitle(title) : undefined;
}

function inferTitleFromFileName(fileName?: string) {
  return cleanTitle(fileName);
}

function parseAuthors(value?: string): Author[] | undefined {
  if (!value) {
    return undefined;
  }

  const authors = value
    .split(/\s*(?:,|;|\band\b|&)\s*/i)
    .flatMap((chunk) => splitAdjacentNames(chunk))
    .map((fullName) => fullName.trim())
    .map((fullName) => fullName.replace(/[∗*†‡§¶]+/g, "").replace(/\d+$/g, "").trim())
    .filter((fullName) => isLikelyAuthorName(fullName))
    .map((fullName) => ({ fullName }));
  return authors.length > 0 ? authors : undefined;
}

function inferAuthorsFromFirstPageLines(lines: PdfTextLine[], title?: string): Author[] {
  const titleLineCount = title ? findTitleLineCount(lines, title) : 0;
  const abstractIndex = lines.findIndex((line) => /^abstract$/i.test(line.text));
  const endIndex = abstractIndex >= 0 ? abstractIndex : Math.min(lines.length, titleLineCount + 12);
  const authorLines = lines
    .slice(titleLineCount, endIndex)
    .filter((line) => !isFrontMatterNoise(line.text))
    .filter((line) => line.height <= 14)
    .map((line) => line.text);
  const authors = parseAuthors(authorLines.join(", "));
  return authors ?? [];
}

function inferAbstractFromFirstPageLines(lines: PdfTextLine[]) {
  const abstractIndex = lines.findIndex((line) => /^abstract$/i.test(line.text));
  if (abstractIndex < 0) {
    return undefined;
  }

  const collected: string[] = [];
  for (const line of lines.slice(abstractIndex + 1)) {
    if (/^\d+\.?\s+[A-Z]/.test(line.text) || /^1\s*$/.test(line.text)) {
      break;
    }
    collected.push(line.text);
  }

  const abstract = joinHyphenatedLines(collected).replace(/\s+/g, " ").trim();
  return abstract.length > 40 ? abstract : undefined;
}

function parseKeywords(value?: string) {
  if (!value) {
    return [];
  }

  return value.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
}

function inferYear(creationDate: string | undefined, text: string) {
  const creationYear = creationDate?.match(/D:(\d{4})/)?.[1] ?? creationDate?.match(/\b(19|20)\d{2}\b/)?.[0];
  const year = creationYear ?? text.match(/\b(19|20)\d{2}\b/)?.[0];
  const parsed = year ? Number.parseInt(year, 10) : undefined;
  return parsed && parsed >= 1900 && parsed <= new Date().getFullYear() + 1 ? parsed : undefined;
}

function inferDoi(text: string) {
  return text.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i)?.[0]?.replace(/[.,;:]$/, "");
}

function inferArxivId(text: string) {
  const modern = text.match(/\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)\b/i)?.[1];
  if (modern) {
    return modern;
  }

  return text.match(/\barXiv:\s*([a-z-]+\/\d{7}(?:v\d+)?)\b/i)?.[1];
}

function linesToText(lines: PdfTextLine[]) {
  return lines.map((line) => line.text).join("\n");
}

function normalizeLineText(value: string) {
  return value.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
  if (!item || typeof item !== "object") {
    return false;
  }

  const candidate = item as Partial<PdfTextItem>;
  return typeof candidate.str === "string" && Array.isArray(candidate.transform);
}

function joinHyphenatedLines(lines: string[]) {
  return lines.reduce((text, line) => {
    if (!text) {
      return line;
    }
    return text.endsWith("-") ? `${text.slice(0, -1)}${line}` : `${text} ${line}`;
  }, "").replace(/\s+/g, " ").trim();
}

function findTitleLineCount(lines: PdfTextLine[], title: string) {
  let accumulated = "";
  for (let index = 0; index < lines.length; index += 1) {
    accumulated = joinHyphenatedLines([accumulated, lines[index].text].filter(Boolean));
    if (normalizeComparable(accumulated) === normalizeComparable(title)) {
      return index + 1;
    }
    if (accumulated.length > title.length + 60) {
      return index + 1;
    }
  }
  return 0;
}

function splitAdjacentNames(value: string) {
  const matches = value.match(/[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}/g);
  return matches && matches.length > 1 ? matches : [value];
}

function isLikelyAuthorName(value: string) {
  if (value.length < 3 || value.length > 80 || looksLikePdfProducer(value)) {
    return false;
  }
  if (/\b(abstract|university|institute|department|laboratory|lab|github|http|www|\.io|\.com)\b/i.test(value)) {
    return false;
  }
  return /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}$/.test(value);
}

function isFrontMatterNoise(value: string) {
  return /^(\d+|abstract|keywords?|index terms?)$/i.test(value)
    || /^(https?:\/\/|www\.|\S+\.(?:io|com|org|edu))/i.test(value)
    || /\b(university|institute|department|laboratory|lab|school|college|corporation|inc\.?|ltd\.?)\b/i.test(value);
}

function normalizeComparable(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function looksLikePdfProducer(value: string) {
  return /^(microsoft word|latex|tex|acrobat|pdf|adobe|preview|quartz|producer|creator)$/i.test(value);
}
