import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { testDatabaseUrl } from "../tests/test-db.ts";
import { createApp } from "./http/create-app.ts";
import { createDevAuthVerifier } from "./http/auth.ts";
import { createIntegrationPorts, createReportAccountActionPort } from "./integration/external-ports.ts";
import { createPrismaIntegrationDb, createPrismaPorts } from "./integration/prisma-wiring.ts";
import { createProfileRatingPort } from "./modules/profile/api.ts";
import { createPrismaRepositories } from "./infrastructure/prisma-store.ts";
import { ReviewService } from "./modules/review/index.ts";
import { createBRouters } from "./server.ts";
import { withServer } from "../tests/b/http-helpers.ts";

// G2-05: 리뷰→평점 동일 tx와 신고 제재→B 채팅 쓰기 차단을 실제 PostgreSQL/HTTP로 확인한다.
// DATABASE_URL이 없으면 skip한다(전용 테스트 DB에서만 실행, 실제/공유 DB 금지).
const hasDatabase = Boolean(testDatabaseUrl());
const NOW = new Date("2026-11-04T05:20:00.000Z");

type Ids = {
  clientId: string;
  supplierId: string;
  draftId: string;
  projectId: string;
  applicationId: string;
  contractId: string;
};

async function seed(prisma: PrismaClient): Promise<Ids> {
  const ids: Ids = {
    clientId: randomUUID(),
    supplierId: randomUUID(),
    draftId: randomUUID(),
    projectId: randomUUID(),
    applicationId: randomUUID(),
    contractId: randomUUID(),
  };
  await prisma.user.createMany({
    data: [
      { id: ids.clientId, email: `g205-c-${ids.clientId}@test.local`, role: "CLIENT" },
      { id: ids.supplierId, email: `g205-s-${ids.supplierId}@test.local`, role: "SUPPLIER" },
    ],
  });
  await prisma.clientProfile.create({ data: { userId: ids.clientId, businessName: "카페", profileCompleted: true } });
  await prisma.supplierProfile.create({
    data: {
      userId: ids.supplierId,
      displayName: "공급자",
      industryCodes: [],
      skills: [],
      businessType: "BUSINESS",
      payoutVerifiedAt: NOW,
    },
  });
  await prisma.draft.create({ data: { id: ids.draftId, clientId: ids.clientId, entryType: "SENTENCE" } });
  await prisma.project.create({
    data: {
      id: ids.projectId,
      draftId: ids.draftId,
      confirmedAt: NOW,
      disclosureConsentVersion: "v1",
      title: "예약 사이트",
      summary: "예약",
      industryCode: "FOOD",
      requiredSkills: [],
      status: "CONTRACTED",
    },
  });
  await prisma.application.create({
    data: {
      id: ids.applicationId,
      projectId: ids.projectId,
      supplierId: ids.supplierId,
      specVersionNo: 1,
      totalAmount: 3_100_000,
      durationDays: 42,
      firstViewedAt: NOW,
      status: "ACCEPTED",
    },
  });
  await prisma.contract.create({
    data: {
      id: ids.contractId,
      applicationId: ids.applicationId,
      specVersionNo: 1,
      status: "COMPLETED",
      agreedAmount: 3_100_000,
      durationDays: 42,
      clientFee: 155_000,
      supplierFee: 155_000,
      consentDeadline: NOW,
      contentHash: "hash-g205",
      paymentStatus: "RELEASED",
      interimRatio: 50,
    },
  });
  return ids;
}

async function cleanup(prisma: PrismaClient, ids: Ids): Promise<void> {
  const userIds = [ids.clientId, ids.supplierId];
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.applicationMessage.deleteMany({ where: { applicationId: ids.applicationId } });
  await prisma.review.deleteMany({ where: { contractId: ids.contractId } });
  await prisma.paymentInstallment.deleteMany({ where: { contractId: ids.contractId } });
  await prisma.contractItem.deleteMany({ where: { contractId: ids.contractId } });
  await prisma.contract.deleteMany({ where: { id: ids.contractId } });
  await prisma.application.deleteMany({ where: { id: ids.applicationId } });
  await prisma.project.deleteMany({ where: { id: ids.projectId } });
  await prisma.draft.deleteMany({ where: { id: ids.draftId } });
  await prisma.clientProfile.deleteMany({ where: { userId: ids.clientId } });
  await prisma.supplierProfile.deleteMany({ where: { userId: ids.supplierId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

describe("INT-G2-05: 계정 제재·리뷰 경계", { skip: hasDatabase ? false : "DATABASE_URL 없음" }, () => {
  it("평점 갱신이 실패하면 리뷰 저장도 함께 롤백된다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const repos = createPrismaRepositories(prisma);
      const service = new ReviewService({
        repo: repos.reviewRepository,
        profilePorts: {
          async updateProfileReviewStats() {
            throw new Error("RATING_FAILED");
          },
        },
        clock: { now: () => NOW },
        transactionRunner: {
          run: (work) => prisma.$transaction((tx) => work(tx)),
        },
      });

      // 실행 및 확인
      await assert.rejects(
        () => service.createReview(
          { userId: ids.clientId, role: "CLIENT" },
          { contractId: ids.contractId, rating: 5, comment: "좋아요" },
        ),
        /RATING_FAILED/,
      );
      // 확인
      assert.equal(await prisma.review.count({ where: { contractId: ids.contractId } }), 0);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("리뷰 저장과 A 평점 갱신이 같은 tx에서 반영된다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const repos = createPrismaRepositories(prisma);
      const ratingPort = createProfileRatingPort(prisma);
      const service = new ReviewService({
        repo: repos.reviewRepository,
        profilePorts: {
          async updateProfileReviewStats(input, tx) {
            await ratingPort.refresh(
              input.targetUserId,
              tx as Prisma.TransactionClient | undefined,
            );
            return { success: true };
          },
        },
        clock: { now: () => NOW },
        transactionRunner: {
          run: (work) => prisma.$transaction((tx) => work(tx)),
        },
      });

      // 실행
      await service.createReview(
        { userId: ids.clientId, role: "CLIENT" },
        { contractId: ids.contractId, rating: 4, comment: "좋아요" },
      );
      // 확인
      const supplier = await prisma.supplierProfile.findUniqueOrThrow({ where: { userId: ids.supplierId } });
      assert.equal(supplier.ratingAvg, 4);
      assert.equal(supplier.reviewCount, 1);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("신고 계정 제재는 B 채팅 쓰기를 차단한다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const accounts = createReportAccountActionPort(createPrismaIntegrationDb(prisma));
      // 실행
      await accounts.applyAccountAction({
        userId: ids.supplierId,
        action: "CHAT_RESTRICT_7D",
        at: NOW,
        until: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
      });

      // 준비
      const app = createApp({
        auth: createDevAuthVerifier([
          { token: "supplier", actor: { userId: ids.supplierId, role: "SUPPLIER" } },
        ]),
        routers: createBRouters(
          createPrismaPorts(prisma),
          createIntegrationPorts(createPrismaIntegrationDb(prisma), { now: () => NOW }),
        ),
      });

      await withServer(app, async (call) => {
        const path = `/api/v1/applications/${ids.applicationId}/messages`;
        // 실행 및 확인
        const restricted = await call({ method: "POST", path, token: "supplier", body: { body: "안녕하세요" } });
        assert.equal(restricted.status, 403);
        assert.equal((restricted.body as { error: { code: string } }).error.code, "CHAT_RESTRICTED");

        // 실행
        await accounts.applyAccountAction({
          userId: ids.supplierId,
          action: "SUSPEND",
          at: NOW,
          until: null,
        });
        // 실행 및 확인
        const suspended = await call({ method: "POST", path, token: "supplier", body: { body: "안녕하세요" } });
        assert.equal(suspended.status, 403);
        assert.equal((suspended.body as { error: { code: string } }).error.code, "ACCOUNT_SUSPENDED");
      });
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });
});
