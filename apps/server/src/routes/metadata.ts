import type { FastifyInstance } from "fastify";
import { searchArxivByTitle } from "../services/arxivService.js";

export async function metadataRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { title?: string } }>("/metadata/arxiv", async (request, reply) => {
    const title = request.query.title?.trim();
    if (!title) {
      return reply.code(400).send({ error: "Missing title." });
    }

    try {
      return {
        results: await searchArxivByTitle(title)
      };
    } catch (error) {
      request.log.error({ error }, "arXiv metadata lookup failed");
      return reply.code(502).send({
        error: error instanceof Error ? error.message : "arXiv metadata lookup failed."
      });
    }
  });
}
