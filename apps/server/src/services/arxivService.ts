import type { ArxivMetadata } from "@lumora/shared";

const ARXIV_API = "https://export.arxiv.org/api/query";

export async function searchArxivByTitle(title: string): Promise<ArxivMetadata[]> {
  const query = title.trim();
  if (!query) {
    return [];
  }

  const url = new URL(ARXIV_API);
  url.searchParams.set("search_query", `ti:"${query.replaceAll("\"", "")}"`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "5");
  url.searchParams.set("sortBy", "relevance");
  url.searchParams.set("sortOrder", "descending");

  const response = await fetch(url, {
    headers: {
      Accept: "application/atom+xml"
    }
  });

  if (!response.ok) {
    throw new Error(`arXiv lookup failed: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  return parseArxivFeed(xml, query).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function parseArxivFeed(xml: string, queryTitle: string): ArxivMetadata[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1] ?? "";
    const idUrl = cleanText(readTag(entry, "id"));
    const arxivId = normalizeArxivId(idUrl);
    const title = cleanText(readTag(entry, "title"));
    const abstract = cleanText(readTag(entry, "summary"));
    const publishedAt = cleanText(readTag(entry, "published"));
    const updatedAt = cleanText(readTag(entry, "updated"));
    const doi = cleanText(readNamespacedTag(entry, "arxiv:doi"));
    const journalRef = cleanText(readNamespacedTag(entry, "arxiv:journal_ref"));
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
      .map((authorMatch) => cleanText(authorMatch[1]))
      .filter(Boolean)
      .map((fullName) => ({ fullName }));
    const categories = [...entry.matchAll(/<category\s+[^>]*term="([^"]+)"/g)]
      .map((categoryMatch) => categoryMatch[1])
      .filter(Boolean);

    return {
      arxivId,
      title,
      authors,
      year: publishedAt ? new Date(publishedAt).getUTCFullYear() : undefined,
      abstract,
      doi,
      url: arxivId ? `https://arxiv.org/abs/${arxivId}` : idUrl,
      publishedAt,
      updatedAt,
      venue: journalRef || "arXiv",
      categories,
      score: scoreTitleMatch(queryTitle, title)
    };
  }).filter((item) => item.arxivId && item.title);
}

function readTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1] ?? "";
}

function readNamespacedTag(xml: string, tag: string) {
  const escapedTag = tag.replace(":", "\\:");
  const match = xml.match(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`));
  return match?.[1] ?? "";
}

function cleanText(value?: string) {
  return decodeXmlEntities(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXmlEntities(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function normalizeArxivId(value: string) {
  const id = value.match(/arxiv\.org\/abs\/([^/?#\s]+)/i)?.[1] ?? value;
  return id.replace(/^arXiv:/i, "").replace(/v\d+$/i, "");
}

function scoreTitleMatch(queryTitle: string, candidateTitle: string) {
  const queryTokens = tokenize(queryTitle);
  const candidateTokens = new Set(tokenize(candidateTitle));
  if (queryTokens.length === 0 || candidateTokens.size === 0) {
    return 0;
  }

  const hits = queryTokens.filter((token) => candidateTokens.has(token)).length;
  const coverage = hits / queryTokens.length;
  const lengthPenalty = Math.abs(queryTokens.length - candidateTokens.size) / Math.max(queryTokens.length, candidateTokens.size);
  return Math.max(0, coverage - lengthPenalty * 0.15);
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}
