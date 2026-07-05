import type { Author, Paper } from "@lumora/shared";
import { createId } from "./id";

type ReferenceFields = {
  title?: string;
  authors: Author[];
  year?: number;
  venue?: string;
  doi?: string;
  abstract?: string;
  documentType?: string;
  tags?: string[];
  keywords?: string[];
  url?: string;
  pages?: string;
  volume?: string;
  issue?: string;
  publisher?: string;
};

export function parseReferenceFile(fileName: string, text: string): Paper[] {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".ris") || text.trimStart().startsWith("TY  -")) {
    return parseRis(text);
  }

  return parseBibtex(text);
}

function parseRis(text: string): Paper[] {
  return text
    .split(/\nER\s+-/i)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const fields = new Map<string, string[]>();
      for (const line of record.split(/\r?\n/)) {
        const match = line.match(/^([A-Z0-9]{2})\s+-\s*(.*)$/);
        if (!match) {
          continue;
        }

        const [, tag, value] = match;
        fields.set(tag, [...fields.get(tag) ?? [], value.trim()]);
      }

      const startPage = first(fields, "SP");
      const endPage = first(fields, "EP");
      return toPaper({
        title: first(fields, "TI", "T1", "CT"),
        authors: parseAuthors(fields.get("AU") ?? fields.get("A1") ?? []),
        year: parseYear(first(fields, "PY", "Y1", "DA")),
        venue: first(fields, "JO", "JF", "JA", "T2"),
        doi: normalizeDoi(first(fields, "DO")),
        abstract: first(fields, "AB", "N2"),
        documentType: risTypeToDocumentType(first(fields, "TY")),
        tags: uniqueStrings(fields.get("KW") ?? []),
        keywords: uniqueStrings(fields.get("KW") ?? []),
        url: first(fields, "UR", "L1"),
        pages: [startPage, endPage].filter(Boolean).join("-") || undefined,
        volume: first(fields, "VL"),
        issue: first(fields, "IS"),
        publisher: first(fields, "PB")
      });
    });
}

function parseBibtex(text: string): Paper[] {
  const entries: string[] = [];
  const entryPattern = /@([a-zA-Z]+)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(text))) {
    let depth = 1;
    let cursor = entryPattern.lastIndex;
    while (cursor < text.length && depth > 0) {
      const char = text[cursor];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      cursor += 1;
    }
    entries.push(text.slice(match.index, cursor));
    entryPattern.lastIndex = cursor;
  }

  return entries.map((entry) => {
    const kind = entry.match(/^@([a-zA-Z]+)/)?.[1]?.toLowerCase();
    const fields = parseBibtexFields(entry);
    const keywords = splitList(fields.keywords);
    return toPaper({
      title: stripBibtexBraces(fields.title),
      authors: parseAuthors(splitAuthors(fields.author)),
      year: parseYear(fields.year),
      venue: fields.journal ?? fields.booktitle ?? fields.publisher,
      doi: normalizeDoi(fields.doi),
      abstract: stripBibtexBraces(fields.abstract),
      documentType: bibtexTypeToDocumentType(kind),
      tags: keywords,
      keywords,
      url: fields.url,
      pages: fields.pages,
      volume: fields.volume,
      issue: fields.number,
      publisher: fields.publisher
    });
  });
}

function parseBibtexFields(entry: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const body = entry.slice(entry.indexOf(",") + 1, entry.lastIndexOf("}"));
  let cursor = 0;

  while (cursor < body.length) {
    const keyMatch = body.slice(cursor).match(/\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*/);
    if (!keyMatch?.[1]) {
      break;
    }

    const key = keyMatch[1].toLowerCase();
    cursor += (keyMatch.index ?? 0) + keyMatch[0].length;
    const { value, nextCursor } = readBibtexValue(body, cursor);
    const parsedValue = stripBibtexBraces(value.trim());
    if (parsedValue) {
      fields[key] = parsedValue;
    }
    cursor = nextCursor;
  }

  return fields;
}

function readBibtexValue(body: string, start: number) {
  const quote = body[start];
  if (quote === "{" || quote === "\"") {
    const closing = quote === "{" ? "}" : "\"";
    let depth = quote === "{" ? 1 : 0;
    let cursor = start + 1;
    while (cursor < body.length) {
      const char = body[cursor];
      if (quote === "{" && char === "{") {
        depth += 1;
      } else if (quote === "{" && char === "}") {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      } else if (quote === "\"" && char === closing && body[cursor - 1] !== "\\") {
        cursor += 1;
        break;
      }
      cursor += 1;
    }

    return {
      value: body.slice(start + 1, cursor - 1),
      nextCursor: skipComma(body, cursor)
    };
  }

  const end = body.slice(start).search(/,\s*[a-zA-Z][a-zA-Z0-9_-]*\s*=/);
  const cursor = end === -1 ? body.length : start + end + 1;
  return {
    value: body.slice(start, end === -1 ? body.length : start + end).trim(),
    nextCursor: cursor
  };
}

function skipComma(body: string, cursor: number) {
  while (cursor < body.length && /[\s,]/.test(body[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function toPaper(fields: ReferenceFields): Paper {
  const now = new Date().toISOString();
  return {
    id: createId("paper"),
    title: fields.title?.trim() || "Untitled paper",
    authors: fields.authors,
    year: fields.year,
    venue: clean(fields.venue),
    doi: fields.doi,
    abstract: clean(fields.abstract),
    source: "import",
    documentType: fields.documentType ?? "journalArticle",
    tags: fields.tags ?? [],
    keywords: fields.keywords ?? [],
    url: clean(fields.url),
    pages: clean(fields.pages),
    volume: clean(fields.volume),
    issue: clean(fields.issue),
    publisher: clean(fields.publisher),
    favorite: false,
    needsReview: true,
    unread: true,
    createdAt: now,
    updatedAt: now
  };
}

function parseAuthors(values: string[]): Author[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((fullName) => {
      const commaParts = fullName.split(",").map((part) => part.trim()).filter(Boolean);
      if (commaParts.length >= 2) {
        return {
          firstName: commaParts.slice(1).join(" "),
          lastName: commaParts[0],
          fullName: `${commaParts.slice(1).join(" ")} ${commaParts[0]}`.trim()
        };
      }

      const parts = fullName.split(/\s+/);
      return {
        firstName: parts.slice(0, -1).join(" ") || undefined,
        lastName: parts.at(-1),
        fullName
      };
    });
}

function splitAuthors(value?: string) {
  return value ? value.split(/\s+and\s+/i).map((item) => item.trim()).filter(Boolean) : [];
}

function splitList(value?: string) {
  return uniqueStrings(value?.split(/[;,]/).map((item) => item.trim()).filter(Boolean) ?? []);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function first(fields: Map<string, string[]>, ...keys: string[]) {
  for (const key of keys) {
    const value = fields.get(key)?.find(Boolean);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseYear(value?: string) {
  const match = value?.match(/\d{4}/);
  return match?.[0] ? Number.parseInt(match[0], 10) : undefined;
}

function clean(value?: string) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeDoi(value?: string) {
  return clean(value?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
}

function stripBibtexBraces(value?: string) {
  return clean(value?.replace(/[{}]/g, ""));
}

function risTypeToDocumentType(value?: string) {
  switch (value?.toUpperCase()) {
    case "BOOK":
      return "book";
    case "CHAP":
      return "bookSection";
    case "CONF":
    case "CPAPER":
      return "conferencePaper";
    case "THES":
      return "thesis";
    default:
      return "journalArticle";
  }
}

function bibtexTypeToDocumentType(value?: string) {
  switch (value) {
    case "book":
      return "book";
    case "inbook":
    case "incollection":
      return "bookSection";
    case "inproceedings":
    case "conference":
      return "conferencePaper";
    case "phdthesis":
    case "mastersthesis":
      return "thesis";
    default:
      return "journalArticle";
  }
}
