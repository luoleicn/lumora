import type { PrismaClient } from "@prisma/client";
import type { Author, Paper } from "@lumora/shared";
import { recordChange } from "./changeLog.js";

type MendeleyDocument = {
  id: string;
  title?: string;
  authors?: Array<{ first_name?: string; last_name?: string }>;
  year?: number;
  source?: string;
  identifiers?: {
    doi?: string;
    arxiv?: string;
    pmid?: string;
  };
  abstract?: string;
};

type MendeleyFolder = {
  id: string;
  name: string;
  parent_id?: string;
};

const MENDELEY_API = "https://api.mendeley.com";

export async function runMendeleyImport(db: PrismaClient, jobId: string, userId: string) {
  const connection = await db.externalConnection.findUnique({
    where: { userId_provider: { userId, provider: "mendeley" } }
  });
  if (!connection) {
    await failJob(db, jobId, "Mendeley is not connected for this user.");
    return;
  }

  await db.importJob.update({ where: { id: jobId }, data: { status: "running" } });

  try {
    const documents = await fetchPaged<MendeleyDocument>("/documents?view=all&limit=500", connection.accessToken);
    const folders = await fetchPaged<MendeleyFolder>("/folders?limit=500", connection.accessToken);

    let importedPapers = 0;
    let importedCollections = 0;

    for (const folder of folders) {
      await db.$transaction(async (tx) => {
        await tx.collection.upsert({
          where: { userId_id: { userId, id: folder.id } },
          update: {
            name: folder.name,
            parentId: folder.parent_id,
            updatedAt: new Date()
          },
          create: {
            id: folder.id,
            userId,
            name: folder.name,
            parentId: folder.parent_id,
            sortOrder: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        });
        await recordChange(tx, userId, "collection", folder.id, "upsert", "mendeley-import");
      });
      importedCollections += 1;
    }

    for (const document of documents) {
      const paper = mapDocument(document);
      await db.$transaction(async (tx) => {
        await tx.paper.upsert({
          where: { userId_id: { userId, id: paper.id } },
          update: {
            title: paper.title,
            authors: paper.authors,
            year: paper.year,
            venue: paper.venue,
            doi: paper.doi,
            arxiv: paper.arxiv,
            pmid: paper.pmid,
            abstract: paper.abstract,
            source: "mendeley",
            documentType: paper.documentType,
            tags: paper.tags ?? [],
            keywords: paper.keywords ?? [],
            url: paper.url,
            pages: paper.pages,
            volume: paper.volume,
            issue: paper.issue,
            publisher: paper.publisher,
            favorite: paper.favorite ?? false,
            needsReview: paper.needsReview ?? false,
            unread: paper.unread ?? true,
            updatedAt: new Date()
          },
          create: {
            id: paper.id,
            userId,
            title: paper.title,
            authors: paper.authors,
            year: paper.year,
            venue: paper.venue,
            doi: paper.doi,
            arxiv: paper.arxiv,
            pmid: paper.pmid,
            abstract: paper.abstract,
            source: "mendeley",
            documentType: paper.documentType,
            tags: paper.tags ?? [],
            keywords: paper.keywords ?? [],
            url: paper.url,
            pages: paper.pages,
            volume: paper.volume,
            issue: paper.issue,
            publisher: paper.publisher,
            favorite: paper.favorite ?? false,
            needsReview: paper.needsReview ?? false,
            unread: paper.unread ?? true,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        });
        await recordChange(tx, userId, "paper", paper.id, "upsert", "mendeley-import");
      });
      importedPapers += 1;
    }

    await db.importJob.update({
      where: { id: jobId },
      data: {
        status: "completed",
        importedPapers,
        importedCollections
      }
    });
  } catch (error) {
    await failJob(db, jobId, error instanceof Error ? error.message : "Unknown Mendeley import error");
  }
}

async function fetchPaged<T>(path: string, accessToken: string): Promise<T[]> {
  const output: T[] = [];
  let nextUrl: string | undefined = `${MENDELEY_API}${path}`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Mendeley API request failed: ${response.status} ${response.statusText}`);
    }

    const page = (await response.json()) as T[] | T;
    output.push(...(Array.isArray(page) ? page : [page]));
    nextUrl = parseNextLink(response.headers.get("link"));
  }

  return output;
}

function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }

  for (const link of linkHeader.split(",")) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function mapDocument(document: MendeleyDocument): Paper {
  const now = new Date().toISOString();
  const authors: Author[] = (document.authors ?? []).map((author) => ({
    firstName: author.first_name,
    lastName: author.last_name,
    fullName: [author.first_name, author.last_name].filter(Boolean).join(" ").trim() || "Unknown author"
  }));

  return {
    id: document.id,
    title: document.title ?? "Untitled paper",
    authors,
    year: document.year,
    venue: document.source,
    doi: document.identifiers?.doi,
    arxiv: document.identifiers?.arxiv,
    pmid: document.identifiers?.pmid,
    abstract: document.abstract,
    source: "mendeley",
    documentType: "journalArticle",
    tags: [],
    keywords: [],
    favorite: false,
    needsReview: false,
    unread: true,
    createdAt: now,
    updatedAt: now
  };
}

async function failJob(db: PrismaClient, jobId: string, error: string) {
  await db.importJob.update({
    where: { id: jobId },
    data: {
      status: "failed",
      error
    }
  });
}
