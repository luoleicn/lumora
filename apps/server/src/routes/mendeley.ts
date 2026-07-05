import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getAuthUser, verifyAccessToken } from "../auth.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { runMendeleyImport } from "../services/mendeleyService.js";

const scopes = ["all"];

export async function mendeleyRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { token?: string } }>("/mendeley/oauth/start", async (request, reply) => {
    let user;
    try {
      user = request.query.token ? verifyAccessToken(request.query.token) : getAuthUser(request);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    if (!env.mendeleyClientId) {
      return reply.code(500).send({ error: "MENDELEY_CLIENT_ID is not configured" });
    }

    const state = Buffer.from(JSON.stringify({ userId: user.id, nonce: crypto.randomUUID() })).toString("base64url");
    const params = new URLSearchParams({
      client_id: env.mendeleyClientId,
      redirect_uri: `${env.appBaseUrl}/mendeley/oauth/callback`,
      response_type: "code",
      scope: scopes.join(" "),
      state
    });

    return reply.redirect(`https://api.mendeley.com/oauth/authorize?${params.toString()}`);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>("/mendeley/oauth/callback", async (request, reply) => {
    if (!env.mendeleyClientId || !env.mendeleyClientSecret) {
      return reply.code(500).send("Mendeley OAuth is not configured.");
    }

    if (!request.query.code || !request.query.state) {
      return reply.code(400).send("Missing OAuth code or state.");
    }

    const state = JSON.parse(Buffer.from(request.query.state, "base64url").toString("utf8")) as { userId: string };
    const tokenResponse = await fetch("https://api.mendeley.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: request.query.code,
        redirect_uri: `${env.appBaseUrl}/mendeley/oauth/callback`,
        client_id: env.mendeleyClientId,
        client_secret: env.mendeleyClientSecret
      })
    });

    if (!tokenResponse.ok) {
      return reply.code(502).send("Failed to exchange Mendeley OAuth code.");
    }

    const token = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    await prisma.externalConnection.upsert({
      where: { userId_provider: { userId: state.userId, provider: "mendeley" } },
      update: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined
      },
      create: {
        userId: state.userId,
        provider: "mendeley",
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined
      }
    });

    return reply.type("text/html").send(`
      <html>
        <body>
          <p>Mendeley connected. You can close this window and start the import in Lumora.</p>
          <script>setTimeout(() => window.close(), 1000)</script>
        </body>
      </html>
    `);
  });

  app.post("/imports/mendeley", async (request, reply) => {
    let user;
    try {
      user = getAuthUser(request);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const job = await prisma.importJob.create({
      data: {
        userId: user.id,
        provider: "mendeley",
        status: "queued"
      }
    });

    void runMendeleyImport(prisma, job.id, user.id);

    return {
      id: job.id,
      provider: "mendeley",
      status: job.status,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      importedPapers: job.importedPapers,
      importedFiles: job.importedFiles,
      importedCollections: job.importedCollections
    };
  });

  app.get<{ Params: { id: string } }>("/imports/:id", async (request, reply) => {
    let user;
    try {
      user = getAuthUser(request);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const job = await prisma.importJob.findFirst({
      where: {
        id: request.params.id,
        userId: user.id
      }
    });

    if (!job) {
      return reply.code(404).send({ error: "Import job not found" });
    }

    return {
      id: job.id,
      provider: "mendeley",
      status: job.status,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      error: job.error ?? undefined,
      importedPapers: job.importedPapers,
      importedFiles: job.importedFiles,
      importedCollections: job.importedCollections
    };
  });
}
