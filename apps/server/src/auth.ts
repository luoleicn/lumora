import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { PrismaClient, User } from "@prisma/client";
import { env } from "./env.js";

type TokenPayload = {
  sub: string;
  email: string;
  exp: number;
};

export type AuthUser = {
  id: string;
  email: string;
};

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64Url(input: string): Buffer {
  const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
}

export function createAccessToken(user: Pick<User, "id" | "email">): { token: string; expiresAt: string } {
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ sub: user.id, email: user.email, exp: Math.floor(expiresAt.getTime() / 1000) }));
  const signature = base64Url(crypto.createHmac("sha256", env.jwtSecret).update(`${header}.${payload}`).digest());

  return { token: `${header}.${payload}.${signature}`, expiresAt: expiresAt.toISOString() };
}

export function verifyAccessToken(token: string): AuthUser {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) {
    throw new Error("Malformed token");
  }

  const expected = base64Url(crypto.createHmac("sha256", env.jwtSecret).update(`${header}.${payload}`).digest());
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("Invalid token signature");
  }

  const decoded = JSON.parse(fromBase64Url(payload).toString("utf8")) as TokenPayload;
  if (decoded.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Expired token");
  }

  return { id: decoded.sub, email: decoded.email };
}

export function getAuthUser(request: FastifyRequest): AuthUser {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  if (!token) {
    throw new Error("Missing bearer token");
  }

  return verifyAccessToken(token);
}

export async function ensureBootstrapUser(db: PrismaClient): Promise<void> {
  const existing = await db.user.findUnique({ where: { email: env.bootstrapEmail } });
  if (existing) {
    return;
  }

  const { hash, salt } = hashPassword(env.bootstrapPassword);
  await db.user.create({
    data: {
      email: env.bootstrapEmail,
      passwordHash: hash,
      passwordSalt: salt
    }
  });
}
