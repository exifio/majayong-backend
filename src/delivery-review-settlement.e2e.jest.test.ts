import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { PrismaClient, Role } from "@prisma/client";
import { createApp } from "./app.ts";
import { issueAccessToken } from "./modules/identity/auth.ts";
import { requireActor } from "./modules/identity/session.ts";
import { createIntegrationServices } from "./composition.ts";
import { createHttpHandler } from "./c-app.ts";
import { createPrismaRepositories } from "./infrastructure/prisma-store.ts";
import { DepositCompletionService } from "./modules/deposit/index.ts";
import { createDraftCatalogAdapter } from "./integration/draft-catalog-adapter.ts";
import { createProfileRatingPort } from "./modules/profile/api.ts";
import { seedReservationRestaurantCatalog } from "./modules/catalog/seed.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("E2E-05/06/08 require the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const tokenSecret = "e2e-050608-token-secret-longer-than-32-chars";
const NOW = new Date("2026-11-04T05:20:00.000Z");
const userIds: string[] = [];
const draftIds: string[] = [];
const projectIds: string[] = [];
const contractIds: string[] = [];
const blockIds: string[] = [];

type Seed = {
  clientId: string;
  supplierId: string;
  projectId: string;
  contractId: string;
  interimItemId: string;
  finalItemId: string;
};

function startApp(): Promise<{ baseUrl: string; close: () => void; services: ReturnType<typeof createIntegrationServices>["services"] }> {
  const clock = { now: () => NOW };
  const ratingPort = createProfileRatingPort(db);
  const { services } = createIntegrationServices({
    prisma: db,
    webhookSecret: "e2e-webhook-secret",
    clock,
    ports: {
      marketplace: { async autoRejectCompetingApplications() { return { rejectedCount: 0 }; } },
      notifications: { async createOnce() { return { created: true }; } },
      profileReview: {
        async updateProfileReviewStats(input, tx) {
          await ratingPort.refresh(input.targetUserId, tx as never);
          return { success: true };
        },
      },
      storage: {
        async createUploadUrl() { return { uploadUrl: "https://example.invalid/upload", expiresInSec: 7200 }; },
        async createDownloadUrl() { return { downloadUrl: "https://example.invalid/download", expiresInSec: 180 }; },
      },
      catalogAdmin: {
        async executeBlockAction() { return { success: true, blockId: "block", action: "NONE" }; },
      },
    },
  });
  const handler = createHttpHandler({
    services,
    authenticate: async (req) => {
      const header = req.headers.authorization;
      const match = /^Bearer ([^\s]+)$/.exec(typeof header === "string" ? header : "");
      if (!match) return null;
      try {
        const actor = await requireActor(db, match[1]!, tokenSecret, Date.now());
        return { userId: actor.userId, role: actor.role };
      } catch {
        return null;
      }
    },
    deferUnmatched: true,
  });
  const app = createApp({
    db,
    tokenSecret,
    google: { clientId: "", clientSecret: "", redirectUri: "" },
    routers: [],
    fallback: handler,
  });
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close(), services });
    });
  });
}

async function seedActiveContract(): Promise<Seed> {
  const clientId = randomUUID();
  const supplierId = randomUUID();
  const draftId = randomUUID();
  const projectId = randomUUID();
  const applicationId = randomUUID();
  const contractId = randomUUID();
  const blockId = randomUUID();
  const interimItemId = randomUUID();
  const finalItemId = randomUUID();
  userIds.push(clientId, supplierId);
  draftIds.push(draftId);
  projectIds.push(projectId);
  contractIds.push(contractId);
  blockIds.push(blockId);

  await db.user.create({ data: { id: clientId, email: `e2e5c-${clientId}@example.invalid`, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: clientId, businessName: "카페 블루", profileCompleted: true } });
  await db.user.create({ data: { id: supplierId, email: `e2e5s-${supplierId}@example.invalid`, role: Role.SUPPLIER } });
  await db.supplierProfile.create({
    data: {
      userId: supplierId, displayName: "공급자", industryCodes: [], skills: [],
      businessType: "BUSINESS", payoutVerifiedAt: NOW,
    },
  });
  await db.draft.create({ data: { id: draftId, clientId, entryType: "SENTENCE" } });
  await db.project.create({
    data: {
      id: projectId, draftId, confirmedAt: NOW, disclosureConsentVersion: "v1",
      title: "예약 서비스", summary: "요약", industryCode: "I", requiredSkills: [],
      status: "CONTRACTED",
    },
  });
  await db.application.create({
    data: {
      id: applicationId, projectId, supplierId, specVersionNo: 1,
      totalAmount: 3_100_000, durationDays: 42, firstViewedAt: NOW, status: "ACCEPTED",
    },
  });
  await db.contract.create({
    data: {
      id: contractId, applicationId, specVersionNo: 1, status: "ACTIVE", paymentStatus: "PENDING",
      agreedAmount: 3_100_000, durationDays: 42, clientFee: 155_000, supplierFee: 155_000,
      consentDeadline: NOW, contentHash: "e2e-hash",
      depositDeadline: new Date(NOW.getTime() + 2 * 86_400_000),
      workDueAt: new Date(NOW.getTime() + 30 * 86_400_000),
      interimRatio: 50,
    },
  });
  await db.blockCatalog.create({
    data: {
      id: blockId, code: `e2e-${blockId}`, name: "예약 달력", functionSummary: "f", description: "d",
      industryCode: "I", techTags: [], unitPrice: 1_000, priceBasis: "b",
    },
  });
  await db.contractItem.createMany({
    data: [
      { id: interimItemId, contractId, blockId, title: "중간", description: "d", origin: "AGREEMENT", stage: "INTERIM" },
      { id: finalItemId, contractId, blockId, title: "최종", description: "d", origin: "AGREEMENT", stage: "FINAL" },
    ],
  });

  const repos = createPrismaRepositories(db);
  const completion = new DepositCompletionService({
    repo: repos.depositRepository,
    contractsPort: repos.contractsPort,
    marketplacePort: { async autoRejectCompetingApplications() { return { rejectedCount: 0 }; } },
    clock: { now: () => NOW },
    transactionRunner: { run: (work) => db.$transaction((tx) => work(tx as never)) },
  });
  const deposit = await repos.depositRepository.createDeposit({
    contractId, principal: 3_100_000, clientFee: 155_000, amount: 3_255_000,
    method: "CARD", status: "PENDING", idempotencyKey: `e2e-${contractId}`,
    pgKey: null, depositedAt: null,
  });
  await completion.completeDeposit({ depositId: deposit.id, pgKey: "pk-e2e" });

  return { clientId, supplierId, projectId, contractId, interimItemId, finalItemId };
}

async function req(baseUrl: string, method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function token(userId: string, role: Role): string {
  return issueAccessToken({ userId, role, expiresAt: Date.now() + 60_000 }, tokenSecret);
}

beforeAll(async () => {
  await seedReservationRestaurantCatalog(db);
});

afterAll(async () => {
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.eventLog.deleteMany({ where: { userId: { in: userIds } } });
  await db.review.deleteMany({ where: { contractId: { in: contractIds } } });
  await db.inspectionRequest.deleteMany({ where: { contractItem: { contractId: { in: contractIds } } } });
  await db.delivery.deleteMany({ where: { installment: { contractId: { in: contractIds } } } });
  await db.paymentEvent.deleteMany({ where: { deposit: { contractId: { in: contractIds } } } });
  await db.paymentInstallment.deleteMany({ where: { contractId: { in: contractIds } } });
  await db.escrowDeposit.deleteMany({ where: { contractId: { in: contractIds } } });
  await db.contractItem.deleteMany({ where: { contractId: { in: contractIds } } });
  await db.contract.deleteMany({ where: { id: { in: contractIds } } });
  await db.application.deleteMany({ where: { projectId: { in: projectIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.draft.deleteMany({ where: { id: { in: draftIds } } });
  await db.blockCatalog.deleteMany({ where: { id: { in: blockIds } } });
  await db.clientProfile.deleteMany({ where: { userId: { in: userIds } } });
  await db.supplierProfile.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

// 예치 완료된 계약에서 납품·검수·정산이 끝까지 진행되는지 검증한다.
describe("E2E-05 납품·검수·정산", () => {
  it("중간·최종 납품을 승인하면 두 구간이 지급되고 계약이 완료된다", async () => {
    // 준비: 예치까지 끝난 계약과 양측 토큰, 앱 기동
    const seed = await seedActiveContract();
    const clientToken = token(seed.clientId, Role.CLIENT);
    const supplierToken = token(seed.supplierId, Role.SUPPLIER);
    const { baseUrl, close, services } = await startApp();

    try {
      // 실행: 계약의 정산 구간 조회
      const installments = await req(baseUrl, "GET", `/api/v1/contracts/${seed.contractId}/installments`, clientToken);
      // 확인: 구간이 반환된다
      expect(installments.status).toBe(200);
      const installmentRows = installments.body.data.installments as Array<{ id: string; stage: string }>;
      const interim = installmentRows.find(row => row.stage === "INTERIM");
      const final = installmentRows.find(row => row.stage === "FINAL");
      if (!interim || !final) throw new Error("installments missing");

      for (const [installment, contractItemId] of [
        [interim, seed.interimItemId],
        [final, seed.finalItemId],
      ] as const) {
        // 실행: 구간 납품 제출
        const submitted = await req(baseUrl, "POST", `/api/v1/installments/${installment.id}/deliveries`, supplierToken, {
          items: [{ contractItemId, links: [], files: [], howToCheck: "확인" }],
        });
        // 확인: 납품이 접수된다
        expect(submitted.status).toBe(201);
        // 실행: 의뢰인 검수 승인
        const approved = await req(baseUrl, "POST", `/api/v1/contract-items/${contractItemId}/approve`, clientToken, {
          deliveryId: submitted.body.data.id,
        });
        // 확인: 승인이 처리된다
        expect(approved.status).toBe(200);
        // 실행: 구간 정산 지급
        await services.settlement.releaseInstallment({ installmentId: installment.id });
      }

      // 확인: 계약이 완료되고 두 구간이 모두 지급 상태가 된다
      const contract = await db.contract.findUniqueOrThrow({ where: { id: seed.contractId } });
      expect(contract.status).toBe("COMPLETED");
      const rows = await db.paymentInstallment.findMany({ where: { contractId: seed.contractId } });
      expect(rows.every(row => row.status === "RELEASED")).toBe(true);
    } finally {
      close();
    }
  });

  it("납품·검수·보완 단계의 역할과 상태를 거부한다", async () => {
    // 준비: 예치까지 끝난 계약, 당사자와 제3자 토큰
    const seed = await seedActiveContract();
    const clientToken = token(seed.clientId, Role.CLIENT);
    const supplierToken = token(seed.supplierId, Role.SUPPLIER);
    const outsiderId = randomUUID();
    userIds.push(outsiderId);
    await db.user.create({ data: { id: outsiderId, email: `e2e5o-${outsiderId}@example.invalid`, role: Role.CLIENT } });
    await db.clientProfile.create({ data: { userId: outsiderId, businessName: "다른 가게", profileCompleted: true } });
    const outsiderToken = token(outsiderId, Role.CLIENT);
    const { baseUrl, close } = await startApp();

    try {
      // 준비: 구간 확인
      const installments = await req(baseUrl, "GET", `/api/v1/contracts/${seed.contractId}/installments`, clientToken);
      expect(installments.status).toBe(200);
      const interim = (installments.body.data.installments as Array<{ id: string; stage: string }>)
        .find(row => row.stage === "INTERIM");
      if (!interim) throw new Error("interim installment missing");

      // 실행 및 확인: 제3자는 정산 구간을 볼 수 없다
      const outsiderInstallments = await req(baseUrl, "GET", `/api/v1/contracts/${seed.contractId}/installments`, outsiderToken);
      expect(outsiderInstallments.status).toBe(403);

      // 실행 및 확인: 의뢰인은 납품을 제출할 수 없다
      const clientSubmit = await req(baseUrl, "POST", `/api/v1/installments/${interim.id}/deliveries`, clientToken, {
        items: [{ contractItemId: seed.interimItemId, links: [], files: [], howToCheck: "확인" }],
      });
      expect(clientSubmit.status).toBe(403);

      // 실행: 공급자가 중간 항목을 납품한다
      const submitted = await req(baseUrl, "POST", `/api/v1/installments/${interim.id}/deliveries`, supplierToken, {
        items: [{ contractItemId: seed.interimItemId, links: [], files: [], howToCheck: "확인" }],
      });
      // 확인: 납품이 접수된다
      expect(submitted.status).toBe(201);

      // 실행 및 확인: 공급자는 자기 납품을 승인할 수 없다
      const supplierApprove = await req(baseUrl, "POST", `/api/v1/contract-items/${seed.interimItemId}/approve`, supplierToken, {
        deliveryId: submitted.body.data.id,
      });
      expect(supplierApprove.status).toBe(403);

      // 실행 및 확인: 제3자는 승인할 수 없다
      const outsiderApprove = await req(baseUrl, "POST", `/api/v1/contract-items/${seed.interimItemId}/approve`, outsiderToken, {
        deliveryId: submitted.body.data.id,
      });
      expect(outsiderApprove.status).toBe(403);

      // 실행 및 확인: 보완 사유가 올바르지 않으면 400
      const badRework = await req(baseUrl, "POST", `/api/v1/contract-items/${seed.interimItemId}/rework-requests`, clientToken, {
        deliveryId: submitted.body.data.id,
        reason: "UNKNOWN",
        note: "사유",
      });
      expect(badRework.status).toBe(400);

      // 실행 및 확인: 보완 사유 설명이 없으면 400
      const noNote = await req(baseUrl, "POST", `/api/v1/contract-items/${seed.interimItemId}/rework-requests`, clientToken, {
        deliveryId: submitted.body.data.id,
        reason: "NOT_WORKING",
      });
      expect(noNote.status).toBe(400);

      // 실행: 의뢰인이 보완을 요청한다
      const rework = await req(baseUrl, "POST", `/api/v1/contract-items/${seed.interimItemId}/rework-requests`, clientToken, {
        deliveryId: submitted.body.data.id,
        reason: "NOT_WORKING",
        note: "버튼이 동작하지 않습니다",
      });
      // 확인: 보완 요청이 접수된다
      expect(rework.status).toBe(201);
      const inspectionRequestId = rework.body.data.id as string;

      // 실행: 의뢰인이 운영자 이견 개입을 요청한다
      const escalated = await req(baseUrl, "POST", `/api/v1/inspection-requests/${inspectionRequestId}/escalate`, clientToken, {
        reason: "판단이 필요합니다",
        what: "버튼 동작 여부",
      });
      // 확인: 이견 개입 상태가 된다
      expect(escalated.status).toBe(200);
      expect(escalated.body.data.status).toBe("ESCALATED");

      // 준비: 운영자 계정
      const adminId = randomUUID();
      userIds.push(adminId);
      await db.user.create({ data: { id: adminId, email: `e2e5a-${adminId}@example.invalid`, role: Role.ADMIN } });
      const adminToken = token(adminId, Role.ADMIN);
      const decisionBody = {
        decision: "REWORK_VALID",
        reason: "보완이 맞습니다",
        decisionNotes: { client: "보완이 맞습니다", supplier: "보완이 필요합니다" },
      };

      // 실행 및 확인: 운영자가 아니면 판정할 수 없다
      const outsiderDecision = await req(baseUrl, "POST", `/api/v1/admin/inspection-requests/${inspectionRequestId}/decision`, outsiderToken, decisionBody);
      expect(outsiderDecision.status).toBe(403);

      // 실행: 운영자가 보완 유효로 판정한다
      const decision = await req(baseUrl, "POST", `/api/v1/admin/inspection-requests/${inspectionRequestId}/decision`, adminToken, decisionBody);
      // 확인: 판정이 저장되고 보완 요청은 다시 진행 상태(OPEN)로 돌아간다
      expect(decision.status).toBe(200);
      expect(decision.body.data.decision).toBe("REWORK_VALID");
      expect(decision.body.data.status).toBe("OPEN");

      // 실행: 공급자가 보완 항목을 다시 납품한다
      const resubmitted = await req(baseUrl, "POST", `/api/v1/installments/${interim.id}/deliveries`, supplierToken, {
        items: [{ contractItemId: seed.interimItemId, links: [], files: [], howToCheck: "재확인" }],
      });
      expect(resubmitted.status).toBe(201);

      // 실행: 의뢰인이 재납품을 승인한다
      const approved = await req(baseUrl, "POST", `/api/v1/contract-items/${seed.interimItemId}/approve`, clientToken, {
        deliveryId: resubmitted.body.data.id,
      });
      expect(approved.status).toBe(200);

      // 실행 및 확인: 승인된 항목은 보완 요청할 수 없다
      const afterApprove = await req(baseUrl, "POST", `/api/v1/contract-items/${seed.interimItemId}/rework-requests`, clientToken, {
        deliveryId: resubmitted.body.data.id,
        reason: "NOT_WORKING",
        note: "다시",
      });
      expect(afterApprove.status).toBe(409);
    } finally {
      close();
    }
  });
});

// 완료된 계약에서 양측 리뷰가 공개 평점에 반영되는지 검증한다.
describe("E2E-06 상호 리뷰", () => {
  it("완료 계약에 양측이 1회 리뷰하고 공개 평점에 반영된다", async () => {
    // 준비: 예치까지 끝난 계약과 양측 토큰, 앱 기동
    const seed = await seedActiveContract();
    const clientToken = token(seed.clientId, Role.CLIENT);
    const supplierToken = token(seed.supplierId, Role.SUPPLIER);
    const outsiderId = randomUUID();
    userIds.push(outsiderId);
    await db.user.create({ data: { id: outsiderId, email: `e2e6o-${outsiderId}@example.invalid`, role: Role.CLIENT } });
    await db.clientProfile.create({ data: { userId: outsiderId, businessName: "다른 가게", profileCompleted: true } });
    const outsiderToken = token(outsiderId, Role.CLIENT);
    const { baseUrl, close } = await startApp();

    try {
      // 완료 상태를 서비스 계층에서 먼저 만든다(리뷰 흐름 자체는 HTTP로 검증).
      const { services } = createIntegrationServices({
        prisma: db,
        webhookSecret: "e2e-webhook-secret",
        clock: { now: () => NOW },
        ports: {
          marketplace: { async autoRejectCompetingApplications() { return { rejectedCount: 0 }; } },
          notifications: { async createOnce() { return { created: true }; } },
          profileReview: { async updateProfileReviewStats() { return { success: true }; } },
          storage: {
            async createUploadUrl() { return { uploadUrl: "u", expiresInSec: 1 }; },
            async createDownloadUrl() { return { downloadUrl: "d", expiresInSec: 1 }; },
          },
          catalogAdmin: { async executeBlockAction() { return { success: true, blockId: "b", action: "NONE" }; } },
        },
      });
      const installments = await db.paymentInstallment.findMany({ where: { contractId: seed.contractId } });
      for (const installment of installments.sort((a, b) => (a.stage === "INTERIM" ? -1 : 1))) {
        const itemId = installment.stage === "INTERIM" ? seed.interimItemId : seed.finalItemId;
        const delivery = await services.deliveries.submitDelivery(
          { userId: seed.supplierId, role: "SUPPLIER" },
          { installmentId: installment.id, items: [{ contractItemId: itemId, links: [], files: [], howToCheck: "확인" }] },
        );
        await services.deliveries.approveItem(
          { userId: seed.clientId, role: "CLIENT" },
          { contractItemId: itemId, deliveryId: delivery.id },
        );
        await services.settlement.releaseInstallment({ installmentId: installment.id });
      }

      // 실행: 의뢰인 리뷰 작성
      const clientReview = await req(baseUrl, "POST", `/api/v1/contracts/${seed.contractId}/reviews`, clientToken, {
        rating: 5, comment: "좋았습니다",
      });
      // 확인: 의뢰인 리뷰가 저장된다
      expect(clientReview.status).toBe(201);

      // 실행 및 확인: 같은 의뢰인이 다시 리뷰하면 409
      const duplicateReview = await req(baseUrl, "POST", `/api/v1/contracts/${seed.contractId}/reviews`, clientToken, {
        rating: 5, comment: "또",
      });
      expect(duplicateReview.status).toBe(409);

      // 실행 및 확인: 계약 당사자가 아니면 리뷰할 수 없다
      const outsiderReview = await req(baseUrl, "POST", `/api/v1/contracts/${seed.contractId}/reviews`, outsiderToken, {
        rating: 5, comment: "제3자",
      });
      expect(outsiderReview.status).toBe(403);

      // 실행 및 확인: 별점 범위를 벗어나면 400
      const invalidRating = await req(baseUrl, "POST", `/api/v1/contracts/${seed.contractId}/reviews`, supplierToken, {
        rating: 6, comment: "범위 밖",
      });
      expect(invalidRating.status).toBe(400);

      // 실행: 공급자 리뷰 작성
      const supplierReview = await req(baseUrl, "POST", `/api/v1/contracts/${seed.contractId}/reviews`, supplierToken, {
        rating: 4, comment: "감사합니다",
      });
      // 확인: 공급자 리뷰가 저장된다
      expect(supplierReview.status).toBe(201);

      // 실행: 계약 리뷰 목록 조회
      const list = await req(baseUrl, "GET", `/api/v1/contracts/${seed.contractId}/reviews`, clientToken);
      // 확인: 두 건이 조회된다
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(2);

      // 확인: 공급자 프로필 평점에 반영된다
      const profile = await db.supplierProfile.findUniqueOrThrow({ where: { userId: seed.supplierId } });
      expect(profile.ratingAvg).toBe(5);
      expect(profile.reviewCount).toBe(1);
    } finally {
      close();
    }
  });
});

// 예치 직후 취소가 전액 환불로 정산되는지 검증한다.
describe("E2E-08 취소·전액 환불", () => {
  it("예치 직후 의뢰인 사정 취소는 전액 환불로 저장되고 지급되지 않는다", async () => {
    // 준비: 예치까지 끝난 계약과 양측 토큰, 앱 기동
    const seed = await seedActiveContract();
    const clientToken = token(seed.clientId, Role.CLIENT);
    const supplierToken = token(seed.supplierId, Role.SUPPLIER);
    const { baseUrl, close } = await startApp();

    try {
      // 실행: 의뢰인 사정으로 취소 요청
      const requested = await req(baseUrl, "POST", `/api/v1/contracts/${seed.contractId}/cancellation`, clientToken, {
        cause: "CLIENT", note: "일정이 바뀌었습니다",
      });
      // 확인: 취소 요청이 접수된다
      expect(requested.status).toBe(201);
      // 실행: 공급자 취소 동의
      const agreed = await req(baseUrl, "POST", `/api/v1/contracts/${seed.contractId}/cancellation/agree`, supplierToken);
      // 확인: 동의가 처리된다
      expect(agreed.status).toBe(200);

      // 확인: 전액 환불로 저장되고 지급은 없다
      const contract = await db.contract.findUniqueOrThrow({ where: { id: seed.contractId } });
      expect(contract.status).toBe("CANCELLED");
      expect(contract.compensationRate).toBeNull();
      expect(contract.refundAmount).toBe(3_255_000);
      expect(contract.settledAmount).toBe(0);
      const released = await db.paymentInstallment.count({
        where: { contractId: seed.contractId, status: "RELEASED" },
      });
      expect(released).toBe(0);
    } finally {
      close();
    }
  });
});
