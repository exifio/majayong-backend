import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Prisma, PrismaClient, Role } from "@prisma/client";
import { issueAccessToken, verifyAccessToken } from "./auth.js";

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
};
export type Actor = { userId: string; role: Role };

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_REPLAY_GRACE_MS = 5_000;

function refreshTokenHash(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}

function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}
function rotatedRefreshToken(token: string, replacementId: string, secret: string): string {
  // 동시 재시도는 같은 후속 토큰을 받아야 하므로 원문 대신 이전 토큰과 후속 ID에서 결정한다.
  const key = createHmac("sha256", secret).update("majayong:refresh-rotation:v1").digest();
  return createHmac("sha256", key).update(token).update("\0").update(replacementId).digest("base64url");
}

function tokenPair(userId: string, role: Role, refreshToken: string, refreshExpiresAt: Date, secret: string, now: Date): SessionTokens {
  const accessExpiresAt = now.getTime() + ACCESS_TOKEN_TTL_MS;
  return {
    accessToken: issueAccessToken({ userId, role, expiresAt: accessExpiresAt }, secret),
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt: refreshExpiresAt.getTime(),
  };
}

async function revokeFamily(tx: Prisma.TransactionClient, familyId: string, now: Date): Promise<void> {
  await tx.refreshSession.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now },
  });
}

export class SessionError extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function createSessionTokens(db: PrismaClient, userId: string, secret: string, now: Date): Promise<SessionTokens> {
  if (Buffer.byteLength(secret) < 32 || Number.isNaN(now.getTime())) throw new SessionError("AUTH_CONFIG_INVALID");
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, suspendedAt: true, withdrawnAt: true } });
  if (!user) throw new SessionError("ACCOUNT_NOT_FOUND");
  if (user.suspendedAt || user.withdrawnAt) throw new SessionError("ACCOUNT_INACTIVE");

  const refreshToken = newRefreshToken();
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
  await db.refreshSession.create({
    data: {
      userId,
      familyId: randomUUID(),
      tokenHash: refreshTokenHash(refreshToken)!,
      expiresAt: refreshExpiresAt,
    },
  });
  return tokenPair(userId, user.role, refreshToken, refreshExpiresAt, secret, now);
}

export async function rotateRefreshToken(db: PrismaClient, token: string, secret: string, now: Date): Promise<SessionTokens> {
  const tokenHash = refreshTokenHash(token);
  if (!tokenHash) throw new SessionError("REFRESH_TOKEN_INVALID");
  if (Buffer.byteLength(secret) < 32 || Number.isNaN(now.getTime())) throw new SessionError("AUTH_CONFIG_INVALID");

  const result = await db.$transaction(async tx => {
    const session = await tx.refreshSession.findUnique({ where: { tokenHash } });
    if (!session) return { error: "REFRESH_TOKEN_INVALID" } as const;
    const replayRecentlyRotated = async (previous: typeof session): Promise<SessionTokens | "ACCOUNT_INACTIVE" | null> => {
      if (!previous.revokedAt || !previous.replacedById) return null;
      const age = now.getTime() - previous.revokedAt.getTime();
      if (age < 0 || age > REFRESH_TOKEN_REPLAY_GRACE_MS) return null;
      const replacement = await tx.refreshSession.findUnique({ where: { id: previous.replacedById } });
      if (!replacement || replacement.userId !== previous.userId || replacement.familyId !== previous.familyId || replacement.revokedAt || replacement.expiresAt <= now) return null;
      const refreshToken = rotatedRefreshToken(token, replacement.id, secret);
      if (refreshTokenHash(refreshToken) !== replacement.tokenHash) return null;
      const user = await tx.user.findUnique({
        where: { id: previous.userId },
        select: { role: true, suspendedAt: true, withdrawnAt: true },
      });
      if (!user || user.suspendedAt || user.withdrawnAt) {
        await revokeFamily(tx, previous.familyId, now);
        return "ACCOUNT_INACTIVE";
      }
      return tokenPair(previous.userId, user.role, refreshToken, replacement.expiresAt, secret, now);
    };
    if (session.revokedAt) {
      const replayed = await replayRecentlyRotated(session);
      if (replayed === "ACCOUNT_INACTIVE") return { error: replayed } as const;
      if (replayed) return { tokens: replayed } as const;
      await revokeFamily(tx, session.familyId, now);
      return { error: "REFRESH_TOKEN_REUSED" } as const;
    }
    if (session.expiresAt <= now) {
      await revokeFamily(tx, session.familyId, now);
      return { error: "REFRESH_TOKEN_EXPIRED" } as const;
    }

    const user = await tx.user.findUnique({
      where: { id: session.userId },
      select: { role: true, suspendedAt: true, withdrawnAt: true },
    });
    if (!user || user.suspendedAt || user.withdrawnAt) {
      await revokeFamily(tx, session.familyId, now);
      return { error: "ACCOUNT_INACTIVE" } as const;
    }

    const replacementId = randomUUID();
    const refreshToken = rotatedRefreshToken(token, replacementId, secret);
    await tx.refreshSession.create({
      data: {
        id: replacementId,
        userId: session.userId,
        familyId: session.familyId,
        tokenHash: refreshTokenHash(refreshToken)!,
        expiresAt: session.expiresAt,
      },
    });
    const updated = await tx.refreshSession.updateMany({
      where: { id: session.id, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now, replacedById: replacementId },
    });
    if (updated.count !== 1) {
      await tx.refreshSession.delete({ where: { id: replacementId } });
      const latestSession = await tx.refreshSession.findUnique({ where: { id: session.id } });
      if (latestSession) {
        const replayed = await replayRecentlyRotated(latestSession);
        if (replayed === "ACCOUNT_INACTIVE") return { error: replayed } as const;
        if (replayed) return { tokens: replayed } as const;
      }
      await revokeFamily(tx, session.familyId, now);
      return { error: "REFRESH_TOKEN_REUSED" } as const;
    }
    return { tokens: tokenPair(session.userId, user.role, refreshToken, session.expiresAt, secret, now) } as const;
  });

  if (result.error !== undefined) throw new SessionError(result.error);
  return result.tokens;
}

export async function revokeRefreshTokenFamily(db: PrismaClient, token: string, now: Date): Promise<void> {
  const tokenHash = refreshTokenHash(token);
  if (!tokenHash) return;
  await db.$transaction(async tx => {
    const session = await tx.refreshSession.findUnique({ where: { tokenHash }, select: { familyId: true } });
    if (session) await revokeFamily(tx, session.familyId, now);
  });
}

export async function requireActor(db: PrismaClient, token: string, secret: string, now: number): Promise<Actor> {
  const claims = verifyAccessToken(token, secret, now);
  if (!claims) throw new SessionError("INVALID_ACCESS_TOKEN");
  const user = await db.user.findUnique({
    where: { id: claims.userId },
    select: { role: true, suspendedAt: true, withdrawnAt: true },
  });
  if (!user || user.suspendedAt || user.withdrawnAt) throw new SessionError("ACCOUNT_INACTIVE");
  if (user.role !== claims.role) throw new SessionError("INVALID_ACCESS_TOKEN");
  return { userId: claims.userId, role: user.role };
}
