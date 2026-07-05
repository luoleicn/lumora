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

export async function extractPdfMetadataPatch(fileData: Uint8Array, fileName?: string): Promise<PdfMetadataResult> {
  const loadingTask = getDocument({ data: fileData.slice().buffer });
  const document = await loadingTask.promise;

  try {
    const metadata = await document.getMetadata().catch(() => undefined);
    const info = metadata?.info as PdfInfo | undefined;
    const firstPageText = await readFirstPageText(document).catch(() => "");
    const title = cleanTitle(readString(info?.Title)) ?? inferTitleFromFirstPage(firstPageText) ?? inferTitleFromFileName(fileName);
    const authors = parseAuthors(readString(info?.Author) ?? inferAuthorsFromFirstPage(firstPageText));
    const abstract = readString(info?.Subject);
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

async function readFirstPageText(document: Awaited<ReturnType<typeof getDocument>["promise"]>) {
  if (document.numPages < 1) {
    return "";
  }

  const page = await document.getPage(1);
  const content = await page.getTextContent();
  return content.items
    .map((item) => "str" in item ? item.str : "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && !looksLikePdfProducer(cleaned) ? cleaned : undefined;
}

function inferTitleFromFirstPage(text: string) {
  const firstSentence = text
    .split(/\s{2,}|\n/)
    .map((line) => line.trim())
    .find((line) => line.length >= 12 && line.length <= 220 && !/^arxiv:/i.test(line));
  return cleanTitle(firstSentence);
}

function inferTitleFromFileName(fileName?: string) {
  return cleanTitle(fileName);
}

function parseAuthors(value?: string): Author[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\s*(?:,|;|\band\b|&)\s*/i)
    .map((fullName) => fullName.trim())
    .filter((fullName) => fullName.length > 1 && !looksLikePdfProducer(fullName))
    .map((fullName) => ({ fullName }));
}

function inferAuthorsFromFirstPage(text: string) {
  const title = inferTitleFromFirstPage(text);
  if (!title) {
    return undefined;
  }

  const afterTitle = text.slice(text.indexOf(title) + title.length, text.indexOf(title) + title.length + 360);
  const match = afterTitle.match(/([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}(?:\s*(?:,|and|&)\s*[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}){0,8})/);
  return match?.[1];
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

function looksLikePdfProducer(value: string) {
  return /^(microsoft word|latex|tex|acrobat|pdf|adobe|preview|quartz|producer|creator)$/i.test(value);
}
