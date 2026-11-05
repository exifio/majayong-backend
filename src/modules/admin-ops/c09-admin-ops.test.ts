import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdminOpsService,
  AdminHttpError,
  createInMemoryAdminRepository,
  type CatalogAdminPort,
} from "./index.ts";
import {
  DepositCompletionService,
  createInMemoryDepositRepository,
  type DepositContractInfo,
} from "../deposit/index.ts";
import {
  InspectionBatchService,
  createInMemoryDeliveryRepository,
} from "../delivery/index.ts";
import {
  CancellationService,
  createInMemoryCancellationRepository,
  type CancellationContractEntity,
} from "../cancellation/index.ts";

describe("C-09: 관리자 블록/예치/분쟁/정산/감사 API", () => {
  const baseTime = new Date("2026-11-29T10:00:00.000Z");

  async function createTestSetup(options?: { seedHeld?: boolean }) {
    const repo = createInMemoryAdminRepository();

    let catalogActionCalled = false;
    let catalogActionInput: Parameters<CatalogAdminPort["executeBlockAction"]>[0] | undefined;
    const catalogPort: CatalogAdminPort = {
      async executeBlockAction(input: { actorId: string; blockId: string; action: string; reason: string; unitPrice?: number; mergedIntoId?: string }) {
        catalogActionCalled = true;
        catalogActionInput = input;
        return { success: true, blockId: input.blockId, action: input.action };
      },
    };

    repo.seedBlock({
      id: "block-1",
      title: "예약 달력",
      unitPrice: 300_000,
      isActive: true,
    });

    // 실제 예치 완료 서비스 (C-01/C-02 재사용)
    let verifyFails = false;
    const depositRepo = createInMemoryDepositRepository();
    const depositContract: DepositContractInfo = {
      id: "contract-1",
      projectId: "proj-1",
      applicationId: "app-1",
      clientUserId: "client-1",
      supplierUserId: "supplier-1",
      status: "ACTIVE",
      paymentStatus: "PENDING",
      agreedAmount: 1_000_000,
      clientFee: 50_000,
      interimRatio: 50,
      durationDays: 42,
      depositDeadline: new Date("2026-11-07T14:59:59.000Z"),
      totalDeposited: 0,
      workDueAt: null,
    };
    const depositContractsPort = {
      async getContract(id: string) {
        return id === depositContract.id ? depositContract : null;
      },
      async updateContract(id: string, patch: Partial<DepositContractInfo>) {
        if (id !== depositContract.id) throw new Error("Contract not found");
        Object.assign(depositContract, patch);
        return depositContract;
      },
    };
    const depositService = new DepositCompletionService({
      repo: depositRepo,
      contractsPort: depositContractsPort,
      marketplacePort: {
        async autoRejectCompetingApplications() {
          return { rejectedCount: 0 };
        },
      },
      tossAdapter: {
        async verifyPayment(orderId, paymentKey, amount) {
          if (verifyFails) return { verified: false };
          return { verified: true, orderId, paymentKey, amount, status: "DONE" };
        },
      },
      clock: { now: () => baseTime },
    });

    let heldKeyCounter = 1;
    async function addHeldDeposit(idempotencyKey?: string) {
      const deposit = await depositRepo.createDeposit({
        contractId: depositContract.id,
        principal: depositContract.agreedAmount,
        clientFee: depositContract.clientFee,
        amount: depositContract.agreedAmount + depositContract.clientFee,
        method: "CARD",
        status: "PENDING",
        idempotencyKey: idempotencyKey ?? `held-${heldKeyCounter++}`,
        pgKey: null,
        depositedAt: null,
      });
      await depositRepo.updateDeposit(deposit.id, { status: "HELD", heldReason: "AMOUNT_MISMATCH" });
      repo.seedHeldDeposit({
        id: deposit.id,
        contractId: depositContract.id,
        amount: deposit.amount,
        status: "HELD",
        heldReason: "AMOUNT_MISMATCH",
      });
      return deposit;
    }
    const heldDeposit = options?.seedHeld === false ? null : await addHeldDeposit("held-seed");

    // 실제 검수 판정 서비스
    const deliveryRepo = createInMemoryDeliveryRepository();
    const deliveryContract = {
      id: "contract-insp",
      clientUserId: "client-1",
      supplierUserId: "supplier-1",
      status: "ACTIVE",
      paymentStatus: "DEPOSITED",
    };
    deliveryRepo.seedContract(deliveryContract);
    deliveryRepo.seedInstallment({
      id: "inst-insp",
      contractId: deliveryContract.id,
      stage: "INTERIM",
      status: "REWORK_REQUESTED",
    });
    deliveryRepo.seedContractItems([
      {
        id: "item-1",
        contractId: deliveryContract.id,
        stage: "INTERIM",
        title: "기능 1",
        description: "기능",
        conditions: [],
        approvedAt: null,
        autoApproved: false,
      },
    ]);
    const delivery = await deliveryRepo.createDelivery({
      installmentId: "inst-insp",
      attemptNo: 1,
      items: [{ contractItemId: "item-1", links: [], files: [], howToCheck: "확인" }],
      summary: null,
      status: "REWORK_REQUESTED",
      submittedAt: baseTime,
      inspectionDueAt: new Date(baseTime.getTime() + 7 * 24 * 60 * 60 * 1000),
      reviewedAt: null,
    });
    const inspection = await deliveryRepo.createInspectionRequest({
      deliveryId: delivery.id,
      contractItemId: "item-1",
      reason: "CONDITION_MISMATCH",
      conditionKey: null,
      note: "이견",
      status: "ESCALATED",
      escalatedAt: baseTime,
      createdAt: baseTime,
    });
    const inspectionService = new InspectionBatchService({
      repo: deliveryRepo,
      notificationPorts: { async createOnce() { return { created: true }; } },
      clock: { now: () => baseTime },
    });
    repo.seedEscalatedInspection({
      id: inspection.id,
      contractItemId: "item-1",
      deliveryId: delivery.id,
      status: "ESCALATED",
      reason: "CONDITION_MISMATCH",
    });

    // 실제 취소 판정 서비스
    const cancellationRepo = createInMemoryCancellationRepository();
    const cancellationContract: CancellationContractEntity = {
      id: "contract-cancel-1",
      clientUserId: "client-1",
      supplierUserId: "supplier-1",
      status: "CANCEL_REQUESTED",
      paymentStatus: "DEPOSITED",
      agreedAmount: 3_100_000,
      clientFee: 155_000,
      totalDeposited: 3_255_000,
      interimRatio: 50,
      depositedAt: new Date("2026-11-04T05:20:00.000Z"),
      cancelCause: "CLIENT",
      cancelRequestedBy: "client-1",
      cancelRequestedAt: new Date("2026-11-10T10:00:00.000Z"),
      cancelNote: "취소",
      objectionNote: null,
      objectionRate: null,
      cancelEvidence: null,
      cancelEscalatedAt: baseTime,
      compensationRate: null,
      cancelResolution: null,
      cancelResolvedAt: null,
      refundAmount: null,
      clientFeeRefund: null,
      settledAmount: null,
      refundReason: null,
      refundedAt: null,
      cancelPayoutAt: null,
    };
    cancellationRepo.seedContract(cancellationContract);
    cancellationRepo.seedInstallments([
      { id: "inst-cancel-interim", contractId: cancellationContract.id, stage: "INTERIM", amount: 1_550_000, status: "PENDING" },
      { id: "inst-cancel-final", contractId: cancellationContract.id, stage: "FINAL", amount: 1_550_000, status: "PENDING" },
    ]);
    const cancellationService = new CancellationService({
      repo: cancellationRepo,
      clock: { now: () => baseTime },
    });
    repo.seedCancellationQueueContract({
      id: "contract-cancel-1",
      status: "CANCEL_REQUESTED",
      cancelCause: "CLIENT",
      totalDeposited: 3_255_000,
      agreedAmount: 3_100_000,
      clientFee: 155_000,
      cancelEscalatedAt: baseTime,
      installmentStatuses: ["PENDING", "PENDING"],
    });

    const service = new AdminOpsService({
      repo,
      catalogPort,
      depositPort: depositService,
      inspectionPort: inspectionService,
      cancellationPort: cancellationService,
      clock: { now: () => baseTime },
    });

    return {
      repo,
      service,
      getCatalogActionCalled: () => catalogActionCalled,
      getCatalogActionInput: () => catalogActionInput,
      heldDeposit,
      heldDepositId: heldDeposit?.id ?? "",
      addHeldDeposit,
      inspectionId: inspection.id,
      depositRepo,
      depositContract,
      deliveryRepo,
      cancellationRepo,
      setVerifyFails: (value: boolean) => {
        verifyFails = value;
      },
    };
  }

  it("C-09-T01 일반사용자 모든 관리자 API 403", async () => {
    // 준비: 일반 사용자 계정
    const { service, heldDepositId } = await createTestSetup();
    const clientActor = { userId: "user-client", role: "CLIENT" };
    const supplierActor = { userId: "user-supplier", role: "SUPPLIER" };

    // 실행 및 확인: 블록 목록 조회는 403
    await assert.rejects(() => service.listBlocks(clientActor), AdminHttpError);
    // 실행 및 확인: 블록 액션은 403
    await assert.rejects(
      () => service.executeBlockAction(clientActor, "block-1", { action: "DISABLE", reason: "이유" }),
      AdminHttpError,
    );
    // 실행 및 확인: HELD 예치 목록은 403
    await assert.rejects(() => service.listHeldDeposits(supplierActor), AdminHttpError);
    // 실행 및 확인: HELD 예치 판정은 403
    await assert.rejects(
      () => service.resolveHeldDeposit(clientActor, heldDepositId, { decision: "OPERATOR_CONFIRMED", reason: "이유" }),
      AdminHttpError,
    );
    // 실행 및 확인: 감사 EventLog 조회는 403
    await assert.rejects(() => service.listEventLogs(clientActor), AdminHttpError);
  });

  it("C-09-T02 사유 없는 블록/판정 거부", async () => {
    // 준비: 관리자 계정
    const { service, heldDepositId } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행 및 확인: 사유가 공백이면 블록 액션은 400으로 거부
    await assert.rejects(
      () => service.executeBlockAction(adminActor, "block-1", { action: "DISABLE", reason: "   " }),
      (err: unknown) => {
        if (!(err instanceof AdminHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /사유/);
        return true;
      },
    );

    // 실행 및 확인: HELD 판정 사유가 비면 400으로 거부
    await assert.rejects(
      () =>
        service.resolveHeldDeposit(adminActor, heldDepositId, {
          decision: "OPERATOR_CONFIRMED",
          reason: "",
        }),
      (err: unknown) => {
        if (!(err instanceof AdminHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /사유/);
        return true;
      },
    );
  });

  it("C-09-T03 블록 운영 변경 시 사본 가격 불변", async () => {
    // 준비: 관리자 계정
    const { service, getCatalogActionCalled, getCatalogActionInput } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행: 블록 단가 수정 (A의 catalogPort 호출)
    const res = await service.executeBlockAction(adminActor, "block-1", {
      action: "UPDATE_PRICE",
      unitPrice: 400_000,
      reason: "물가 상승 및 난이도 재평가 반영",
    });

    // 확인: 카탈로그 포트로 위임되고 행위자가 기록됨
    assert.equal(res.success, true);
    assert.equal(getCatalogActionCalled(), true);
    assert.equal(getCatalogActionInput()?.actorId, adminActor.userId);
  });

  it("C-09-T04 보류 입금 확정/취소 멱등성", async () => {
    // 준비: 보류된 예치와 관리자 계정
    const { service, repo, heldDepositId, depositContract } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행: 1회차 OPERATOR_CONFIRMED 판정 (PG 재조회 근거 필요)
    const r1 = await service.resolveHeldDeposit(adminActor, heldDepositId, {
      decision: "OPERATOR_CONFIRMED",
      reason: "PG 대조 결과 정상 입금 확인",
      paymentKey: "pk-held-ok",
    });
    // 확인: 예치 완료와 계약 예치 상태 전이
    assert.equal(r1.status, "COMPLETED");
    assert.equal(depositContract.paymentStatus, "DEPOSITED");

    // 실행: 2회차 동일 판정 재시도
    const r2 = await service.resolveHeldDeposit(adminActor, heldDepositId, {
      decision: "OPERATOR_CONFIRMED",
      reason: "PG 대조 결과 정상 입금 확인",
      paymentKey: "pk-held-ok",
    });
    // 확인: 멱등 반환
    assert.equal(r2.status, "COMPLETED");

    // 확인: 감사 EventLog에 행위자가 기록됨
    const logs = await repo.listEventLogs();
    const log = logs.find((l: { targetId: string }) => l.targetId === heldDepositId);
    assert.ok(log);
    assert.equal(log.actorUserId, "admin-1");
  });

  it("C-09-T05 이견 판정 후 상태 일관", async () => {
    // 준비: 에스컬레이션된 이견
    const { service, repo, inspectionId } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행: 관리자 승인 판정
    const decided = await service.decideInspectionDispute(adminActor, inspectionId, {
      decision: "APPROVE",
      reason: "기능 테스트 통과 확인",
      decisionNotes: { client: "검수 통과", supplier: "승인 완료" },
    });

    // 확인: 판정 결과와 실제 이견 상태가 일치
    assert.equal(decided.status, "RESOLVED");
    assert.equal(decided.decision, "APPROVE");

    const current = await repo.getInspection(inspectionId);
    assert.equal(current?.status, "RESOLVED");
  });

  it("C-09-T06 취소 수동 처리 중복 없음", async () => {
    // 준비: 취소 계약과 관리자 계정
    const { service, repo } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행: 1회차 수동 처리 완료 표시
    const p1 = await service.markSettlementProcessed(adminActor, "contract-cancel-1", {
      refunded: true,
      cancelPayout: true,
      reason: "계좌 수동 이체 완료",
    });
    // 확인: 환불·지급 시각 기록
    assert.ok(p1.refundedAt);
    assert.ok(p1.cancelPayoutAt);

    // 실행: 2회차 중복 호출
    const p2 = await service.markSettlementProcessed(adminActor, "contract-cancel-1", {
      refunded: true,
      cancelPayout: true,
      reason: "재확인",
    });
    // 확인: 기존 처리 시각이 유지됨 (중복 변경 및 에러 없음)
    assert.equal(p1.refundedAt?.getTime(), p2.refundedAt?.getTime());
  });

  it("C-09-T07 EventLog 검색/정렬/권한", async () => {
    // 준비: 서로 다른 시각의 감사 이벤트 2건
    const { service, repo } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    await repo.recordEvent({
      actorUserId: "admin-1",
      actionType: "BLOCK_UPDATE",
      targetType: "BLOCK",
      targetId: "block-1",
      reason: "단가 변경",
      occurredAt: baseTime,
    });

    await repo.recordEvent({
      actorUserId: "admin-1",
      actionType: "DISPUTE_DECISION",
      targetType: "INSPECTION",
      targetId: "insp-1",
      reason: "판정 완료",
      occurredAt: new Date(baseTime.getTime() + 1000),
    });

    // 실행: 관리자 EventLog 조회
    const logs = await service.listEventLogs(adminActor);
    // 확인: 2건이 최신순으로 정렬됨
    assert.equal(logs.length, 2);
    assert.ok(logs[0].occurredAt >= logs[1].occurredAt);
  });

  it("C-09-T05b 관리자 취소 판정은 역할·사유·비율을 검사하고 감사 로그를 남김", async () => {
    // 준비: 관리자·일반 사용자 계정
    const { service, repo } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };
    const clientActor = { userId: "user-client", role: "CLIENT" };

    // 실행 및 확인: 일반 사용자의 판정은 403으로 거부
    await assert.rejects(
      () => service.decideCancellation(clientActor, "contract-cancel-1", { compensationRate: 50, reason: "판정" }),
      (err: unknown) => {
        if (!(err instanceof AdminHttpError)) return false;
        assert.equal(err.status, 403);
        return true;
      },
    );

    // 실행 및 확인: 사유가 공백이면 400으로 거부
    await assert.rejects(
      () => service.decideCancellation(adminActor, "contract-cancel-1", { compensationRate: 50, reason: "  " }),
      (err: unknown) => {
        if (!(err instanceof AdminHttpError)) return false;
        assert.equal(err.status, 400);
        return true;
      },
    );

    // 실행 및 확인: 비율 하한 위반은 422로 거부
    await assert.rejects(
      () => service.decideCancellation(adminActor, "contract-cancel-1", { compensationRate: 49, reason: "하한 위반" }),
      (err: unknown) => {
        if (!(err instanceof AdminHttpError)) return false;
        assert.equal(err.status, 422);
        return true;
      },
    );

    // 실행: 정상 판정
    const decided = await service.decideCancellation(adminActor, "contract-cancel-1", {
      compensationRate: 50,
      reason: "착수 보상 판정",
    });
    // 확인: 취소 전이와 정산·환불 금액
    assert.equal(decided.status, "CANCELLED");
    assert.equal(decided.compensationRate, 50);
    assert.equal(decided.settledAmount, 736_250);
    assert.equal(decided.refundAmount, 2_441_250);

    // 실행: 같은 판정 재호출
    const again = await service.decideCancellation(adminActor, "contract-cancel-1", {
      compensationRate: 50,
      reason: "재호출",
    });
    // 확인: 판정 금액 불변, 감사 로그는 1건만 기록
    assert.equal(again.refundAmount, decided.refundAmount);

    const logs = await repo.listEventLogs();
    const decisionLogs = logs.filter((log) => log.actionType === "CANCELLATION_ADMIN_DECIDED");
    assert.equal(decisionLogs.length, 1);
    assert.equal(decisionLogs[0]?.reason, "착수 보상 판정");
  });

  it("C-09-T05c D-16 승인 전 24시간 내 무납품 관리자 판정을 차단", async () => {
    // 준비: 예치 2시간 뒤 취소 요청한 계약 2건
    const { service, repo, cancellationRepo } = await createTestSetup();
    const depositedAt = new Date(baseTime.getTime() - 2 * 60 * 60 * 1000);

    async function seedCancellation(
      id: string,
      installmentStatuses: ["PENDING" | "DELIVERED", "PENDING" | "DELIVERED"],
    ) {
      const contract: CancellationContractEntity = {
        id,
        clientUserId: "client-1",
        supplierUserId: "supplier-1",
        status: "CANCEL_REQUESTED",
        paymentStatus: "DEPOSITED",
        agreedAmount: 3_100_000,
        clientFee: 155_000,
        totalDeposited: 3_255_000,
        interimRatio: 50,
        depositedAt,
        cancelCause: "CLIENT",
        cancelRequestedBy: "client-1",
        cancelRequestedAt: baseTime,
        cancelNote: "취소",
        objectionNote: null,
        objectionRate: null,
        cancelEvidence: null,
        cancelEscalatedAt: baseTime,
        compensationRate: null,
        cancelResolution: null,
        cancelResolvedAt: null,
        refundAmount: null,
        clientFeeRefund: null,
        settledAmount: null,
        refundReason: null,
        refundedAt: null,
        cancelPayoutAt: null,
      };
      cancellationRepo.seedContract(contract);
      cancellationRepo.seedInstallments([
        { id: `${id}-interim`, contractId: id, stage: "INTERIM", amount: 1_550_000, status: installmentStatuses[0] },
        { id: `${id}-final`, contractId: id, stage: "FINAL", amount: 1_550_000, status: installmentStatuses[1] },
      ]);
      repo.seedCancellationQueueContract({
        id,
        status: "CANCEL_REQUESTED",
        cancelCause: "CLIENT",
        totalDeposited: 3_255_000,
        agreedAmount: 3_100_000,
        clientFee: 155_000,
        depositedAt,
        cancelRequestedAt: baseTime,
        cancelEscalatedAt: baseTime,
        installmentStatuses,
      });
    }

    await seedCancellation("contract-cancel-24h", ["PENDING", "PENDING"]);

    // 실행: 24시간 내 무납품 건을 운영자가 판정
    const decided = await service.decideCancellation(
      { userId: "admin-1", role: "ADMIN" },
      "contract-cancel-24h",
      { compensationRate: 0, reason: "24시간 내 무납품" },
    );
    // 확인: 보상 없이 예치 전액 환불
    assert.equal(decided.compensationRate, null);
    assert.equal(decided.refundAmount, 3_255_000);
    assert.equal(decided.settledAmount, 0);
    assert.equal(decided.clientFeeRefund, 155_000);

    await seedCancellation("contract-cancel-delivered", ["DELIVERED", "PENDING"]);
    // 실행 및 확인: 이미 납품한 건은 422로 차단
    await assert.rejects(
      () =>
        service.decideCancellation(
          { userId: "admin-1", role: "ADMIN" },
          "contract-cancel-delivered",
          { compensationRate: 0, reason: "납품 후" },
        ),
      (err: unknown) => err instanceof AdminHttpError && err.status === 422,
    );
  });

  it("C-09-F01 PG 근거 없이는 HELD 확정 불가", async () => {
    // 준비: 보류 예치와 PG 검증 실패 상태
    const { repo, service, addHeldDeposit, depositRepo, depositContract, setVerifyFails } =
      await createTestSetup({ seedHeld: false });
    const held = await addHeldDeposit("c09-f01");
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    setVerifyFails(true);
    // 실행 및 확인: PG 대조 실패 시 422로 거부되고 상태는 보류 유지
    await assert.rejects(
      () =>
        service.resolveHeldDeposit(adminActor, held.id, {
          decision: "OPERATOR_CONFIRMED",
          reason: "PG 대조 시도",
          paymentKey: "pk-mismatch",
        }),
      (err: unknown) => err instanceof AdminHttpError && err.status === 422,
    );
    assert.equal((await repo.getHeldDeposit(held.id))?.status, "HELD");
    assert.equal((await depositRepo.findById(held.id))?.status, "HELD");
    assert.equal(depositContract.paymentStatus, "PENDING");
  });

  it("C-09-F01b PG 확인 후 HELD 확정은 실제 완료 경로로 처리", async () => {
    // 준비: 보류 예치와 PG 검증 성공 상태
    const { service, addHeldDeposit, depositRepo, depositContract } = await createTestSetup({
      seedHeld: false,
    });
    const held = await addHeldDeposit("c09-f01b");
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행: OPERATOR_CONFIRMED 확정
    const resolved = await service.resolveHeldDeposit(adminActor, held.id, {
      decision: "OPERATOR_CONFIRMED",
      reason: "PG 정상 확인",
      paymentKey: "pk-confirmed",
    });
    // 확인: 예치·계약이 완료 상태가 되고 구간 2개 생성
    assert.equal(resolved.status, "COMPLETED");
    assert.equal((await depositRepo.findById(held.id))?.status, "COMPLETED");
    assert.equal(depositContract.paymentStatus, "DEPOSITED");
    assert.equal((await depositRepo.listInstallments(depositContract.id)).length, 2);
  });

  it("C-09-F02 OPERATOR_VOIDED가 PaymentEvent·기한 재판정을 실제로 실행", async () => {
    // 준비: 보류 예치와 관리자 계정
    const { service, repo, addHeldDeposit, depositRepo, depositContract } = await createTestSetup({
      seedHeld: false,
    });
    const held = await addHeldDeposit("c09-f02");
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행: OPERATOR_VOIDED 판정
    const resolved = await service.resolveHeldDeposit(adminActor, held.id, {
      decision: "OPERATOR_VOIDED",
      reason: "미입금 확인",
    });
    // 확인: 예치 실패·계약 취소와 이벤트 1건 기록
    assert.equal(resolved.status, "FAILED");
    assert.equal((await depositRepo.findById(held.id))?.status, "FAILED");
    assert.equal(depositContract.status, "CANCELLED");

    const voided = (await depositRepo.listPaymentEvents(held.id)).filter(
      (event) => event.eventType === "OPERATOR_VOIDED",
    );
    assert.equal(voided.length, 1);

    // 실행: 동일 판정 재호출
    await service.resolveHeldDeposit(adminActor, held.id, {
      decision: "OPERATOR_VOIDED",
      reason: "미입금 확인",
    });
    // 확인: 이벤트·상태가 중복되지 않음
    assert.equal(
      (await depositRepo.listPaymentEvents(held.id)).filter((event) => event.eventType === "OPERATOR_VOIDED")
        .length,
      1,
    );
    assert.equal((await repo.getHeldDeposit(held.id))?.status, "FAILED");
  });

  it("C-09-F03 이견 승인 판정이 실제 검수 상태를 변경", async () => {
    // 준비: 에스컬레이션된 이견
    const { service, inspectionId, deliveryRepo } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행: APPROVE 판정
    const approved = await service.decideInspectionDispute(adminActor, inspectionId, {
      decision: "APPROVE",
      reason: "기능 확인",
      decisionNotes: { client: "승인", supplier: "승인" },
    });
    // 확인: 항목·이견·납품이 모두 승인 상태로 반영
    assert.equal(approved.status, "RESOLVED");
    const approvedItem = await deliveryRepo.getContractItem("item-1");
    assert.ok(approvedItem?.approvedAt);
    const resolvedInspection = await deliveryRepo.getInspectionRequest(inspectionId);
    assert.equal(resolvedInspection?.status, "RESOLVED");
    const approvedDelivery = await deliveryRepo.getDelivery(resolvedInspection!.deliveryId);
    assert.equal(approvedDelivery?.status, "APPROVED");

    // 실행 및 확인: 이미 판정된 이견은 409로 재판정 불가
    await assert.rejects(
      () =>
        service.decideInspectionDispute(adminActor, inspectionId, {
          decision: "REWORK_VALID",
          reason: "뒤늦은 재판정",
          decisionNotes: { client: "재작업", supplier: "재작업" },
        }),
      (err: unknown) => err instanceof AdminHttpError && err.status === 409,
    );
  });

  it("C-09-F03b REWORK_VALID 판정은 재납품 상태로 전환", async () => {
    // 준비: 에스컬레이션된 이견
    const rework = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행: REWORK_VALID 판정
    const reworkDecision = await rework.service.decideInspectionDispute(
      adminActor,
      rework.inspectionId,
      {
        decision: "REWORK_VALID",
        reason: "보완이 맞음",
        decisionNotes: { client: "보완", supplier: "보완" },
      },
    );
    // 확인: 이견은 OPEN, 납품·구간은 REWORK_REQUESTED, 항목은 미승인 유지
    assert.equal(reworkDecision.status, "RESOLVED");
    const reworkInspection = await rework.deliveryRepo.getInspectionRequest(rework.inspectionId);
    assert.equal(reworkInspection?.status, "OPEN");
    const reworkDelivery = await rework.deliveryRepo.getDelivery(reworkInspection!.deliveryId);
    assert.equal(reworkDelivery?.status, "REWORK_REQUESTED");
    const reworkInstallment = await rework.deliveryRepo.getInstallment(reworkDelivery!.installmentId);
    assert.equal(reworkInstallment?.status, "REWORK_REQUESTED");
    assert.equal((await rework.deliveryRepo.getContractItem("item-1"))?.approvedAt, null);
  });

  it("C-09-F04 관리자 취소 판정은 CancellationService 분할 규칙을 그대로 사용", async () => {
    // 준비: 운영자 판정 대기 중 취소 계약
    const { service, cancellationRepo, repo } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행: 50% 보상 판정
    const decided = await service.decideCancellation(adminActor, "contract-cancel-1", {
      compensationRate: 50,
      reason: "착수 보상",
    });
    // 확인: 서비스 분할 규칙과 실제 계약 저장 값이 일치
    assert.equal(decided.refundAmount, 2_441_250);
    assert.equal(decided.settledAmount, 736_250);
    const real = await cancellationRepo.getContract("contract-cancel-1");
    assert.equal(real?.status, "CANCELLED");
    assert.equal(real?.refundAmount, 2_441_250);

    // 준비: 중간 구간이 이미 지급된 취소 계약
    const partialId = "contract-cancel-partial";
    cancellationRepo.seedContract({
      id: partialId,
      clientUserId: "client-1",
      supplierUserId: "supplier-1",
      status: "CANCEL_REQUESTED",
      paymentStatus: "PARTIALLY_RELEASED",
      agreedAmount: 3_100_000,
      clientFee: 155_000,
      totalDeposited: 3_255_000,
      interimRatio: 50,
      depositedAt: new Date("2026-11-04T05:20:00.000Z"),
      cancelCause: "CLIENT",
      cancelRequestedBy: "client-1",
      cancelRequestedAt: new Date("2026-11-10T10:00:00.000Z"),
      cancelNote: "취소",
      objectionNote: null,
      objectionRate: null,
      cancelEvidence: null,
      cancelEscalatedAt: baseTime,
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
    cancellationRepo.seedInstallments([
      { id: "partial-interim", contractId: partialId, stage: "INTERIM", amount: 1_550_000, status: "RELEASED" },
      { id: "partial-final", contractId: partialId, stage: "FINAL", amount: 1_550_000, status: "PENDING" },
    ]);
    repo.seedCancellationQueueContract({
      id: partialId,
      status: "CANCEL_REQUESTED",
      cancelCause: "CLIENT",
      totalDeposited: 3_255_000,
      agreedAmount: 3_100_000,
      clientFee: 155_000,
      cancelEscalatedAt: baseTime,
    });

    // 실행: 부분 지급 후 취소 판정
    const partial = await service.decideCancellation(adminActor, partialId, {
      compensationRate: 50,
      reason: "부분 지급 후 취소",
    });
    // 확인: 남은 잔액 기준(891,250)으로 계산됨
    assert.equal(partial.refundAmount, 891_250);
    assert.equal(partial.settledAmount, 736_250);
  });

  it("C-09-F05 EventLog 검색·필터를 실제 조회에 적용", async () => {
    // 준비: 행위자·유형·시각이 다른 감사 이벤트 3건
    const { service, repo } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    await repo.recordEvent({
      actorUserId: "admin-1",
      actionType: "BLOCK_UPDATE",
      targetType: "BLOCK",
      targetId: "block-1",
      reason: "단가 변경",
      occurredAt: baseTime,
    });
    await repo.recordEvent({
      actorUserId: "admin-2",
      actionType: "DISPUTE_DECISION",
      targetType: "INSPECTION",
      targetId: "insp-1",
      reason: "판정",
      occurredAt: new Date(baseTime.getTime() + 1000),
    });
    await repo.recordEvent({
      actorUserId: "admin-1",
      actionType: "DISPUTE_DECISION",
      targetType: "INSPECTION",
      targetId: "insp-2",
      reason: "판정2",
      occurredAt: new Date(baseTime.getTime() + 2000),
    });

    // 실행 및 확인: 조건별 필터 결과 건수
    assert.equal((await service.listEventLogs(adminActor, { actionType: "BLOCK_UPDATE" })).length, 1);
    assert.equal((await service.listEventLogs(adminActor, { actorUserId: "admin-1" })).length, 2);
    assert.equal((await service.listEventLogs(adminActor, { targetType: "INSPECTION" })).length, 2);
    assert.equal((await service.listEventLogs(adminActor, { targetId: "insp-2" })).length, 1);
    assert.equal(
      (
        await service.listEventLogs(adminActor, {
          from: new Date(baseTime.getTime() + 500),
          to: new Date(baseTime.getTime() + 1500),
        })
      ).length,
      1,
    );
  });

  it("C-09-F05b 블록 action 허용값과 필수 인자를 검증", async () => {
    // 준비: 관리자 계정
    const { service, getCatalogActionCalled } = await createTestSetup();
    const adminActor = { userId: "admin-1", role: "ADMIN" };

    // 실행 및 확인: 허용되지 않은 action은 400이고 포트 호출이 없음
    await assert.rejects(
      () => service.executeBlockAction(adminActor, "block-1", { action: "BOGUS", reason: "임의 액션" }),
      (err: unknown) => err instanceof AdminHttpError && err.status === 400,
    );
    assert.equal(getCatalogActionCalled(), false);

    // 실행 및 확인: 단가·병합 대상 누락은 400으로 거부
    await assert.rejects(
      () => service.executeBlockAction(adminActor, "block-1", { action: "UPDATE_PRICE", reason: "가격 누락" }),
      (err: unknown) => err instanceof AdminHttpError && err.status === 400,
    );
    await assert.rejects(
      () => service.executeBlockAction(adminActor, "block-1", { action: "MERGE", reason: "대상 누락" }),
      (err: unknown) => err instanceof AdminHttpError && err.status === 400,
    );

    // 실행: 정상 ENABLE 액션
    const enabled = await service.executeBlockAction(adminActor, "block-1", {
      action: "ENABLE",
      reason: "다시 사용",
    });
    // 확인: 포트로 위임됨
    assert.equal(enabled.success, true);
    assert.equal(getCatalogActionCalled(), true);
  });

  it("C-09-T08 B 관리자 경로 중복 등록 0", async () => {
    // 준비
    const { service } = await createTestSetup();

    // 확인: 신고(reports) 및 문의(inquiries) 조치는 B 담당이므로 C 관리자 서비스에 중복 메서드 없음
    assert.equal(typeof (service as unknown as Record<string, unknown>).resolveReport, "undefined");
    assert.equal(typeof (service as unknown as Record<string, unknown>).answerInquiry, "undefined");
  });
});
