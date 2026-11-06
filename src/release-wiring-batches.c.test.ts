import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  DepositService,
  DepositCompletionService,
  createInMemoryDepositRepository,
  runDueJobs,
} from "./modules/deposit/index.ts";
import {
  DeliveryService,
  InspectionBatchService,
  createInMemoryDeliveryRepository,
} from "./modules/delivery/index.ts";
import {
  SettlementService,
  createInMemorySettlementRepository,
} from "./modules/settlement/policy.ts";
import {
  CancellationService,
  createInMemoryCancellationRepository,
} from "./modules/cancellation/index.ts";
import {
  ReviewService,
  createInMemoryReviewRepository,
} from "./modules/review/index.ts";
import { AdminOpsService } from "./modules/admin-ops/index.ts";
import { createSharedStore } from "../tests/c/fixtures/shared-store.ts";

describe("C-10: 배포용 기한 작업·전영역 연결 검증·인계", () => {
  const t0 = new Date("2026-11-04T05:20:00.000Z"); // 14:20 KST 체결 & 예치
  const t1 = new Date("2026-11-25T10:00:00.000Z"); // 중간 납품
  const t2 = new Date("2026-12-02T10:00:00.000Z"); // 7일 후 중간 자동 승인
  const t3 = new Date("2026-12-10T10:00:00.000Z"); // 최종 납품
  const t4 = new Date("2026-12-17T10:00:00.000Z"); // 최종 승인 & 완료
  const t5 = new Date("2026-12-18T10:00:00.000Z"); // 리뷰 작성

  const WEBHOOK_SECRET = "0123456789abcdef".repeat(4);

  function sendWebhook(service: DepositService, payload: unknown) {
    const rawPayload = Buffer.from(JSON.stringify(payload) ?? "null", "utf8");
    const transmissionTime = t0.toISOString();
    const signature = createHmac("sha256", Buffer.from(WEBHOOK_SECRET, "hex"))
      .update(rawPayload)
      .update(":")
      .update(transmissionTime)
      .digest("base64");
    return service.handleTossWebhook(
      { rawPayload, transmissionTime, signature: `v1:${signature}` },
      payload,
    );
  }

  function createFullContext() {
    const depositRepo = createInMemoryDepositRepository();
    const deliveryRepo = createInMemoryDeliveryRepository();
    const settlementRepo = createInMemorySettlementRepository();
    const cancelRepo = createInMemoryCancellationRepository();
    const reviewRepo = createInMemoryReviewRepository();

    const notificationsSent: Array<{ userId: string; type: string; targetId: string }> = [];
    const notificationPorts = {
      async createOnce(input: { userId: string; type: string; targetId: string }) {
        const key = `${input.userId}:${input.type}:${input.targetId}`;
        if (!notificationsSent.some((n) => `${n.userId}:${n.type}:${n.targetId}` === key)) {
          notificationsSent.push(input);
          return { created: true };
        }
        return { created: false };
      },
    };

    let competingRejected = false;
    const marketplacePort = {
      async autoRejectCompetingApplications(input: { projectId: string; acceptedApplicationId: string }) {
        competingRejected = true;
        return { rejectedCount: 2 };
      },
    };

    let profileReviewStatsUpdated = false;
    const profilePorts = {
      async updateProfileReviewStats() {
        profileReviewStatsUpdated = true;
        return { success: true };
      },
    };

    const contract = {
      id: "contract-e2e-10",
      projectId: "proj-10",
      applicationId: "app-10",
      clientUserId: "client-10",
      supplierUserId: "supplier-10",
      status: "ACTIVE" as const,
      paymentStatus: "PENDING" as const,
      agreedAmount: 3_100_000,
      clientFee: 155_000,
      totalDeposited: 0,
      interimRatio: 50,
      durationDays: 42,
      depositDeadline: new Date("2026-11-07T14:59:59.000Z"),
      workDueAt: null as Date | null,
      supplierKind: "INDIVIDUAL" as const,
      payoutVerifiedAt: new Date("2026-11-01T00:00:00.000Z"),
    };

    const contractsPort = {
      async getContract(id: string) {
        if (id === contract.id) return contract;
        return null;
      },
      async updateContract(id: string, patch: Partial<typeof contract>) {
        Object.assign(contract, patch);
        return contract;
      },
    };

    let currentTime = t0;
    const clock = { now: () => currentTime, set: (d: Date) => { currentTime = d; } };

    const completionService = new DepositCompletionService({
      repo: depositRepo,
      contractsPort,
      marketplacePort,
      clock,
    });

    const depositService = new DepositService({
      repo: depositRepo,
      contractsPort,
      webhookSecret: WEBHOOK_SECRET,
      tossAdapter: {
        async verifyPayment(orderId, paymentKey, amount) {
          return { verified: true, orderId, paymentKey, amount, status: "DONE" };
        },
      },
      completionPort: completionService,
      clock,
    });

    const deliveryService = new DeliveryService({
      repo: deliveryRepo,
      clock,
    });

    const batchService = new InspectionBatchService({
      repo: deliveryRepo,
      notificationPorts,
      clock,
    });

    const settlementService = new SettlementService({
      repo: settlementRepo,
      clock,
    });

    const cancellationService = new CancellationService({
      repo: cancelRepo,
      clock,
    });

    const reviewService = new ReviewService({
      repo: reviewRepo,
      profilePorts,
      clock,
    });

    return {
      depositRepo,
      deliveryRepo,
      settlementRepo,
      cancelRepo,
      reviewRepo,
      contract,
      clock,
      depositService,
      completionService,
      deliveryService,
      batchService,
      settlementService,
      cancellationService,
      reviewService,
      notificationsSent,
      getCompetingRejected: () => competingRejected,
      getProfileReviewStatsUpdated: () => profileReviewStatsUpdated,
    };
  }

  function createSharedContext() {
    const store = createSharedStore({
      id: "contract-e2e-10",
      projectId: "proj-10",
      applicationId: "app-10",
      clientUserId: "client-10",
      supplierUserId: "supplier-10",
      status: "ACTIVE",
      paymentStatus: "PENDING",
      agreedAmount: 3_100_000,
      clientFee: 155_000,
      interimRatio: 50,
      durationDays: 42,
      depositDeadline: new Date("2026-11-07T14:59:59.000Z"),
      supplierKind: "INDIVIDUAL",
      payoutVerifiedAt: new Date("2026-11-01T00:00:00.000Z"),
    });

    const notificationsSent: Array<{ userId: string; type: string; targetId: string }> = [];
    const notificationPorts = {
      async createOnce(input: { userId: string; type: string; targetId: string }) {
        const key = `${input.userId}:${input.type}:${input.targetId}`;
        if (!notificationsSent.some((n) => `${n.userId}:${n.type}:${n.targetId}` === key)) {
          notificationsSent.push(input);
          return { created: true };
        }
        return { created: false };
      },
    };

    let competingRejected = false;
    const marketplacePort = {
      async autoRejectCompetingApplications() {
        competingRejected = true;
        return { rejectedCount: 2 };
      },
    };

    let profileReviewStatsUpdated = false;
    const profilePorts = {
      async updateProfileReviewStats() {
        profileReviewStatsUpdated = true;
        return { success: true };
      },
    };

    let currentTime = t0;
    const clock = {
      now: () => currentTime,
      set: (date: Date) => {
        currentTime = date;
      },
    };

    const settlementService = new SettlementService({ repo: store.settlementRepository, clock });
    const completionService = new DepositCompletionService({
      repo: store.depositRepository,
      contractsPort: store.contractsPort,
      marketplacePort,
      clock,
    });
    const depositService = new DepositService({
      repo: store.depositRepository,
      contractsPort: store.contractsPort,
      webhookSecret: WEBHOOK_SECRET,
      tossAdapter: {
        async verifyPayment(orderId, paymentKey, amount) {
          return { verified: true, orderId, paymentKey, amount, status: "DONE" };
        },
      },
      completionPort: completionService,
      clock,
    });
    const deliveryService = new DeliveryService({
      repo: store.deliveryRepository,
      clock,
      settlementPort: settlementService,
    });
    const batchService = new InspectionBatchService({
      repo: store.deliveryRepository,
      notificationPorts,
      clock,
      settlementPort: settlementService,
    });
    const cancellationService = new CancellationService({ repo: store.cancellationRepository, clock });
    const reviewService = new ReviewService({ repo: store.reviewRepository, profilePorts, clock });
    const adminService = new AdminOpsService({
      repo: store.adminRepository,
      catalogPort: {
        async executeBlockAction(input) {
          return { success: true, blockId: input.blockId, action: input.action };
        },
      },
      depositPort: completionService,
      inspectionPort: batchService,
      cancellationPort: cancellationService,
      clock,
    });

    return {
      store,
      contract: store.contract,
      clock,
      depositService,
      completionService,
      deliveryService,
      batchService,
      settlementService,
      cancellationService,
      reviewService,
      adminService,
      notificationsSent,
      getCompetingRejected: () => competingRejected,
      getProfileReviewStatsUpdated: () => profileReviewStatsUpdated,
    };
  }

  async function completeDeposit(ctx: ReturnType<typeof createSharedContext>) {
    const { deposit } = await ctx.depositService.createDeposit(
      { userId: ctx.contract.clientUserId, role: "CLIENT" },
      {
        contractId: ctx.contract.id,
        idempotencyKey: `idem-${Math.random()}`,
        method: "CARD",
        amount: 3_255_000,
      },
    );
    await sendWebhook(ctx.depositService, {
      orderId: deposit.id,
      paymentKey: "toss_pk_shared",
      amount: 3_255_000,
      status: "DONE",
    });
    const installments = (await ctx.store.depositRepository.listInstallments(ctx.contract.id)) as Array<{
      id: string;
      stage: "INTERIM" | "FINAL";
    }>;
    return { deposit, installments };
  }

  function seedItems(ctx: ReturnType<typeof createSharedContext>) {
    ctx.store.seedContractItems([
      {
        id: "item-1",
        contractId: ctx.contract.id,
        stage: "INTERIM",
        title: "중간 기능",
        description: "기능",
        conditions: [],
        approvedAt: null,
        autoApproved: false,
      },
      {
        id: "item-2",
        contractId: ctx.contract.id,
        stage: "FINAL",
        title: "최종 기능",
        description: "기능",
        conditions: [],
        approvedAt: null,
        autoApproved: false,
      },
    ]);
  }

  it("C-10-T01 배치 두 번 실행해도 결과 동일", async () => {
    // 준비: 취소 요청 상태의 계약과 기한 배치
    const ctx = createFullContext();
    const runTime = new Date("2026-11-15T00:00:00.000Z");
    const requestedAt = new Date("2026-11-10T00:00:00.000Z");

    ctx.cancelRepo.seedContract({
      id: ctx.contract.id,
      clientUserId: ctx.contract.clientUserId,
      supplierUserId: ctx.contract.supplierUserId,
      status: "CANCEL_REQUESTED",
      paymentStatus: "DEPOSITED",
      agreedAmount: ctx.contract.agreedAmount,
      clientFee: ctx.contract.clientFee,
      totalDeposited: 3_255_000,
      interimRatio: 50,
      depositedAt: t0,
      cancelCause: "CLIENT",
      cancelRequestedBy: ctx.contract.clientUserId,
      cancelRequestedAt: requestedAt,
      cancelNote: "무응답",
      objectionNote: null,
      objectionRate: null,
      cancelEvidence: null,
      cancelEscalatedAt: null,
      compensationRate: null,
      cancelResolution: null,
      cancelResolvedAt: null,
      refundAmount: null,
      clientFeeRefund: null,
      settledAmount: null,
      refundReason: null,
      refundedAt: null,
      cancelPayoutAt: null,
    });

    const job = {
      completionService: ctx.completionService,
      cancellationService: ctx.cancellationService,
      batchService: ctx.batchService,
      depositContractIds: [ctx.contract.id],
      cancellationContractIds: [ctx.contract.id],
    };

    // 실행: 같은 시각으로 기한 배치를 두 번 실행
    const res1 = await runDueJobs(job, runTime);
    const res2 = await runDueJobs(job, runTime);

    // 확인: 1회차만 처리되고 2회차는 변경 없음
    assert.equal(res1.success, true);
    assert.equal(res1.actionsCount, 2);
    assert.equal(res2.success, true);
    assert.equal(res2.actionsCount, 0);
    assert.equal(ctx.contract.status, "CANCELLED");
    const cancel = await ctx.cancelRepo.getContract(ctx.contract.id);
    assert.equal(cancel?.cancelEscalatedAt?.toISOString(), runTime.toISOString());
  });

  it("C-10-T02 수동 처리와 자동 배치 동시 충돌", async () => {
    // 준비: 예치 생성 후 기한 경과 시점
    const ctx = createFullContext();
    const { deposit } = await ctx.depositService.createDeposit(
      { userId: ctx.contract.clientUserId, role: "CLIENT" },
      { contractId: ctx.contract.id, idempotencyKey: "idem-t02", method: "CARD", amount: 3_255_000 },
    );
    const expireTime = new Date("2026-11-08T00:00:00.000Z");

    // 실행: 배치 판정과 수동 확정을 동시에 요청
    const batchPromise = ctx.completionService.evaluateDepositDeadline(ctx.contract.id, expireTime);
    const completePromise = ctx.completionService.completeDeposit({ depositId: deposit.id, pgKey: "pk-race-c10" });

    // 확인: 배치는 보류로, 예치는 정상 확정으로 끝난다
    const [batchRes, completeRes] = await Promise.all([batchPromise, completePromise]);
    assert.equal(batchRes.action, "HOLD_FOR_OPERATOR_REVIEW"); // 배치는 입금 시도 보고 결렬 보류
    assert.equal(completeRes.deposit.status, "COMPLETED"); // 예치는 안전하게 정상 확정
  });

  it("C-10-T03 공유 저장소로 예치→중간승인→최종승인→완료→리뷰 연결", async () => {
    // 준비: 공유 저장소와 계약 항목, 예치 완료
    const ctx = createSharedContext();
    ctx.clock.set(t0);
    const { installments } = await completeDeposit(ctx);
    assert.equal(ctx.getCompetingRejected(), true);
    assert.equal(installments.length, 2);
    const interim = installments.find((row) => row.stage === "INTERIM")!;
    const final = installments.find((row) => row.stage === "FINAL")!;
    seedItems(ctx);

    // 실행: 중간 납품과 항목 승인, 정산 승인·지급
    ctx.clock.set(t1);
    const d1 = await ctx.deliveryService.submitDelivery(
      { userId: ctx.contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: interim.id,
        items: [{ contractItemId: "item-1", links: ["https://app/interim"], files: [], howToCheck: "확인" }],
        summary: "중간 납품",
      },
    );
    await ctx.deliveryService.approveItem(
      { userId: ctx.contract.clientUserId, role: "CLIENT" },
      { contractItemId: "item-1", deliveryId: d1.id },
    );
    // 확인: 중간 구간이 승인 상태가 됨
    const approvedInterim = (await ctx.store.settlementRepository.listInstallments(ctx.contract.id)).find(
      (row) => row.stage === "INTERIM",
    );
    assert.equal(approvedInterim?.status, "APPROVED");
    // 실행: 중간 구간 지급
    const r1 = await ctx.settlementService.releaseInstallment({ installmentId: interim.id });
    assert.equal(r1.status, "RELEASED");
    assert.equal(r1.releaseAmount, 1_421_350);

    // 실행: 최종 납품 → 승인 → 지급
    ctx.clock.set(t4);
    const d2 = await ctx.deliveryService.submitDelivery(
      { userId: ctx.contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: final.id,
        items: [{ contractItemId: "item-2", links: ["https://app/final"], files: [], howToCheck: "확인" }],
        summary: "최종 납품",
      },
    );
    await ctx.deliveryService.approveItem(
      { userId: ctx.contract.clientUserId, role: "CLIENT" },
      { contractItemId: "item-2", deliveryId: d2.id },
    );
    const r2 = await ctx.settlementService.releaseInstallment({ installmentId: final.id });
    // 확인: 두 구간 지급 후 계약이 완료 상태로 전이
    assert.equal(r2.status, "RELEASED");
    const finished = await ctx.store.getContract(ctx.contract.id);
    assert.equal(finished?.status, "COMPLETED");
    assert.equal(finished?.paymentStatus, "RELEASED");

    // 실행: 완료된 같은 계약으로 리뷰 작성 (재시드 없음)
    ctx.clock.set(t5);
    const review = await ctx.reviewService.createReview(
      { userId: ctx.contract.clientUserId, role: "CLIENT" },
      { contractId: ctx.contract.id, rating: 5, comment: "만족스러운 프로젝트였습니다.", tags: ["신속해요"] },
    );
    // 확인: 리뷰 저장과 평점 캐시 갱신
    assert.equal(review.rating, 5);
    assert.equal(ctx.getProfileReviewStatsUpdated(), true);
  });

  it("C-10-T04 취소 요청 중 승인·지급·자동승인·알림 실제 차단", async () => {
    // 준비: 예치와 중간 납품이 끝난 공유 계약
    const ctx = createSharedContext();
    ctx.clock.set(t0);
    const { installments } = await completeDeposit(ctx);
    const interim = installments.find((row) => row.stage === "INTERIM")!;
    seedItems(ctx);

    ctx.clock.set(t1);
    const delivery = await ctx.deliveryService.submitDelivery(
      { userId: ctx.contract.supplierUserId, role: "SUPPLIER" },
      {
        installmentId: interim.id,
        items: [{ contractItemId: "item-1", links: ["https://app/interim"], files: [], howToCheck: "확인" }],
      },
    );

    // 실행: 취소 요청 등록
    await ctx.cancellationService.requestCancellation(
      { userId: ctx.contract.clientUserId, role: "CLIENT" },
      { contractId: ctx.contract.id, cause: "CLIENT", note: "개인 사정" },
    );
    // 확인: 운영이 일시 중단됨
    assert.equal(await ctx.cancellationService.isOperationsPaused(ctx.contract.id), true);

    const client = { userId: ctx.contract.clientUserId, role: "CLIENT" };
    const admin = { userId: "admin-1", role: "ADMIN" };

    // 실행 및 확인: 승인·보완 요청·정산 승인·지급이 모두 거부됨
    await assert.rejects(
      () => ctx.deliveryService.approveItem(client, { contractItemId: "item-1", deliveryId: delivery.id }),
      /진행 중\(ACTIVE\) 계약만/,
    );
    await assert.rejects(
      () =>
        ctx.deliveryService.requestRework(client, {
          deliveryId: delivery.id,
          contractItemId: "item-1",
          reason: "NOT_WORKING",
          note: "미작동",
        }),
      /진행 중\(ACTIVE\) 계약만/,
    );
    await assert.rejects(
      () => ctx.settlementService.approveInstallment({ contractId: ctx.contract.id, installmentId: interim.id }),
      /취소 중에는/,
    );
    await assert.rejects(
      () => ctx.settlementService.releaseInstallment({ installmentId: interim.id }),
      /취소 중에는/,
    );

    // 실행: 자동 승인 배치와 기한 알림 배치
    const batch = await ctx.batchService.processAutoApproval(
      delivery.id,
      new Date(t1.getTime() + 8 * 24 * 60 * 60 * 1000),
    );
    await ctx.batchService.sendDueNotifications(ctx.contract.id, t1);
    // 확인: 자동 승인 0건, 알림 0건, 상태 변경 없음
    assert.equal(batch.autoApprovedCount, 0);
    assert.equal(ctx.notificationsSent.filter((n) => n.type === "INSPECTION_DUE").length, 0);
    assert.equal((await ctx.store.deliveryRepository.getContractItem("item-1"))?.approvedAt, null);
    const unchanged = (await ctx.store.settlementRepository.listInstallments(ctx.contract.id)).find(
      (row) => row.stage === "INTERIM",
    );
    assert.equal(unchanged?.status, "DELIVERED");
    assert.equal((await ctx.store.deliveryRepository.getDelivery(delivery.id))?.status, "SUBMITTED");

    // 실행: 공급자 이의 후 관리자 판정
    await ctx.cancellationService.objectCancellation(
      { userId: ctx.contract.supplierUserId, role: "SUPPLIER" },
      { contractId: ctx.contract.id, objectionRate: 50, note: "보상 비율 이의" },
    );
    ctx.store.adminRepository.seedCancellationQueueContract({
      id: ctx.contract.id,
      status: "CANCEL_REQUESTED",
      cancelCause: "CLIENT",
      totalDeposited: 3_255_000,
      agreedAmount: 3_100_000,
      clientFee: 155_000,
      cancelEscalatedAt: t1,
    });
    const decided = await ctx.adminService.decideCancellation(admin, ctx.contract.id, {
      compensationRate: 50,
      reason: "착수 보상 판정",
    });
    // 확인: 같은 공유 계약·구간으로 취소 판정과 감사 로그 1건
    assert.equal(decided.status, "CANCELLED");
    const cancelled = await ctx.store.getContract(ctx.contract.id);
    assert.equal(cancelled?.status, "CANCELLED");
    assert.equal(cancelled?.settledAmount, 1_472_500);
    assert.equal(
      (await ctx.store.adminRepository.listEventLogs()).filter(
        (log) => log.actionType === "CANCELLATION_ADMIN_DECIDED",
      ).length,
      1,
    );
  });

  it("C-10-F01 기한 대상 조회·재시도·중복 방지", async () => {
    // 준비: 일시 실패하는 기한 작업 포트
    let depositAttempts = 0;
    let secondRun = false;
    const notified: string[] = [];
    const context = {
      targets: {
        async depositContractIds() {
          return ["contract-dep"];
        },
        async cancellationContractIds() {
          return ["contract-cancel"];
        },
        async deliveryIds() {
          return ["delivery-1"];
        },
        async notificationContractIds() {
          return ["contract-noti"];
        },
      },
      completionService: {
        async expireDepositIfDue() {
          depositAttempts += 1;
          if (depositAttempts === 1) throw new Error("TRANSIENT_DB");
          return { expired: !secondRun };
        },
      },
      cancellationService: {
        async checkCancellationDeadlines() {
          return { escalatedToAdmin: !secondRun };
        },
      },
      batchService: {
        async processAutoApproval() {
          return { autoApprovedCount: secondRun ? 0 : 1 };
        },
        async sendDueNotifications(contractId: string) {
          notified.push(contractId);
        },
      },
      retries: 1,
    };

    // 실행: 1회차 기한 배치
    const first = await runDueJobs(context, t0);
    // 확인: 일시 실패는 1회 재시도로 복구되고 작업 3건이 처리됨
    assert.equal(first.success, true);
    assert.equal(depositAttempts, 2); // 일시 실패 후 1회 재시도
    assert.equal(first.actionsCount, 3);
    assert.deepEqual(notified, ["contract-noti"]);

    // 실행: 같은 조건으로 2회차 실행
    secondRun = true;
    const second = await runDueJobs(context, t0);
    // 확인: 재실행은 멱등이라 작업 0건
    assert.equal(second.success, true);
    assert.equal(second.actionsCount, 0); // 재실행 멱등
  });

  it("C-10-F01b 일부 작업이 계속 실패해도 나머지는 처리하고 실패를 드러냄", async () => {
    // 실행: 한 계약은 계속 실패하는 기한 배치
    const result = await runDueJobs(
      {
        depositContractIds: ["c-fail", "c-ok"],
        completionService: {
          async expireDepositIfDue(contractId) {
            if (contractId === "c-fail") throw new Error("PERSISTENT");
            return { expired: true };
          },
        },
        retries: 1,
      },
      t0,
    );
    // 확인: 나머지는 처리되고 실패 내역은 별도로 보고됨
    assert.equal(result.success, false);
    assert.equal(result.actionsCount, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].job, "DEPOSIT_DEADLINE");
    assert.equal(result.failures[0].targetId, "c-fail");
    assert.equal(result.failures[0].attempts, 2);
    assert.match(result.failures[0].error, /PERSISTENT/);
  });

  it("C-10-T05 비밀정보 로깅 0", async () => {
    // 준비: 예치 생성
    const ctx = createFullContext();
    const { deposit } = await ctx.depositService.createDeposit(
      { userId: ctx.contract.clientUserId, role: "CLIENT" },
      { contractId: ctx.contract.id, idempotencyKey: "idem-secret-check", method: "CARD", amount: 3_255_000 },
    );

    // 실행: Toss 웹훅 처리
    await sendWebhook(ctx.depositService, {
      orderId: deposit.id,
      paymentKey: "toss_pk_secret_check",
      amount: 3_255_000,
      status: "DONE",
    });

    // 확인: 결제 이벤트 직렬화 결과에 비밀값·비밀번호가 없음
    const events = await ctx.depositRepo.listPaymentEvents(deposit.id);
    for (const event of events) {
      const serialized = JSON.stringify(event);
      assert.equal(serialized.includes(WEBHOOK_SECRET), false);
      assert.equal(serialized.includes("password"), false);
    }
  });
});
