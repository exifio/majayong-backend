import { afterAll, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { seedBlockCatalog } from "./seed.ts";
import { assertTestDatabase } from "./test-database.ts";

process.env.DATABASE_URL = assertTestDatabase(process.env.TEST_DATABASE_URL);

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

describe("A-00 시드 안전성", () => {
  it("두 번 실행해도 카탈로그 행이 중복되지 않고 기존 가격을 덮어쓰지 않는다", async () => {
    // 준비
    const code = `A00-${randomUUID()}`;
    const seed = {
      code,
      name: "A-00 test block",
      functionSummary: "A deterministic seed test fixture",
      description: "Test only",
      industryCode: "TEST",
      unitPrice: 100,
      priceBasis: "Test fixture",
    };

    try {
      // 실행
      const firstCreated = await seedBlockCatalog(prisma, [seed]);
      const secondCreated = await seedBlockCatalog(prisma, [{ ...seed, unitPrice: 999 }]);
      const rows = await prisma.blockCatalog.findMany({ where: { code } });

      // 확인
      expect(firstCreated).toBe(1);
      expect(secondCreated).toBe(0);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.unitPrice).toBe(seed.unitPrice);
    } finally {
      await prisma.blockCatalog.deleteMany({ where: { code } });
    }
  });
});
