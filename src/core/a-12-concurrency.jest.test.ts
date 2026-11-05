import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-database.ts";

process.env.DATABASE_URL = assertTestDatabase(process.env.TEST_DATABASE_URL);
const url = process.env.DATABASE_URL!;
const db = new PrismaClient({ datasources: { db: { url } } });
const db2 = new PrismaClient({ datasources: { db: { url } } });

describe("PostgreSQL 동시성 보호", () => {
  const ids = {
    clientId: randomUUID(),
    supplierId: randomUUID(),
    otherSupplierId: randomUUID(),
    reporterId: randomUUID(),
    targetId: randomUUID(),
    reviewerId: randomUUID(),
    draftId: randomUUID(),
    projectId: randomUUID(),
    applicationId: randomUUID(),
    contractId: randomUUID(),
    depositId: randomUUID(),
  };

  beforeAll(async () => {
    await db.$executeRaw`INSERT INTO users (id, email, role, "updatedAt") VALUES (${ids.clientId}, ${ids.clientId + "@example.invalid"}, 'CLIENT'::"Role", now())`;
    await db.$executeRaw`INSERT INTO users (id, email, role, "updatedAt") VALUES (${ids.supplierId}, ${ids.supplierId + "@example.invalid"}, 'SUPPLIER'::"Role", now())`;
    await db.$executeRaw`INSERT INTO supplier_profiles ("userId", "displayName") VALUES (${ids.supplierId}, 'supplier')`;
    await db.$executeRaw`INSERT INTO drafts (id, "clientId", "entryType") VALUES (${ids.draftId}, ${ids.clientId}, 'SENTENCE')`;
    await db.$executeRaw`INSERT INTO projects (id, "draftId", "confirmedAt", "disclosureConsentVersion", title, summary, "industryCode") VALUES (${ids.projectId}, ${ids.draftId}, now(), 'v1', 'fixture', 'fixture', 'TEST')`;
    await db.$executeRaw`INSERT INTO applications (id, "projectId", "supplierId", "specVersionNo", "totalAmount", "durationDays", "firstViewedAt") VALUES (${ids.applicationId}, ${ids.projectId}, ${ids.supplierId}, 1, 100, 1, now())`;
    await db.$executeRaw`INSERT INTO contracts (id, "applicationId", "specVersionNo", "agreedAmount", "durationDays", "clientFee", "supplierFee", "consentDeadline", "contentHash") VALUES (${ids.contractId}, ${ids.applicationId}, 1, 100, 1, 5, 5, now(), 'fixture')`;
    await db.$executeRaw`INSERT INTO escrow_deposits (id, "contractId", principal, "clientFee", amount, "idempotencyKey") VALUES (${ids.depositId}, ${ids.contractId}, 100, 5, 105, ${randomUUID()})`;
  });

  afterAll(async () => {
    await db.$executeRaw`DELETE FROM payment_events WHERE "depositId" = ${ids.depositId}`;
    await db.$executeRaw`DELETE FROM payment_installments WHERE "contractId" = ${ids.contractId}`;
    await db.$executeRaw`DELETE FROM escrow_deposits WHERE id = ${ids.depositId}`;
    await db.$executeRaw`DELETE FROM contracts WHERE id = ${ids.contractId}`;
    await db.$executeRaw`DELETE FROM applications WHERE id = ${ids.applicationId}`;
    await db.$executeRaw`DELETE FROM projects WHERE id = ${ids.projectId}`;
    await db.$executeRaw`DELETE FROM drafts WHERE id = ${ids.draftId}`;
    await db.$executeRaw`DELETE FROM supplier_profiles WHERE "userId" = ${ids.supplierId}`;
    await db.$executeRaw`DELETE FROM users WHERE id IN (${ids.clientId}, ${ids.supplierId})`;
    await db.$disconnect();
    await db2.$disconnect();
  });

  it("예치·중복 방지 키당 결제 이벤트는 하나만 허용한다", async () => {
    // 준비
    const dedupKey = randomUUID();

    // 실행
    const [a, b] = await Promise.allSettled([
      db.$executeRaw`INSERT INTO payment_events (id, "depositId", "eventType", "dedupKey") VALUES (${randomUUID()}, ${ids.depositId}, 'VERIFIED', ${dedupKey})`,
      db2.$executeRaw`INSERT INTO payment_events (id, "depositId", "eventType", "dedupKey") VALUES (${randomUUID()}, ${ids.depositId}, 'VERIFIED', ${dedupKey})`,
    ]);

    // 확인
    expect([a, b].filter((r) => r.status === "fulfilled").length).toBe(1);
    expect([a, b].filter((r) => r.status === "rejected").length).toBe(1);
  });

  it("계약·단계당 지급 구간은 하나만 허용한다", async () => {
    // 실행
    const [a, b] = await Promise.allSettled([
      db.$executeRaw`INSERT INTO payment_installments (id, "contractId", stage, ratio, amount, "supplierFee", "releaseAmount") VALUES (${randomUUID()}, ${ids.contractId}, 'INTERIM', 50, 50, 2, 48)`,
      db2.$executeRaw`INSERT INTO payment_installments (id, "contractId", stage, ratio, amount, "supplierFee", "releaseAmount") VALUES (${randomUUID()}, ${ids.contractId}, 'INTERIM', 50, 50, 2, 48)`,
    ]);

    // 확인
    expect([a, b].filter((r) => r.status === "fulfilled").length).toBe(1);
    expect([a, b].filter((r) => r.status === "rejected").length).toBe(1);
  });
});
