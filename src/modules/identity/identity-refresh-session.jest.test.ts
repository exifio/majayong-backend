import { afterAll, describe, expect, it } from "@jest/globals";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient, Role } from "@prisma/client";
import {
  createSessionTokens,
  requireActor,
  revokeRefreshTokenFamily,
  rotateRefreshToken,
} from "./session.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test") {
  throw new Error("A-01 tests require the dedicated majayong_a00_test database");
}
process.env.DATABASE_URL = databaseUrl;

const prisma = new PrismaClient();
const secret = "a-refresh-test-secret-that-is-at-least-32-characters";
const now = new Date("2026-11-03T00:00:00.000Z");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

async function withUser(run: (userId: string) => Promise<void>): Promise<void> {
  const user = await prisma.user.create({
    data: { email: `a01-session-${randomUUID()}@example.invalid`, role: Role.CLIENT },
    select: { id: true },
  });
  try {
    await run(user.id);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

afterAll(async () => prisma.$disconnect());

describe("A-01 회전 리프레시 세션", () => {
  it("토큰 해시만 저장하고 승인된 수명을 적용한다", async () => {
    await withUser(async userId => {
      // 준비
      const tokens = await createSessionTokens(prisma, userId, secret, now);
      const stored = await prisma.refreshSession.findUnique({ where: { tokenHash: hashToken(tokens.refreshToken) } });

      // 확인
      expect(tokens.accessExpiresAt).toBe(now.getTime() + 15 * 60 * 1000);
      expect(tokens.refreshExpiresAt).toBe(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      expect(stored?.tokenHash).not.toBe(tokens.refreshToken);
      expect(stored?.familyId).toBeTruthy();

      // 실행 및 확인
      await expect(requireActor(prisma, tokens.accessToken, secret, now.getTime() + 15 * 60 * 1000))
        .rejects.toMatchObject({ code: "INVALID_ACCESS_TOKEN" });
    });
  });

  it("리프레시 토큰을 회전하고 패밀리를 폐기해 재사용을 거부한다", async () => {
    await withUser(async userId => {
      // 준비
      const original = await createSessionTokens(prisma, userId, secret, now);
      const rotated = await rotateRefreshToken(prisma, original.refreshToken, secret, new Date(now.getTime() + 1_000));
      const oldSession = await prisma.refreshSession.findUnique({ where: { tokenHash: hashToken(original.refreshToken) } });
      const currentSession = await prisma.refreshSession.findUnique({ where: { tokenHash: hashToken(rotated.refreshToken) } });

      // 확인
      expect(oldSession?.revokedAt).toEqual(new Date(now.getTime() + 1_000));
      expect(oldSession?.replacedById).toBe(currentSession?.id);
      expect(currentSession?.familyId).toBe(oldSession?.familyId);
      expect(currentSession?.expiresAt.getTime()).toBe(original.refreshExpiresAt);

      // 실행 및 확인
      await expect(rotateRefreshToken(prisma, original.refreshToken, secret, new Date(now.getTime() + 2_000)))
        .rejects.toMatchObject({ code: "REFRESH_TOKEN_REUSED" });

      // 확인
      expect(await prisma.refreshSession.count({ where: { familyId: oldSession?.familyId, revokedAt: null } })).toBe(0);
    });
  });

  it("위조·만료된 리프레시 토큰을 거부한다", async () => {
    await withUser(async userId => {
      // 실행 및 확인
      await expect(rotateRefreshToken(prisma, "forged-token", secret, now))
        .rejects.toMatchObject({ code: "REFRESH_TOKEN_INVALID" });

      // 준비
      const tokens = await createSessionTokens(prisma, userId, secret, now);
      await prisma.refreshSession.update({
        where: { tokenHash: hashToken(tokens.refreshToken) },
        data: { expiresAt: new Date(now.getTime() - 1) },
      });

      // 실행 및 확인
      await expect(rotateRefreshToken(prisma, tokens.refreshToken, secret, now))
        .rejects.toMatchObject({ code: "REFRESH_TOKEN_EXPIRED" });
    });
  });

  it("현재 리프레시 패밀리를 로그아웃한다", async () => {
    await withUser(async userId => {
      // 준비
      const tokens = await createSessionTokens(prisma, userId, secret, now);

      // 실행
      await revokeRefreshTokenFamily(prisma, tokens.refreshToken, now);

      // 확인
      const session = await prisma.refreshSession.findUnique({ where: { tokenHash: hashToken(tokens.refreshToken) } });
      expect(session?.revokedAt).toEqual(now);
    });
  });

  it("동시 리프레시는 하나만 허용하고 재사용 시 승리한 패밀리를 폐기한다", async () => {
    await withUser(async userId => {
      // 준비
      const tokens = await createSessionTokens(prisma, userId, secret, now);

      // 실행 및 확인
      const outcomes = await Promise.allSettled([
        rotateRefreshToken(prisma, tokens.refreshToken, secret, new Date(now.getTime() + 1_000)),
        rotateRefreshToken(prisma, tokens.refreshToken, secret, new Date(now.getTime() + 1_000)),
      ]);
      expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
      expect(await prisma.refreshSession.count({ where: { userId, revokedAt: null } })).toBe(0);
    });
  });
});
