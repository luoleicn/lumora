import type {
  Annotation,
  Collection,
  FileAsset,
  Paper,
  PaperCollection,
  SyncChange,
  SyncEntity
} from "@lumora/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import { recordChange } from "./changeLog.js";

type Transaction = Prisma.TransactionClient;

const toDate = (value?: string) => (value ? new Date(value) : undefined);
const toIso = (value?: Date | null) => (value ? value.toISOString() : undefined);

export async function applySyncChange(db: PrismaClient, userId: string, clientId: string, change: SyncChange) {
  await db.$transaction(async (tx) => {
    switch (change.entity) {
      case "paper":
        await upsertPaper(tx, userId, change.data as Paper);
        break;
      case "fileAsset":
        await upsertFileAsset(tx, userId, change.data as FileAsset);
        break;
      case "collection":
        await upsertCollection(tx, userId, change.data as Collection);
        break;
      case "paperCollection":
        await upsertPaperCollection(tx, userId, change.data as PaperCollection);
        break;
      case "annotation":
        await upsertAnnotation(tx, userId, change.data as Annotation);
        break;
    }

    await recordChange(tx, userId, change.entity, change.data.id, change.op, clientId);
  });
}

export async function getCurrentCursor(db: PrismaClient, userId: string): Promise<number> {
  const latest = await db.change.findFirst({
    where: { userId },
    orderBy: { id: "desc" },
    select: { id: true }
  });

  return latest?.id ?? 0;
}

export async function pullChanges(db: PrismaClient, userId: string, cursor: number) {
  const changeRows = await db.change.findMany({
    where: {
      userId,
      id: { gt: cursor }
    },
    orderBy: { id: "asc" },
    take: 500
  });

  const changes: SyncChange[] = [];
  for (const row of changeRows) {
    const entity = row.entityType as SyncEntity;
    const data = await loadEntity(db, userId, entity, row.entityId);
    if (data) {
      changes.push({ entity, op: row.op as SyncChange["op"], data } as SyncChange);
    }
  }

  return {
    cursor: changeRows.at(-1)?.id ?? cursor,
    changes
  };
}

async function loadEntity(db: PrismaClient, userId: string, entity: SyncEntity, id: string) {
  switch (entity) {
    case "paper": {
      const paper = await db.paper.findFirst({ where: { id, userId } });
      return paper ? serializePaper(paper) : undefined;
    }
    case "fileAsset": {
      const fileAsset = await db.fileAsset.findFirst({ where: { id, userId } });
      return fileAsset ? serializeFileAsset(fileAsset) : undefined;
    }
    case "collection": {
      const collection = await db.collection.findFirst({ where: { id, userId } });
      return collection ? serializeCollection(collection) : undefined;
    }
    case "paperCollection": {
      const paperCollection = await db.paperCollection.findFirst({ where: { id, userId } });
      return paperCollection ? serializePaperCollection(paperCollection) : undefined;
    }
    case "annotation": {
      const annotation = await db.annotation.findFirst({ where: { id, userId } });
      return annotation ? serializeAnnotation(annotation) : undefined;
    }
  }
}

async function upsertPaper(tx: Transaction, userId: string, data: Paper) {
  await tx.paper.upsert({
    where: { userId_id: { userId, id: data.id } },
    update: {
      title: data.title,
      authors: data.authors as unknown as Prisma.InputJsonValue,
      year: data.year,
      venue: data.venue,
      doi: data.doi,
      arxiv: data.arxiv,
      pmid: data.pmid,
      abstract: data.abstract,
      source: data.source,
      documentType: data.documentType,
      tags: (data.tags ?? []) as unknown as Prisma.InputJsonValue,
      keywords: (data.keywords ?? []) as unknown as Prisma.InputJsonValue,
      url: data.url,
      pages: data.pages,
      volume: data.volume,
      issue: data.issue,
      publisher: data.publisher,
      favorite: data.favorite ?? false,
      needsReview: data.needsReview ?? false,
      unread: data.unread ?? true,
      updatedAt: toDate(data.updatedAt) ?? new Date(),
      deletedAt: toDate(data.deletedAt)
    },
    create: {
      id: data.id,
      userId,
      title: data.title,
      authors: data.authors as unknown as Prisma.InputJsonValue,
      year: data.year,
      venue: data.venue,
      doi: data.doi,
      arxiv: data.arxiv,
      pmid: data.pmid,
      abstract: data.abstract,
      source: data.source,
      documentType: data.documentType,
      tags: (data.tags ?? []) as unknown as Prisma.InputJsonValue,
      keywords: (data.keywords ?? []) as unknown as Prisma.InputJsonValue,
      url: data.url,
      pages: data.pages,
      volume: data.volume,
      issue: data.issue,
      publisher: data.publisher,
      favorite: data.favorite ?? false,
      needsReview: data.needsReview ?? false,
      unread: data.unread ?? true,
      createdAt: toDate(data.createdAt) ?? new Date(),
      updatedAt: toDate(data.updatedAt) ?? new Date(),
      deletedAt: toDate(data.deletedAt)
    }
  });
}

async function upsertFileAsset(tx: Transaction, userId: string, data: FileAsset) {
  await ensurePaperOwnedByUser(tx, userId, data.paperId);

  await tx.fileAsset.upsert({
    where: { userId_id: { userId, id: data.id } },
    update: {
      paperId: data.paperId,
      sha256: data.sha256,
      size: data.size,
      mime: data.mime,
      fileName: data.fileName,
      localPath: data.localPath,
      objectKey: data.objectKey,
      downloadState: data.downloadState,
      updatedAt: toDate(data.updatedAt) ?? new Date(),
      deletedAt: toDate(data.deletedAt)
    },
    create: {
      id: data.id,
      userId,
      paperId: data.paperId,
      sha256: data.sha256,
      size: data.size,
      mime: data.mime,
      fileName: data.fileName,
      localPath: data.localPath,
      objectKey: data.objectKey,
      downloadState: data.downloadState,
      createdAt: toDate(data.createdAt) ?? new Date(),
      updatedAt: toDate(data.updatedAt) ?? new Date(),
      deletedAt: toDate(data.deletedAt)
    }
  });
}

async function upsertCollection(tx: Transaction, userId: string, data: Collection) {
  if (data.parentId) {
    await ensureCollectionOwnedByUser(tx, userId, data.parentId);
  }

  await tx.collection.upsert({
    where: { userId_id: { userId, id: data.id } },
    update: {
      name: data.name,
      parentId: data.parentId,
      sortOrder: data.sortOrder,
      updatedAt: toDate(data.updatedAt) ?? new Date(),
      deletedAt: toDate(data.deletedAt)
    },
    create: {
      id: data.id,
      userId,
      name: data.name,
      parentId: data.parentId,
      sortOrder: data.sortOrder,
      createdAt: toDate(data.createdAt) ?? new Date(),
      updatedAt: toDate(data.updatedAt) ?? new Date(),
      deletedAt: toDate(data.deletedAt)
    }
  });
}

async function upsertPaperCollection(tx: Transaction, userId: string, data: PaperCollection) {
  await ensurePaperOwnedByUser(tx, userId, data.paperId);
  await ensureCollectionOwnedByUser(tx, userId, data.collectionId);

  await tx.paperCollection.upsert({
    where: { userId_id: { userId, id: data.id } },
    update: {
      paperId: data.paperId,
      collectionId: data.collectionId,
      updatedAt: toDate(data.updatedAt) ?? new Date(),
      deletedAt: toDate(data.deletedAt)
    },
    create: {
      id: data.id,
      userId,
      paperId: data.paperId,
      collectionId: data.collectionId,
      createdAt: toDate(data.createdAt) ?? new Date(),
      updatedAt: toDate(data.updatedAt) ?? new Date(),
      deletedAt: toDate(data.deletedAt)
    }
  });
}

async function upsertAnnotation(tx: Transaction, userId: string, data: Annotation) {
  await ensurePaperOwnedByUser(tx, userId, data.paperId);
  await ensureFileAssetOwnedByUser(tx, userId, data.fileId, data.paperId);

  await tx.annotation.upsert({
    where: { userId_id: { userId, id: data.id } },
    update: {
      paperId: data.paperId,
      fileId: data.fileId,
      pageIndex: data.pageIndex,
      kind: data.kind,
      color: data.color,
      rects: data.rects as unknown as Prisma.InputJsonValue,
      notePosition: data.notePosition as unknown as Prisma.InputJsonValue,
      quote: data.quote,
      comment: data.comment,
      updatedAt: toDate(data.updatedAt) ?? new Date(),
      deletedAt: toDate(data.deletedAt)
    },
    create: {
      id: data.id,
      userId,
      paperId: data.paperId,
      fileId: data.fileId,
      pageIndex: data.pageIndex,
      kind: data.kind,
      color: data.color,
      rects: data.rects as unknown as Prisma.InputJsonValue,
      notePosition: data.notePosition as unknown as Prisma.InputJsonValue,
      quote: data.quote,
      comment: data.comment,
      createdAt: toDate(data.createdAt) ?? new Date(),
      updatedAt: toDate(data.updatedAt) ?? new Date(),
      deletedAt: toDate(data.deletedAt)
    }
  });
}

async function ensurePaperOwnedByUser(tx: Transaction, userId: string, paperId: string) {
  const paper = await tx.paper.findUnique({
    where: { userId_id: { userId, id: paperId } },
    select: { id: true }
  });
  if (!paper) {
    throw new Error("Referenced paper does not belong to the authenticated user");
  }
}

async function ensureCollectionOwnedByUser(tx: Transaction, userId: string, collectionId: string) {
  const collection = await tx.collection.findUnique({
    where: { userId_id: { userId, id: collectionId } },
    select: { id: true }
  });
  if (!collection) {
    throw new Error("Referenced collection does not belong to the authenticated user");
  }
}

async function ensureFileAssetOwnedByUser(tx: Transaction, userId: string, fileId: string, paperId?: string) {
  const fileAsset = await tx.fileAsset.findUnique({
    where: { userId_id: { userId, id: fileId } },
    select: { id: true, paperId: true }
  });
  if (!fileAsset) {
    throw new Error("Referenced file asset does not belong to the authenticated user");
  }
  if (paperId && fileAsset.paperId !== paperId) {
    throw new Error("Referenced file asset does not belong to the annotation paper");
  }
}

function serializePaper(data: Awaited<ReturnType<PrismaClient["paper"]["findFirst"]>>): Paper {
  if (!data) {
    throw new Error("Missing paper");
  }

  return {
    id: data.id,
    title: data.title,
    authors: data.authors as Paper["authors"],
    year: data.year ?? undefined,
    venue: data.venue ?? undefined,
    doi: data.doi ?? undefined,
    arxiv: data.arxiv ?? undefined,
    pmid: data.pmid ?? undefined,
    abstract: data.abstract ?? undefined,
    source: data.source as Paper["source"],
    documentType: data.documentType ?? undefined,
    tags: data.tags as Paper["tags"],
    keywords: data.keywords as Paper["keywords"],
    url: data.url ?? undefined,
    pages: data.pages ?? undefined,
    volume: data.volume ?? undefined,
    issue: data.issue ?? undefined,
    publisher: data.publisher ?? undefined,
    favorite: data.favorite,
    needsReview: data.needsReview,
    unread: data.unread,
    createdAt: data.createdAt.toISOString(),
    updatedAt: data.updatedAt.toISOString(),
    deletedAt: toIso(data.deletedAt)
  };
}

function serializeFileAsset(data: Awaited<ReturnType<PrismaClient["fileAsset"]["findFirst"]>>): FileAsset {
  if (!data) {
    throw new Error("Missing file asset");
  }

  return {
    id: data.id,
    paperId: data.paperId,
    sha256: data.sha256,
    size: data.size,
    mime: data.mime,
    fileName: data.fileName,
    localPath: data.localPath ?? undefined,
    objectKey: data.objectKey ?? undefined,
    downloadState: data.downloadState as FileAsset["downloadState"],
    createdAt: data.createdAt.toISOString(),
    updatedAt: data.updatedAt.toISOString(),
    deletedAt: toIso(data.deletedAt)
  };
}

function serializeCollection(data: Awaited<ReturnType<PrismaClient["collection"]["findFirst"]>>): Collection {
  if (!data) {
    throw new Error("Missing collection");
  }

  return {
    id: data.id,
    name: data.name,
    parentId: data.parentId ?? undefined,
    sortOrder: data.sortOrder,
    createdAt: data.createdAt.toISOString(),
    updatedAt: data.updatedAt.toISOString(),
    deletedAt: toIso(data.deletedAt)
  };
}

function serializePaperCollection(data: Awaited<ReturnType<PrismaClient["paperCollection"]["findFirst"]>>): PaperCollection {
  if (!data) {
    throw new Error("Missing paper collection");
  }

  return {
    id: data.id,
    paperId: data.paperId,
    collectionId: data.collectionId,
    createdAt: data.createdAt.toISOString(),
    updatedAt: data.updatedAt.toISOString(),
    deletedAt: toIso(data.deletedAt)
  };
}

function serializeAnnotation(data: Awaited<ReturnType<PrismaClient["annotation"]["findFirst"]>>): Annotation {
  if (!data) {
    throw new Error("Missing annotation");
  }

  return {
    id: data.id,
    paperId: data.paperId,
    fileId: data.fileId,
    pageIndex: data.pageIndex,
    kind: data.kind as Annotation["kind"],
    color: data.color,
    rects: data.rects as Annotation["rects"],
    notePosition: data.notePosition as Annotation["notePosition"] ?? undefined,
    quote: data.quote ?? undefined,
    comment: data.comment ?? undefined,
    createdAt: data.createdAt.toISOString(),
    updatedAt: data.updatedAt.toISOString(),
    deletedAt: toIso(data.deletedAt)
  };
}
