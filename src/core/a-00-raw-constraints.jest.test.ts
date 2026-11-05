import { afterAll, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-database.ts";
import { withA00Fixture } from "../../tests/a/fixtures/a00.ts";

process.env.DATABASE_URL = assertTestDatabase(process.env.TEST_DATABASE_URL);

const prisma = new PrismaClient();
type Tx = Prisma.TransactionClient;

async function expectPgViolation(tx: Tx, sql: () => Promise<unknown>, code: "23505" | "23514") {
  await tx.$executeRawUnsafe("SAVEPOINT expected_constraint_violation");
  try {
    await sql();
  } catch (error) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT expected_constraint_violation");
    const pgCode = error instanceof Prisma.PrismaClientKnownRequestError
      ? error.meta?.code
      : undefined;
    expect(pgCode).toBe(code);
    return;
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT expected_constraint_violation");
  throw new Error(`Expected PostgreSQL constraint violation ${code}`);
}

afterAll(async () => prisma.$disconnect());

describe("v0.7 원시 PostgreSQL 제약", () => {
  it("DB-01 프로젝트당 수락된 지원은 하나만 허용한다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 준비
    const otherId = randomUUID();
    await tx.$executeRaw`INSERT INTO applications
      (id, "projectId", "supplierId", "specVersionNo", "totalAmount", "durationDays", "firstViewedAt", status)
      VALUES (${otherId}, ${f.projectId}, ${f.otherSupplierId}, 1, 100, 1, now(), 'ACCEPTED')`;

    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`UPDATE applications SET status = 'ACCEPTED' WHERE id = ${f.applicationId}`, "23505");
  }));

  it("DB-02 프로젝트·공급자당 활성 지원은 하나만 허용한다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`INSERT INTO applications
      (id, "projectId", "supplierId", "revisionNo", "specVersionNo", "totalAmount", "durationDays", "firstViewedAt", status)
      VALUES (${randomUUID()}, ${f.projectId}, ${f.supplierId}, 2, 1, 100, 1, now(), 'ACCEPTED')`, "23505");
  }));

  it("DB-03 모집 시작이 마감 이후면 거부한다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`UPDATE projects
      SET "recruitStartAt" = now() + interval '2 days', deadline = now() + interval '1 day'
      WHERE id = ${f.projectId}`, "23514");
    await expectPgViolation(tx, () => tx.$executeRaw`UPDATE projects
      SET "recruitStartAt" = now() + interval '1 day', deadline = now() + interval '1 day'
      WHERE id = ${f.projectId}`, "23514");
  }));

  it("DB-04 중복 방지 키가 없는 콜백 이벤트를 거부한다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`INSERT INTO payment_events (id, "depositId", "eventType")
      VALUES (${randomUUID()}, ${f.depositId}, 'CALLBACK_RECEIVED')`, "23514");
  }));

  it("DB-05 계약당 열린 예치는 하나만 허용한다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`INSERT INTO escrow_deposits
      (id, "contractId", principal, "clientFee", amount, "idempotencyKey", status)
      VALUES (${randomUUID()}, ${f.contractId}, 100, 5, 105, ${randomUUID()}, 'HELD')`, "23505");
  }));

  it("DB-06 보상 비율 범위와 의뢰인 최소값을 강제한다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`UPDATE contracts
      SET "cancelCause" = 'CLIENT', "compensationRate" = 49 WHERE id = ${f.contractId}`, "23514");
  }));

  it("DB-07 중간 비율이 10~90 밖이면 거부한다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`UPDATE contracts SET "interimRatio" = 9 WHERE id = ${f.contractId}`, "23514");
  }));

  it("DB-08 자기 자신으로 병합된 블록을 거부한다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`UPDATE block_catalog SET "mergedIntoId" = id WHERE id = ${f.blockId}`, "23514");
  }));

  it("DB-09 리뷰 평점을 1~5로 강제한다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`INSERT INTO reviews
      (id, "contractId", "reviewerId", "revieweeId", "reviewerRole", rating)
      VALUES (${randomUUID()}, ${f.contractId}, ${f.reviewerId}, ${f.targetId}, 'CLIENT', 0)`, "23514");
  }));

  it("DB-10 같은 신고자의 중복 열린 신고를 막는다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`INSERT INTO reports
      (id, "messageId", "reporterId", "targetUserId", reason)
      VALUES (${randomUUID()}, ${f.messageId}, ${f.reporterId}, ${f.targetId}, 'OTHER')`, "23505");
  }));

  it("DB-03·DB-06·DB-07·DB-09는 문서화된 경계값을 허용한다", async () => withA00Fixture(prisma, async (tx, f) => {
    // 실행
    await tx.$executeRaw`UPDATE projects SET "recruitStartAt" = now() + interval '1 day' - interval '1 millisecond',
      deadline = now() + interval '1 day' WHERE id = ${f.projectId}`;
    await tx.$executeRaw`UPDATE contracts SET "cancelCause" = 'CLIENT', "compensationRate" = 50,
      "interimRatio" = 10 WHERE id = ${f.contractId}`;
    await tx.$executeRaw`UPDATE contracts SET "compensationRate" = 100, "interimRatio" = 90
      WHERE id = ${f.contractId}`;
    await tx.$executeRaw`INSERT INTO reviews
      (id, "contractId", "reviewerId", "revieweeId", "reviewerRole", rating)
      VALUES (${randomUUID()}, ${f.contractId}, ${f.reviewerId}, ${f.targetId}, 'CLIENT', 1)`;
    await tx.$executeRaw`INSERT INTO reviews
      (id, "contractId", "reviewerId", "revieweeId", "reviewerRole", rating)
      VALUES (${randomUUID()}, ${f.contractId}, ${f.reporterId}, ${f.targetId}, 'CLIENT', 5)`;

    // 실행 및 확인
    await expectPgViolation(tx, () => tx.$executeRaw`UPDATE contracts
      SET "compensationRate" = 101 WHERE id = ${f.contractId}`, "23514");
  }));
});
