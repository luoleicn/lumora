import type { FastifyInstance } from "fastify";
import type { SyncPushRequest } from "@lumora/shared";
import { getAuthUser } from "../auth.js";
import { prisma } from "../db.js";
import { applySyncChange, getCurrentCursor, pullChanges } from "../services/syncService.js";

export async function syncRoutes(app: FastifyInstance) {
  app.post<{ Body: SyncPushRequest }>("/sync/push", async (request, reply) => {
    let user;
    try {
      user = getAuthUser(request);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    for (const change of request.body.changes) {
      await applySyncChange(prisma, user.id, request.body.clientId, change);
    }

    return {
      accepted: request.body.changes.length,
      serverCursor: await getCurrentCursor(prisma, user.id)
    };
  });

  app.get<{ Querystring: { cursor?: string } }>("/sync/pull", async (request, reply) => {
    let user;
    try {
      user = getAuthUser(request);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const cursor = Number(request.query.cursor ?? 0);
    return pullChanges(prisma, user.id, Number.isFinite(cursor) ? cursor : 0);
  });
}
