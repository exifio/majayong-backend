import { afterAll, describe, expect, it } from "@jest/globals";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test") {
  throw new Error("A-01 tests require the dedicated majayong_a00_test database");
}
process.env.DATABASE_URL = databaseUrl;

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

describe("A-01 리프레시 세션 스키마", () => {
  it("패밀리 계보와 함께 해시된 회전 리프레시 토큰 세션을 저장한다", async () => {
    // 실행
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'refresh_sessions'
    `;

    // 확인
    expect(columns.map(({ column_name }) => column_name)).toEqual(expect.arrayContaining([
      "id", "userId", "familyId", "tokenHash", "expiresAt", "revokedAt", "replacedById", "createdAt",
    ]));
  });

  it("고유 토큰 해시와 인덱스 기반 패밀리 조회를 강제한다", async () => {
    // 실행
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'refresh_sessions'
    `;

    // 확인
    expect(indexes.some(({ indexdef }) => /UNIQUE.*\("tokenHash"\)/i.test(indexdef))).toBe(true);
    expect(indexes.some(({ indexdef }) => /\("familyId", "revokedAt"\)/i.test(indexdef))).toBe(true);
  });
});
