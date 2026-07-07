import type { FastifyInstance } from "fastify";
import type { InitUploadRequest } from "@lumora/shared";
import { getAuthUser } from "../auth.js";
import { prisma } from "../db.js";
import { createDownloadUrl, createUploadUrl, objectKeyForFile } from "../services/storage.js";
import { recordChange } from "../services/changeLog.js";

export async function fileRoutes(app: FastifyInstance) {
  app.post<{ Body: InitUploadRequest }>("/files/init-upload", async (request, reply) => {
    let user;
    try {
      user = getAuthUser(request);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const body = request.body;
    const objectKey = objectKeyForFile(user.id, body.sha256, body.fileName);
    const uploadUrl = await createUploadUrl(objectKey, body.mime);
    const now = new Date();

    try {
      await prisma.$transaction(async (tx) => {
        const paper = await tx.paper.findUnique({
          where: { userId_id: { userId: user.id, id: body.paperId } },
          select: { id: true }
        });
        if (!paper) {
          throw new Error("Paper not found");
        }

        await tx.fileAsset.upsert({
          where: { userId_id: { userId: user.id, id: body.fileAssetId } },
          update: {
            objectKey,
            downloadState: "remote",
            updatedAt: now
          },
          create: {
            id: body.fileAssetId,
            userId: user.id,
            paperId: body.paperId,
            sha256: body.sha256,
            size: body.size,
            mime: body.mime,
            fileName: body.fileName,
            objectKey,
            downloadState: "remote",
            createdAt: now,
            updatedAt: now
          }
        });
        await recordChange(tx, user.id, "fileAsset", body.fileAssetId, "upsert", "file-upload");
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Paper not found") {
        return reply.code(404).send({ error: "Paper not found" });
      }
      throw error;
    }

    return {
      fileAssetId: body.fileAssetId,
      objectKey,
      uploadUrl
    };
  });

  app.get<{ Params: { id: string } }>("/files/:id/download-url", async (request, reply) => {
    let user;
    try {
      user = getAuthUser(request);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const fileAsset = await prisma.fileAsset.findFirst({
      where: {
        id: request.params.id,
        userId: user.id
      }
    });

    if (!fileAsset?.objectKey) {
      return reply.code(404).send({ error: "File asset not found or not uploaded" });
    }

    return {
      url: await createDownloadUrl(fileAsset.objectKey)
    };
  });
}
