import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "../../../tests/test-db.ts";
import {
  createPrismaNotificationTx,
} from "./prisma-adapter.ts";
import {
  createNotificationOnceInTransaction,
} from "./notifications.ts";

// G2-04: 실제 PostgreSQL의 (userId,type,targetId) unique와 경쟁 시 동작을 재현한다.
// DATABASE_URL이 없으면 skip한다(전용 테스트 DB에서만 실행, 실제/공유 DB 금지).
//
// 알려진 한계(D-10): 같은 키에 동시 삽입이 겹치면 unique 제약으로 중복 행은 생기지 않지만,
// 진 쪽 트랜잭션은 P2002로 중단되어 같은 트랜잭션 안 재조회 복구가 실패할 수 있다(요청 재시도 필요).
// 여기서는 수용 기준인 "중복 0"만 단언한다.
const hasDatabase = Boolean(testDatabaseUrl());
const NOW = new Date("2026-11-04T00:00:00.000Z");

describe("INT-G2-04: 알림 unique 재현", { skip: hasDatabase ? false : "DATABASE_URL 없음" }, () => {
  it("동시 생성 경쟁에도 (userId,type,targetId)는 1행만 남는다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const userId = randomUUID();
    const targetId = `prj-${randomUUID()}`;
    try {
      await prisma.user.create({ data: { id: userId, email: `n-${userId}@test.local`, role: "SUPPLIER" } });

      // 실행
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          prisma.$transaction((tx) =>
            createNotificationOnceInTransaction(createPrismaNotificationTx(tx as never), {
              userId,
              type: "PROJECT_CLOSED",
              targetId,
              now: NOW,
            }),
          ),
        ),
      );

      // 확인
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      assert.ok(fulfilled.length >= 1, "동시 요청 중 최소 한 건은 성공해야 한다");
      assert.equal(await prisma.notification.count({ where: { userId, type: "PROJECT_CLOSED", targetId } }), 1);
    } finally {
      await prisma.notification.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    }
  });

  it("기한 알림은 dueAt payload와 함께 1회만 저장된다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const userId = randomUUID();
    const contractId = `ctr-${randomUUID()}`;
    const dueAt = new Date("2026-11-07T14:59:59.000Z");
    try {
      await prisma.user.create({ data: { id: userId, email: `n2-${userId}@test.local`, role: "CLIENT" } });

      // 실행

      const once = () =>
        prisma.$transaction((tx) =>
          createNotificationOnceInTransaction(createPrismaNotificationTx(tx as never), {
            userId,
            type: "DEPOSIT_DUE",
            targetId: contractId,
            payload: { dueAt: dueAt.toISOString() },
            now: NOW,
          }),
        );

      assert.equal((await once()).created, true);
      assert.equal((await once()).created, false);

      // 확인
      const rows = await prisma.notification.findMany({ where: { userId, type: "DEPOSIT_DUE", targetId: contractId } });
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0]?.payload, { dueAt: dueAt.toISOString() });
    } finally {
      await prisma.notification.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    }
  });
});
