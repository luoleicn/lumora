import cors from "@fastify/cors";
import Fastify from "fastify";
import { ensureBootstrapUser } from "./auth.js";
import { prisma } from "./db.js";
import { authRoutes } from "./routes/auth.js";
import { fileRoutes } from "./routes/files.js";
import { mendeleyRoutes } from "./routes/mendeley.js";
import { syncRoutes } from "./routes/sync.js";

export async function buildServer() {
  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: true,
    credentials: true
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(syncRoutes);
  await app.register(fileRoutes);
  await app.register(mendeleyRoutes);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  await ensureBootstrapUser(prisma);

  return app;
}
