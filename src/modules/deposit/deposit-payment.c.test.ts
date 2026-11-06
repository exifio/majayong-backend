import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  DepositCompletionService,
  DepositHttpError,
  DepositService,
  createInMemoryDepositRepository,
  type DepositContractInfo,
  type DepositCompletionPort,
  type TossVerifyAdapter,
  type TossWebhookPayload,
} from "./index.ts";

describe("C-01: Toss sandbox 예치·PG 검증·중복 방지", () => {
  const WEBHOOK_SECRET = "0123456789abcdef".repeat(4);
  const now = new Date("2026-11-04T05:20:00.000Z");
  const unusedCompletionPort: DepositCompletionPort = {
    async completeDeposit() {
      throw new Error("Unexpected deposit completion");
    },
  };

  function callWebhook(
    service: DepositService,
    auth: { securityKey?: string },
    payload: unknown,
  ) {
    const rawPayload = Buffer.from(JSON.stringify(payload) ?? "null", "utf8");
    const transmissionTime = now.toISOString();
    const signature = createHmac("sha256", Buffer.from(auth.securityKey ?? WEBHOOK_SECRET, "hex"))
      .update(rawPayload)
      .update(":")
      .update(transmissionTime)
      .digest("base64");
    return service.handleTossWebhook(
      { rawPayload, transmissionTime, signature: `v1:${signature}` },
      payload,
    );
  }

  // 준비: 테스트마다 독립된 인메모리 저장소와 계약을 만든다.
  function createTestContext() {
    const repo = createInMemoryDepositRepository();
    const contract: DepositContractInfo = {
      id: "contract-1",
      clientUserId: "client-1",
      supplierUserId: "supplier-1",
      status: "ACTIVE" as const,
      paymentStatus: "PENDING" as const,
      agreedAmount: 1_000_000,
      clientFee: 50_000,
      interimRatio: 50,
      durationDays: 42,
      depositDeadline: new Date("2026-11-07T14:59:59.000Z"),
      totalDeposited: 0,
      workDueAt: null,
    };

    const contractsPort = {
      async getContract(id: string) {
        if (id === contract.id) return contract;
        return null;
      },
      async updateContract(id: string, patch: Partial<DepositContractInfo>) {
        if (id !== contract.id) throw new Error("Contract not found");
        Object.assign(contract, patch);
        return contract;
      },
    };

    const completionPort = new DepositCompletionService({
      repo,
      contractsPort,
      marketplacePort: {
        async autoRejectCompetingApplications() {
          return { rejectedCount: 0 };
        },
      },
      clock: { now: () => now },
    });

    const service = new DepositService({
      repo,
      contractsPort,
      webhookSecret: WEBHOOK_SECRET,
      tossAdapter: {
        async verifyPayment(orderId, paymentKey, amount) {
          return { verified: true, orderId, paymentKey, amount, status: "DONE" };
        },
      },
      completionPort,
      clock: { now: () => now },
    });

    return { repo, contract, service };
  }

  it("C-01-T01a 존재하지 않는 계약으로 예치하면 404", async () => {
    // 준비
    const { service } = createTestContext();

    // 실행 및 확인
    await assert.rejects(
      () =>
        service.createDeposit(
          { userId: "client-1", role: "CLIENT" },
          {
            contractId: "missing-contract",
            idempotencyKey: "idem-1",
            method: "CARD",
            amount: 1_050_000,
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DepositHttpError)) return false;
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it("C-01-T01b 계약 당사자가 아닌 의뢰인은 403", async () => {
    // 준비
    const { service } = createTestContext();

    // 실행 및 확인
    await assert.rejects(
      () =>
        service.createDeposit(
          { userId: "other-user", role: "CLIENT" },
          {
            contractId: "contract-1",
            idempotencyKey: "idem-2",
            method: "CARD",
            amount: 1_050_000,
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DepositHttpError)) return false;
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  it("C-01-T01c 공급자가 예치를 시도하면 403", async () => {
    // 준비
    const { service } = createTestContext();

    // 실행 및 확인
    await assert.rejects(
      () =>
        service.createDeposit(
          { userId: "supplier-1", role: "SUPPLIER" },
          {
            contractId: "contract-1",
            idempotencyKey: "idem-3",
            method: "CARD",
            amount: 1_050_000,
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DepositHttpError)) return false;
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  it("C-01-T02a 요청 금액이 계약 예치액과 다르면 400", async () => {
    // 준비
    const { service, contract } = createTestContext();

    // 실행 및 확인
    await assert.rejects(
      () =>
        service.createDeposit(
          { userId: contract.clientUserId, role: "CLIENT" },
          {
            contractId: contract.id,
            idempotencyKey: "idem-mismatch",
            method: "CARD",
            amount: 1_000_000,
          },
        ),
      (err: unknown) => {
        if (!(err instanceof DepositHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /금액/);
        return true;
      },
    );
  });

  it("C-01-T02b 웹훅 orderId가 없으면 404", async () => {
    // 준비
    const { service, contract } = createTestContext();
    const { deposit } = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      {
        contractId: contract.id,
        idempotencyKey: "idem-valid",
        method: "CARD",
        amount: 1_050_000,
      },
    );

    // 실행 및 확인
    await assert.rejects(
      () =>
        callWebhook(service, { securityKey: WEBHOOK_SECRET }, {
          orderId: "invalid-order-id",
          paymentKey: "toss_pk_123",
          amount: 1_050_000,
          status: "DONE",
          eventType: "PAYMENT_STATUS_CHANGED",
        }),
      (err: unknown) => {
        if (!(err instanceof DepositHttpError)) return false;
        assert.equal(err.status, 404);
        return true;
      },
    );
    assert.equal(deposit.status, "PENDING");
  });

  it("C-01-T02c 웹훅 금액이 다르면 HELD로 격리", async () => {
    // 준비
    const { service, contract } = createTestContext();
    const { deposit } = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      {
        contractId: contract.id,
        idempotencyKey: "idem-valid",
        method: "CARD",
        amount: 1_050_000,
      },
    );

    // 실행
    const heldResult = await callWebhook(service, { securityKey: WEBHOOK_SECRET }, {
      orderId: deposit.id,
      paymentKey: "toss_pk_mismatch",
      amount: 500_000,
      status: "DONE",
      eventType: "PAYMENT_STATUS_CHANGED",
    });

    // 확인
    assert.equal(heldResult.status, "HELD");
    assert.equal(heldResult.deposit.status, "HELD");
    assert.equal(heldResult.deposit.heldReason, "AMOUNT_MISMATCH");
  });

  it("C-01-T03 동일 멱등키 3회→예치 1건", async () => {
    // 준비
    const { service, contract } = createTestContext();
    const idempotencyKey = "client-idem-key-999";

    // 실행: 같은 멱등키로 3번 요청한다.
    const res1 = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, idempotencyKey, method: "CARD", amount: 1_050_000 },
    );
    const res2 = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, idempotencyKey, method: "CARD", amount: 1_050_000 },
    );
    const res3 = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, idempotencyKey, method: "CARD", amount: 1_050_000 },
    );

    // 확인
    assert.equal(res1.isNew, true);
    assert.equal(res2.isNew, false);
    assert.equal(res3.isNew, false);
    assert.equal(res1.deposit.id, res2.deposit.id);
    assert.equal(res2.deposit.id, res3.deposit.id);
    assert.equal(res1.deposit.status, "PENDING");
  });

  it("C-01-T04 콜백 재송신 10회→결과 동일", async () => {
    // 준비
    const { service, contract, repo } = createTestContext();
    const { deposit } = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, idempotencyKey: "idem-retransmit", method: "CARD", amount: 1_050_000 },
    );
    const webhookPayload: TossWebhookPayload = {
      orderId: deposit.id,
      paymentKey: "toss_pk_retransmit_test",
      amount: 1_050_000,
      status: "DONE",
      eventType: "PAYMENT_STATUS_CHANGED",
    };

    // 실행: 같은 콜백을 10번 보낸다.
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await callWebhook(service, { securityKey: WEBHOOK_SECRET }, webhookPayload));
    }

    // 확인: 10번 모두 같은 완료 결과이고, VERIFIED 이벤트는 1건이다.
    for (const res of results) {
      assert.equal(res.status, "COMPLETED");
      assert.equal(res.deposit.id, deposit.id);
      assert.equal(res.deposit.status, "COMPLETED");
    }
    const events = await repo.listPaymentEvents(deposit.id);
    const verifiedEvents = events.filter((e: { eventType: string }) => e.eventType === "VERIFIED");
    assert.equal(verifiedEvents.length, 1);
  });

  it("C-01-T05 PENDING/HELD 안전 정지", async () => {
    // 준비
    const { service, contract, repo } = createTestContext();
    const { deposit } = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, idempotencyKey: "idem-held-safe", method: "CARD", amount: 1_050_000 },
    );
    assert.equal(deposit.status, "PENDING");

    // 실행: 불확실한 상태 콜백을 보낸다.
    const heldRes = await callWebhook(service, { securityKey: WEBHOOK_SECRET }, {
      orderId: deposit.id,
      paymentKey: "toss_pk_unknown_status",
      amount: 1_050_000,
      status: "WAITING_FOR_DEPOSIT",
      eventType: "PAYMENT_STATUS_CHANGED",
    });

    // 확인: HELD로 멈추고 완료 시각은 남지 않는다.
    assert.equal(heldRes.status, "HELD");
    const currentDeposit = await repo.findById(deposit.id);
    assert.ok(currentDeposit);
    assert.equal(currentDeposit.status, "HELD");
    assert.equal(currentDeposit.depositedAt, null);
  });

  it("C-01-T06 Toss webhook 서명이 불일치하면 인증을 거절", async () => {
    // 준비
    const { service, contract } = createTestContext();
    const { deposit } = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, idempotencyKey: "idem-fake-auth", method: "CARD", amount: 1_050_000 },
    );

    // 실행 및 확인
    await assert.rejects(
      () =>
        callWebhook(service, { securityKey: "fedcba9876543210".repeat(4) }, {
          orderId: deposit.id,
          paymentKey: "toss_pk_fake",
          amount: 1_050_000,
          status: "DONE",
          eventType: "PAYMENT_STATUS_CHANGED",
        }),
      (err: unknown) => {
        if (!(err instanceof DepositHttpError)) return false;
        assert.equal(err.status, 401);
        assert.match(err.message, /서명/);
        return true;
      },
    );
  });

  it("C-01-T07 PG 네트워크 예외는 503으로 재시도 가능하게 하고 PENDING 유지", async () => {
    // 준비
    const repo = createInMemoryDepositRepository();
    const contract = {
      id: "contract-1",
      clientUserId: "client-1",
      supplierUserId: "supplier-1",
      status: "ACTIVE" as const,
      paymentStatus: "PENDING" as const,
      agreedAmount: 1_000_000,
      clientFee: 50_000,
      depositDeadline: new Date("2026-11-07T14:59:59.000Z"),
    };
    const failingTossAdapter = {
      async verifyPayment() {
        throw new Error("PG_NETWORK_TIMEOUT");
      },
    };
    const service = new DepositService({
      repo,
      contractsPort: { async getContract() { return contract; } },
      webhookSecret: WEBHOOK_SECRET,
      tossAdapter: failingTossAdapter,
      completionPort: unusedCompletionPort,
      clock: { now: () => now },
    });
    const { deposit } = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, idempotencyKey: "idem-net-err", method: "CARD", amount: 1_050_000 },
    );

    // 실행 및 확인
    await assert.rejects(
      () => callWebhook(service, { securityKey: WEBHOOK_SECRET }, {
        orderId: deposit.id,
        paymentKey: "toss_pk_net_err",
        amount: 1_050_000,
        status: "DONE",
        eventType: "PAYMENT_STATUS_CHANGED",
      }),
      (err: unknown) => err instanceof DepositHttpError && err.status === 503,
    );
    const checkDeposit = await repo.findById(deposit.id);
    assert.ok(checkDeposit);
    assert.equal(checkDeposit.status, "PENDING");
    assert.equal(checkDeposit.depositedAt, null);
    assert.equal((await repo.listPaymentEvents(deposit.id)).length, 0);
  });

  it("C-01-T07c 재조회 어댑터가 없으면 503과 PENDING으로 Toss 재전송을 기다림", async () => {
    // 준비
    const repo = createInMemoryDepositRepository();
    const contract = {
      id: "contract-1",
      clientUserId: "client-1",
      supplierUserId: "supplier-1",
      status: "ACTIVE" as const,
      paymentStatus: "PENDING" as const,
      agreedAmount: 1_000_000,
      clientFee: 50_000,
      depositDeadline: new Date("2026-11-07T14:59:59.000Z"),
    };
    const service = new DepositService({
      repo,
      contractsPort: { async getContract() { return contract; } },
      webhookSecret: WEBHOOK_SECRET,
      completionPort: unusedCompletionPort,
      clock: { now: () => now },
    });
    const { deposit } = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, idempotencyKey: "idem-no-lookup", method: "CARD", amount: 1_050_000 },
    );

    // 실행 및 확인
    await assert.rejects(
      () => callWebhook(service, { securityKey: WEBHOOK_SECRET }, {
        orderId: deposit.id,
        paymentKey: "toss_pk_no_lookup",
        amount: 1_050_000,
        status: "DONE",
      }),
      (err: unknown) => err instanceof DepositHttpError && err.status === 503,
    );
    assert.equal((await repo.findById(deposit.id))?.status, "PENDING");
    assert.equal((await repo.listPaymentEvents(deposit.id)).length, 0);
  });

  it("C-01-T07b 명시적 PG 검증 불일치는 HELD로 격리하고 완료하지 않음", async () => {
    // 준비
    const repo = createInMemoryDepositRepository();
    const contract = {
      id: "contract-1",
      clientUserId: "client-1",
      supplierUserId: "supplier-1",
      status: "ACTIVE" as const,
      paymentStatus: "PENDING" as const,
      agreedAmount: 1_000_000,
      clientFee: 50_000,
      depositDeadline: new Date("2026-11-07T14:59:59.000Z"),
    };
    const service = new DepositService({
      repo,
      contractsPort: { async getContract() { return contract; } },
      webhookSecret: WEBHOOK_SECRET,
      tossAdapter: { async verifyPayment() { return { verified: false }; } },
      completionPort: unusedCompletionPort,
      clock: { now: () => now },
    });
    const { deposit } = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, idempotencyKey: "idem-unverified", method: "CARD", amount: 1_050_000 },
    );

    // 실행
    const result = await callWebhook(service, { securityKey: WEBHOOK_SECRET }, { orderId: deposit.id, paymentKey: "toss_pk_unverified", amount: 1_050_000, status: "DONE" });

    // 확인
    assert.equal(result.status, "HELD");
    assert.equal(result.deposit.depositedAt, null);
  });

  it("C-01-T08 서명 원문 body가 없으면 인증에 실패하고 PENDING 유지", async () => {
    // 준비
    const { repo, service, contract } = createTestContext();
    const { deposit } = await service.createDeposit(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, idempotencyKey: "idem-missing-raw-body", method: "CARD", amount: 1_050_000 },
    );
    const payload = {
      orderId: deposit.id,
      paymentKey: "toss_pk_test",
      amount: 1_050_000,
      status: "DONE",
      eventType: "PAYMENT_STATUS_CHANGED",
    };

    // 실행 및 확인
    await assert.rejects(
      () => service.handleTossWebhook(
        { signature: `v1:${"A".repeat(43)}=`, transmissionTime: now.toISOString() },
        payload,
      ),
      (err: unknown) => err instanceof DepositHttpError && err.status === 401,
    );
    assert.equal((await repo.findById(deposit.id))?.status, "PENDING");
  });

  // 준비: 예치 완료→구간 생성→경쟁 지원 거절까지 연결되는 문맥을 만든다.
  function createLinkedContext(options?: {
    tossAdapter?: TossVerifyAdapter;
    marketplace?: { autoRejectCompetingApplications(input: { projectId: string; acceptedApplicationId: string }): Promise<{ rejectedCount: number }> };
  }) {
    const repo = createInMemoryDepositRepository();
    let now = new Date("2026-11-04T05:20:00.000Z");
    const clock = {
      now: () => now,
      set(next: Date) {
        now = next;
      },
    };
    const contract: DepositContractInfo = {
      id: "contract-c01-link",
      projectId: "proj-c01",
      applicationId: "app-c01",
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
    let rejectCalls = 0;
    const contractsPort = {
      async getContract(id: string) {
        if (id === contract.id) return contract;
        return null;
      },
      async updateContract(id: string, patch: Partial<DepositContractInfo>) {
        if (id !== contract.id) throw new Error("Contract not found");
        Object.assign(contract, patch);
        return contract;
      },
    };
    const marketplacePort = options?.marketplace ?? {
      async autoRejectCompetingApplications() {
        rejectCalls += 1;
        return { rejectedCount: 2 };
      },
    };
    const completionPort = new DepositCompletionService({
      repo,
      contractsPort,
      marketplacePort,
      clock,
    });
    const service = new DepositService({
      repo,
      contractsPort,
      webhookSecret: WEBHOOK_SECRET,
      tossAdapter: options?.tossAdapter ?? {
        async verifyPayment(orderId, paymentKey, amount) {
          return { verified: true, orderId, paymentKey, amount, status: "DONE" };
        },
      },
      clock,
      completionPort,
    });
    return { repo, contract, service, clock, rejectCalls: () => rejectCalls };
  }

  async function openLinkedDeposit(ctx: ReturnType<typeof createLinkedContext>, idempotencyKey: string) {
    return ctx.service.createDeposit(
      { userId: ctx.contract.clientUserId, role: "CLIENT" },
      { contractId: ctx.contract.id, idempotencyKey, method: "CARD", amount: 1_050_000 },
    );
  }

  it("C-01-F01 만료·누락·PG 근거 불일치는 완료와 후속 정산을 만들지 않음", async () => {
    // 준비: 호출자와 다른 PG 근거를 돌려주는 어댑터, 예치 기한이 지난 문맥.
    const ctx = createLinkedContext({
      tossAdapter: {
        async verifyPayment() {
          return { verified: true, amount: 1, orderId: "other-order", paymentKey: "other-key" };
        },
      },
    });
    const { deposit } = await openLinkedDeposit(ctx, "idem-c01-f01");
    ctx.clock.set(new Date("2026-11-07T15:00:00.000Z"));

    // 실행: 기한이 지난 뒤 완료 콜백을 보낸다.
    const expired = await callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, { orderId: deposit.id, paymentKey: "pk-expired", amount: 1_050_000, status: "DONE", transactionKey: "tx-expired" });

    // 확인: 예치·계약·구간·자동 거절 어디에도 변화가 없다.
    assert.notEqual(expired.status, "COMPLETED");
    assert.equal(expired.deposit.depositedAt, null);
    assert.equal(ctx.contract.paymentStatus, "PENDING");
    assert.equal(ctx.contract.workDueAt ?? null, null);
    assert.equal((await ctx.repo.listInstallments(ctx.contract.id)).length, 0);
    assert.equal(ctx.rejectCalls(), 0);

    // 실행: 시계를 되돌리고 결제키 누락·잘못된 비밀키·PG 근거 불일치를 보낸다.
    ctx.clock.set(new Date("2026-11-04T05:20:00.000Z"));
    await assert.rejects(
      () =>
        callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, { orderId: deposit.id, paymentKey: "", amount: 1_050_000, status: "DONE" }),
      (err: unknown) => err instanceof DepositHttpError && err.status === 400,
    );
    await assert.rejects(
      () =>
        callWebhook(ctx.service, { securityKey: "fedcba9876543210".repeat(4) }, { orderId: deposit.id, paymentKey: "pk-auth", amount: 1_050_000, status: "DONE" }),
      (err: unknown) => err instanceof DepositHttpError && err.status === 401,
    );

    const mismatched = await callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, { orderId: deposit.id, paymentKey: "pk-evidence", amount: 1_050_000, status: "DONE", transactionKey: "tx-evidence" });

    // 확인: 불일치 콜백도 완료·정산·거절을 만들지 않는다.
    assert.notEqual(mismatched.status, "COMPLETED");
    assert.equal(mismatched.deposit.depositedAt, null);
    assert.equal(ctx.contract.paymentStatus, "PENDING");
    assert.equal((await ctx.repo.listInstallments(ctx.contract.id)).length, 0);
    assert.equal(ctx.rejectCalls(), 0);
    const saved = await ctx.repo.findById(deposit.id);
    assert.equal(saved?.status === "COMPLETED", false);
  });

  it("C-01-F01b verified 표지만 있고 PG 거래 식별 근거가 없으면 예치를 완료하지 않음", async () => {
    // 준비
    const ctx = createLinkedContext({
      tossAdapter: { async verifyPayment() { return { verified: true }; } },
    });
    const { deposit } = await openLinkedDeposit(ctx, "idem-c01-f01b");

    // 실행
    const result = await callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, { orderId: deposit.id, paymentKey: "pk-unmatched", amount: 1_050_000, status: "DONE" });

    // 확인
    assert.equal(result.status, "HELD");
    assert.equal(result.reason, "VERIFY_FAILED");
    assert.equal(ctx.contract.paymentStatus, "PENDING");
    assert.equal((await ctx.repo.listInstallments(ctx.contract.id)).length, 0);
    assert.equal(ctx.rejectCalls(), 0);
  });

  it("C-01-F01c null 웹훅 본문은 400으로 거절", async () => {
    // 준비
    const ctx = createLinkedContext();

    // 실행 및 확인
    await assert.rejects(
      () => callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, null),
      (err: unknown) => err instanceof DepositHttpError && err.status === 400,
    );
  });

  it("C-01-F01d 웹훅 보안 키가 비어 있으면 서명 검증에 실패", async () => {
    // 준비
    const service = new DepositService({
      repo: createInMemoryDepositRepository(),
      contractsPort: { async getContract() { return null; } },
      webhookSecret: "",
      tossAdapter: { async verifyPayment() { return { verified: false }; } },
      completionPort: { async completeDeposit() { throw new Error("unexpected completion"); } },
    });

    // 실행 및 확인
    await assert.rejects(
      () =>
        callWebhook(service, { securityKey: "" }, { orderId: "missing", paymentKey: "pk", amount: 1, status: "DONE" }),
      (err: unknown) => err instanceof DepositHttpError && err.status === 401,
    );
  });

  it("C-01-F02 완료된 예치의 키·시각·금액·지급 상태는 다른 transactionKey로 바뀌지 않음", async () => {
    // 준비: 이미 완료된 예치와 계약 상태를 만든다.
    const ctx = createLinkedContext();
    const { deposit } = await openLinkedDeposit(ctx, "idem-c01-f02");
    const depositedAt = new Date("2026-11-04T05:20:00.000Z");
    await ctx.repo.updateDeposit(deposit.id, {
      status: "COMPLETED",
      pgKey: "pk-original",
      depositedAt,
      amount: 1_050_000,
    });
    ctx.contract.paymentStatus = "DEPOSITED";
    ctx.contract.totalDeposited = 1_050_000;
    ctx.contract.workDueAt = new Date("2026-12-16T14:59:59.999Z");
    await ctx.repo.createPaymentEvent({
      depositId: deposit.id,
      eventType: "VERIFIED",
      dedupKey: "tx-original",
      payload: { paymentKey: "pk-original" },
      resultNote: "결제 검증 성공",
    });
    ctx.clock.set(new Date("2026-11-08T00:00:00.000Z"));

    // 실행: 다른 transactionKey로 같은 예치 콜백을 다시 보낸다.
    const replay = await callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, {
      orderId: deposit.id,
      paymentKey: "pk-replaced",
      amount: 1_050_000,
      status: "DONE",
      transactionKey: "tx-replaced",
    });

    // 확인: 처음 완료 근거가 그대로 남는다.
    assert.equal(replay.status, "COMPLETED");
    assert.equal(replay.deposit.pgKey, "pk-original");
    assert.equal(replay.deposit.depositedAt?.toISOString(), depositedAt.toISOString());
    assert.equal(replay.deposit.amount, 1_050_000);
    assert.equal(replay.deposit.status, "COMPLETED");
    assert.equal(ctx.contract.paymentStatus, "DEPOSITED");
    assert.equal(ctx.contract.totalDeposited, 1_050_000);
    assert.equal(ctx.contract.workDueAt?.toISOString(), "2026-12-16T14:59:59.999Z");
    const events = await ctx.repo.listPaymentEvents(deposit.id);
    assert.equal(events.filter((event) => event.eventType === "VERIFIED").length, 1);
    assert.equal(events.some((event) => event.dedupKey === "tx-replaced"), false);
    assert.equal(ctx.rejectCalls(), 0);
  });

  it("C-01-F02b 병렬 웹훅은 예치 확정과 VERIFIED 이벤트를 한 번만 남김", async () => {
    // 준비: 검증이 20ms 걸리는 어댑터로 동시 호출을 만든다.
    const ctx = createLinkedContext({
      tossAdapter: {
        async verifyPayment(orderId, paymentKey, amount) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { verified: true, orderId, paymentKey, amount, status: "DONE" };
        },
      },
    });
    const { deposit } = await openLinkedDeposit(ctx, "idem-c01-f02b");
    const payload = {
      orderId: deposit.id,
      amount: 1_050_000,
      status: "DONE",
    };

    // 실행
    const [first, second] = await Promise.all([
      callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, { ...payload, paymentKey: "pk-a", transactionKey: "tx-a" }),
      callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, { ...payload, paymentKey: "pk-b", transactionKey: "tx-b" }),
    ]);

    // 확인: 한 번만 확정되고 구간 2개·자동 거절 1회만 남는다.
    const saved = await ctx.repo.findById(deposit.id);
    assert.ok(saved);
    assert.equal(saved.status, "COMPLETED");
    assert.equal(first.deposit.pgKey, saved.pgKey);
    assert.equal(second.deposit.pgKey, saved.pgKey);
    assert.equal(first.deposit.depositedAt?.toISOString(), saved.depositedAt?.toISOString());
    assert.equal(second.deposit.depositedAt?.toISOString(), saved.depositedAt?.toISOString());
    assert.equal(saved.amount, 1_050_000);
    const verified = (await ctx.repo.listPaymentEvents(deposit.id)).filter((event) => event.eventType === "VERIFIED");
    assert.equal(verified.length, 1);
    assert.equal(ctx.contract.paymentStatus, "DEPOSITED");
    assert.equal((await ctx.repo.listInstallments(ctx.contract.id)).length, 2);
    assert.equal(ctx.rejectCalls(), 1);
  });

  it("C-01-F03 검증된 웹훅 1회가 예치 확정·구간·마감·지원 거절까지 연결됨", async () => {
    // 준비
    const ctx = createLinkedContext();
    const { deposit } = await openLinkedDeposit(ctx, "idem-c01-f03");
    const payload: TossWebhookPayload = {
      orderId: deposit.id,
      paymentKey: "pk-confirmed",
      amount: 1_050_000,
      status: "DONE",
      transactionKey: "tx-confirmed",
    };

    // 실행
    const result = await callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, payload);

    // 확인: 예치 확정과 함께 계약·구간·자동 거절이 한 번씩 반영된다.
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.deposit.pgKey, "pk-confirmed");
    assert.equal(result.deposit.depositedAt?.toISOString(), "2026-11-04T05:20:00.000Z");
    assert.equal(ctx.contract.paymentStatus, "DEPOSITED");
    assert.equal(ctx.contract.status, "ACTIVE");
    assert.equal(ctx.contract.totalDeposited, 1_050_000);
    assert.equal(ctx.contract.workDueAt?.toISOString(), "2026-12-16T14:59:59.999Z");
    const installments = await ctx.repo.listInstallments(ctx.contract.id);
    assert.equal(installments.length, 2);
    assert.ok(installments.some((row) => row.stage === "INTERIM"));
    assert.ok(installments.some((row) => row.stage === "FINAL"));
    assert.equal(ctx.rejectCalls(), 1);

    // 실행: 같은 콜백을 다시 보낸다.
    const replay = await callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, payload);

    // 확인: 재전송은 중복 부수효과를 만들지 않는다.
    assert.equal(replay.deposit.pgKey, "pk-confirmed");
    assert.equal((await ctx.repo.listInstallments(ctx.contract.id)).length, 2);
    assert.equal(ctx.rejectCalls(), 1);
    assert.equal(
      (await ctx.repo.listPaymentEvents(deposit.id)).filter((event) => event.eventType === "VERIFIED").length,
      1,
    );
  });

  it("C-01-F03b 확정 도중 실패하면 예치·계약·구간·지원 거절이 남지 않음", async () => {
    // 준비: 자동 거절이 실패하는 문맥.
    const ctx = createLinkedContext({
      marketplace: {
        async autoRejectCompetingApplications() {
          throw new Error("DB_TRANSACTION_DEADLOCK");
        },
      },
    });
    const { deposit } = await openLinkedDeposit(ctx, "idem-c01-f03b");

    // 실행 및 확인
    await assert.rejects(
      () =>
        callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, { orderId: deposit.id, paymentKey: "pk-rollback", amount: 1_050_000, status: "DONE", transactionKey: "tx-rollback" }),
      (err: unknown) => err instanceof Error && /DB_TRANSACTION_DEADLOCK/.test(err.message),
    );

    // 확인: 실패 전 상태로 완전히 되돌아간다.
    const saved = await ctx.repo.findById(deposit.id);
    assert.ok(saved);
    assert.equal(saved.status, "PENDING");
    assert.equal(saved.pgKey, null);
    assert.equal(saved.depositedAt, null);
    assert.equal(saved.amount, 1_050_000);
    assert.equal(ctx.contract.paymentStatus, "PENDING");
    assert.equal(ctx.contract.totalDeposited ?? 0, 0);
    assert.equal(ctx.contract.workDueAt ?? null, null);
    assert.equal((await ctx.repo.listInstallments(ctx.contract.id)).length, 0);
    assert.equal(
      (await ctx.repo.listPaymentEvents(deposit.id)).filter((event) => event.eventType === "VERIFIED").length,
      0,
    );
  });

  it("C-01-F04 사용자 PG 승인 확인은 예치·계약·2구간을 완료하고 재요청에 멱등", async () => {
    // 준비: Toss 승인(POST confirm)을 흉내 내는 어댑터와 PENDING 예치
    const ctx = createLinkedContext({
      tossAdapter: {
        async confirmPayment(orderId, paymentKey, amount) {
          return { verified: true, orderId, paymentKey, amount, status: "DONE" };
        },
      },
    });
    const { deposit } = await openLinkedDeposit(ctx, "idem-confirm-1");

    // 실행: 의뢰인이 저장된 주문·금액으로 승인 확인
    const confirmed = await ctx.service.confirmDeposit(
      { userId: ctx.contract.clientUserId, role: "CLIENT" },
      { contractId: ctx.contract.id, depositId: deposit.id, paymentKey: "pk-confirm-1", amount: 1_050_000 },
    );

    // 확인: 예치·계약·구간·경쟁 지원이 한 번만 확정된다
    assert.equal(confirmed.deposit.status, "COMPLETED");
    assert.equal(confirmed.deposit.pgKey, "pk-confirm-1");
    assert.equal(confirmed.contract.paymentStatus, "DEPOSITED");
    assert.equal(confirmed.installments.length, 2);
    assert.equal(ctx.rejectCalls(), 1);

    // 실행: 같은 결제로 다시 승인 확인
    const again = await ctx.service.confirmDeposit(
      { userId: ctx.contract.clientUserId, role: "CLIENT" },
      { contractId: ctx.contract.id, depositId: deposit.id, paymentKey: "pk-confirm-1", amount: 1_050_000 },
    );

    // 확인: 구간·자동 거절이 늘지 않는다
    assert.equal(again.deposit.status, "COMPLETED");
    assert.equal((await ctx.repo.listInstallments(ctx.contract.id)).length, 2);
    assert.equal(ctx.rejectCalls(), 1);
  });

  it("C-01-F05 사용자 승인은 소유자·금액·상태·PG 근거를 검증한다", async () => {
    // 준비: PG 승인·재조회 모두 거부하는 어댑터와 PENDING 예치
    const ctx = createLinkedContext({
      tossAdapter: {
        async confirmPayment() {
          return { verified: false };
        },
        async verifyPayment() {
          return { verified: false };
        },
      },
    });
    const { deposit } = await openLinkedDeposit(ctx, "idem-confirm-2");
    const asClient = { userId: ctx.contract.clientUserId, role: "CLIENT" };
    const base = {
      contractId: ctx.contract.id,
      depositId: deposit.id,
      paymentKey: "pk-confirm-2",
      amount: 1_050_000,
    };

    // 실행 및 확인: 계약 소유자가 아니면 403
    await assert.rejects(
      () => ctx.service.confirmDeposit({ userId: "other-client", role: "CLIENT" }, base),
      (err: unknown) => err instanceof DepositHttpError && err.status === 403,
    );

    // 실행 및 확인: 요청 금액이 저장된 예치 금액과 다르면 400
    await assert.rejects(
      () => ctx.service.confirmDeposit(asClient, { ...base, amount: 1 }),
      (err: unknown) => err instanceof DepositHttpError && err.status === 400,
    );

    // 실행 및 확인: 다른 계약의 예치로는 승인할 수 없다
    await assert.rejects(
      () => ctx.service.confirmDeposit(asClient, { ...base, contractId: "contract-other" }),
      (err: unknown) => err instanceof DepositHttpError && err.status === 404,
    );

    // 실행 및 확인: PG 승인 근거가 없으면 완료하지 않는다
    await assert.rejects(
      () => ctx.service.confirmDeposit(asClient, base),
      (err: unknown) =>
        err instanceof DepositHttpError && err.status === 422 && err.code === "PAYMENT_VERIFICATION_FAILED",
    );

    // 준비: 운영자 보류로 바뀐 예치
    await ctx.repo.updateDeposit(deposit.id, { status: "HELD", heldReason: "manual review" });
    // 실행 및 확인: HELD는 사용자 승인 대상이 아니다
    await assert.rejects(
      () => ctx.service.confirmDeposit(asClient, base),
      (err: unknown) => err instanceof DepositHttpError && err.status === 409,
    );
  });

  it("C-01-F08 PG 승인 adapter가 없으면 사용자 승인은 503", async () => {
    // 준비: 승인·재조회 메서드가 없는 adapter
    const ctx = createLinkedContext({ tossAdapter: {} });
    const { deposit } = await openLinkedDeposit(ctx, "idem-confirm-3");

    // 실행 및 확인
    await assert.rejects(
      () =>
        ctx.service.confirmDeposit(
          { userId: ctx.contract.clientUserId, role: "CLIENT" },
          { contractId: ctx.contract.id, depositId: deposit.id, paymentKey: "pk-confirm-3", amount: 1_050_000 },
        ),
      (err: unknown) => err instanceof DepositHttpError && err.status === 503 && err.code === "PG_UNAVAILABLE",
    );
  });

  it("C-01-F09 PG 재조회 일시 장애는 PENDING으로 남겨 다시 시도하게 한다", async () => {
    // 준비: 결제 승인 실패 뒤 PG GET도 일시 실패하는 상황
    const ctx = createLinkedContext({
      tossAdapter: {
        async confirmPayment() {
          return { verified: false };
        },
        async verifyPayment() {
          return { verified: false, retryable: true };
        },
      },
    });
    const { deposit } = await openLinkedDeposit(ctx, "idem-confirm-retryable");

    // 실행 및 확인: 재시도 가능한 PG 장애는 503이고 예치 상태는 PENDING
    await assert.rejects(
      () =>
        ctx.service.confirmDeposit(
          { userId: ctx.contract.clientUserId, role: "CLIENT" },
          { contractId: ctx.contract.id, depositId: deposit.id, paymentKey: "pk-confirm-retryable", amount: 1_050_000 },
        ),
      (err: unknown) => err instanceof DepositHttpError && err.status === 503 && err.code === "PG_UNAVAILABLE",
    );
    assert.equal((await ctx.repo.findById(deposit.id))?.status, "PENDING");
  });

  it("C-01-F10 15분 경과 시 PG orderId 재조회로 누락된 웹훅을 복구한다", async () => {
    let lookups = 0;
    const ctx = createLinkedContext({
      tossAdapter: {
        async findPaymentByOrderId(orderId) {
          lookups += 1;
          return {
            found: true,
            orderId,
            paymentKey: "pk-reconciled",
            amount: 1_050_000,
            status: "DONE",
          };
        },
      },
    });
    const { deposit } = await openLinkedDeposit(ctx, "idem-reconcile-success");
    const checkedAt = new Date("2026-11-04T05:20:00.000Z");

    // 실행: 15분 전보다 새 요청은 조회하지 않는다
    await ctx.repo.updateDeposit(deposit.id, {
      createdAt: new Date(checkedAt.getTime() - 14 * 60_000),
    });
    assert.deepEqual(await ctx.service.reconcilePendingPayment(deposit.id, checkedAt), { completed: false });
    assert.equal(lookups, 0);

    // 실행: 15분 경계에서 승인된 결제를 재조회한다
    await ctx.repo.updateDeposit(deposit.id, {
      createdAt: new Date(checkedAt.getTime() - 15 * 60_000),
    });
    const recovered = await ctx.service.reconcilePendingPayment(deposit.id, checkedAt);

    // 확인: 예치·계약·구간이 정상 완료되고 같은 웹훅은 멱등이다
    assert.deepEqual(recovered, { completed: true });
    assert.equal(lookups, 1);
    assert.equal((await ctx.repo.findById(deposit.id))?.status, "COMPLETED");
    assert.equal(ctx.contract.paymentStatus, "DEPOSITED");
    assert.equal((await ctx.repo.listInstallments(ctx.contract.id)).length, 2);
    const duplicate = await callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, {
      orderId: deposit.id,
      paymentKey: "pk-reconciled",
      amount: 1_050_000,
      status: "DONE",
    });
    assert.equal(duplicate.isDuplicate, true);
    assert.equal(ctx.rejectCalls(), 1);
  });

  it("C-01-F11 주문 결제 미발견은 PENDING, 조회 금액 불일치는 HELD로 남긴다", async () => {
    const checkedAt = new Date("2026-11-04T05:20:00.000Z");
    const unpaid = createLinkedContext({
      tossAdapter: { async findPaymentByOrderId() { return { found: false }; } },
    });
    const unpaidDeposit = await openLinkedDeposit(unpaid, "idem-reconcile-unpaid");
    await unpaid.repo.updateDeposit(unpaidDeposit.deposit.id, {
      createdAt: new Date(checkedAt.getTime() - 15 * 60_000),
    });
    assert.deepEqual(
      await unpaid.service.reconcilePendingPayment(unpaidDeposit.deposit.id, checkedAt),
      { completed: false },
    );
    assert.equal((await unpaid.repo.findById(unpaidDeposit.deposit.id))?.status, "PENDING");
    const mismatched = createLinkedContext({
      tossAdapter: {
        async findPaymentByOrderId(orderId) {
          return {
            found: true,
            orderId,
            paymentKey: "pk-reconciled-mismatch",
            amount: 1_050_001,
            status: "DONE",
          };
        },
      },
    });
    const mismatchedDeposit = await openLinkedDeposit(mismatched, "idem-reconcile-mismatch");
    await mismatched.repo.updateDeposit(mismatchedDeposit.deposit.id, {
      createdAt: new Date(checkedAt.getTime() - 15 * 60_000),
    });

    // 실행 및 확인: PG가 승인한 다른 금액은 완료하지 않고 격리한다
    assert.deepEqual(
      await mismatched.service.reconcilePendingPayment(mismatchedDeposit.deposit.id, checkedAt),
      { completed: false },
    );
    const held = await mismatched.repo.findById(mismatchedDeposit.deposit.id);
    assert.equal(held?.status, "HELD");
    assert.equal(held?.heldReason, "AMOUNT_MISMATCH");
    assert.equal(mismatched.contract.paymentStatus, "PENDING");
  });

  it("C-01-F12 PG 주문 재조회 장애는 503으로 남겨 다시 시도한다", async () => {
    const checkedAt = new Date("2026-11-04T05:20:00.000Z");
    const ctx = createLinkedContext({
      tossAdapter: {
        async findPaymentByOrderId() {
          return { found: false, retryable: true };
        },
      },
    });
    const { deposit } = await openLinkedDeposit(ctx, "idem-reconcile-transient");
    await ctx.repo.updateDeposit(deposit.id, {
      createdAt: new Date(checkedAt.getTime() - 15 * 60_000),
    });

    // 실행 및 확인: PG 장애는 재시도 응답이고 예치는 PENDING 유지
    await assert.rejects(
      () => ctx.service.reconcilePendingPayment(deposit.id, checkedAt),
      (err: unknown) => err instanceof DepositHttpError && err.status === 503 && err.code === "PG_UNAVAILABLE",
    );
    assert.equal((await ctx.repo.findById(deposit.id))?.status, "PENDING");
  });

  it("C-01-F06 Toss 원형 PAYMENT_STATUS_CHANGED를 정규화해 완료하고 중복은 멱등", async () => {
    // 준비: 기존 평면 계약이 아닌 Toss 원형 eventType/data 본문
    const ctx = createLinkedContext();
    const { deposit } = await openLinkedDeposit(ctx, "idem-raw-1");
    const event = {
      eventType: "PAYMENT_STATUS_CHANGED",
      createdAt: "2026-11-04T05:20:00.000Z",
      data: {
        orderId: deposit.id,
        paymentKey: "pk-raw-1",
        totalAmount: 1_050_000,
        status: "DONE",
      },
    };

    // 실행: 원형 이벤트로 예치 확정
    const confirmed = await callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, event);

    // 확인: 내부 계약과 같은 결과를 만든다
    assert.equal(confirmed.status, "COMPLETED");
    assert.equal(ctx.contract.paymentStatus, "DEPOSITED");
    assert.equal((await ctx.repo.listInstallments(ctx.contract.id)).length, 2);
    assert.equal(ctx.rejectCalls(), 1);

    // 실행: 같은 원형 이벤트 재수신
    const duplicate = await callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, event);

    // 확인: 구간·자동 거절이 늘지 않는다
    assert.equal(duplicate.status, "COMPLETED");
    assert.equal(duplicate.isDuplicate, true);
    assert.equal((await ctx.repo.listInstallments(ctx.contract.id)).length, 2);
    assert.equal(ctx.rejectCalls(), 1);
  });

  it("C-01-F07 원형 이벤트의 상태·필드가 잘못되면 HELD 또는 400", async () => {
    // 준비
    const ctx = createLinkedContext();
    const { deposit } = await openLinkedDeposit(ctx, "idem-raw-2");

    // 실행: DONE이 아닌 원형 이벤트
    const canceled = await callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, {
      eventType: "PAYMENT_STATUS_CHANGED",
      data: { orderId: deposit.id, paymentKey: "pk-raw-2", totalAmount: 1_050_000, status: "CANCELED" },
    });
    // 확인: 성공으로 확정하지 않고 HELD로 격리한다
    assert.equal(canceled.status, "HELD");

    // 실행 및 확인: 필수 필드가 빠진 원형 이벤트는 400
    await assert.rejects(
      () =>
        callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, { eventType: "PAYMENT_STATUS_CHANGED", data: { orderId: deposit.id } }),
      (err: unknown) => err instanceof DepositHttpError && err.status === 400,
    );

    // 실행 및 확인: 지원하지 않는 이벤트 타입은 400
    await assert.rejects(
      () =>
        callWebhook(ctx.service, { securityKey: WEBHOOK_SECRET }, { eventType: "DEPOSIT_CALLBACK", data: { orderId: deposit.id, paymentKey: "x", totalAmount: 1, status: "DONE" } }),
      (err: unknown) => err instanceof DepositHttpError && err.status === 400,
    );
  });
});
