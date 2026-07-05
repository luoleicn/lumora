import type { FastifyInstance } from "fastify";
import type { LoginRequest } from "@lumora/shared";
import { createAccessToken, verifyPassword } from "../auth.js";
import { prisma } from "../db.js";

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: LoginRequest }>("/auth/login", async (request, reply) => {
    const { email, password } = request.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    const { token, expiresAt } = createAccessToken(user);
    return {
      accessToken: token,
      expiresAt
    };
  });
}
