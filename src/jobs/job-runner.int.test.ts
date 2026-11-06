import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDueJobRunner, startDueJobScheduler } from "./index.ts";

describe("INT-C-04: 배치 러너·스케줄러", () => {
  const t0 = new Date("2026-11-04T05:20:00.000Z");

  function services(options?: { failOnce?: boolean }) {
    let attempts = 0;
    let autoApproved = 0;
    return {
      get attempts() {
        return attempts;
      },
      get autoApproved() {
        return autoApproved;
      },
      batchService: {
        async processAutoApproval() {
          return { autoApprovedCount: autoApproved };
        },
        async sendDueNotifications() {},
      },
      completionService: {
        async expireDepositIfDue() {
          attempts += 1;
          if (options?.failOnce && attempts === 1) throw new Error("TRANSIENT");
          autoApproved = 1;
          return { expired: true };
        },
      },
      cancellationService: {
        async checkCancellationDeadlines() {
          return { escalatedToAdmin: false };
        },
      },
    };
  }

  it("targets로 대상을 조회하고 일시 실패를 재시도한다", async () => {
    // 준비
    const target = services({ failOnce: true });
    const runner = createDueJobRunner({
      services: target,
      targets: {
        async depositContractIds() {
          return ["contract-1"];
        },
      },
      retries: 1,
      clock: { now: () => t0 },
    });

    // 실행
    const result = await runner.runOnce();
    // 확인
    assert.equal(result.success, true);
    assert.equal(result.actionsCount, 1);
    assert.equal(target.attempts, 2);
  });

  it("실패는 결과에 남기고 스케줄러는 예외를 onError로 넘긴다", async () => {
    // 준비
    const runner = createDueJobRunner({
      services: {
        completionService: {
          async expireDepositIfDue() {
            throw new Error("PERSISTENT");
          },
        },
      },
      targets: {
        async depositContractIds() {
          return ["contract-fail"];
        },
      },
      retries: 0,
    });

    // 실행
    const result = await runner.runOnce(t0);
    // 확인
    assert.equal(result.success, false);
    assert.equal(result.failures[0].job, "DEPOSIT_DEADLINE");
  });

  it("스케줄러는 runOnce 거부를 삼키지 않고 onError로 전달한다", async () => {
    // 준비
    const errors: unknown[] = [];
    const timer: { handler: (() => void) | null } = { handler: null };
    const stop = startDueJobScheduler(
      {
        async runOnce() {
          throw new Error("SCHEDULER_FAIL");
        },
      },
      {
        timers: {
          setInterval(fn) {
            timer.handler = fn;
            return 1;
          },
          clearInterval() {},
        },
        onError(err) {
          errors.push(err);
        },
      },
    );
    // 확인: 틱 핸들러 등록
    assert.ok(timer.handler);

    // 실행
    timer.handler!();
    await new Promise((resolve) => setImmediate(resolve));

    // 확인
    assert.equal((errors[0] as Error).message, "SCHEDULER_FAIL");
    stop();
  });

  it("60초 반복 틱은 이전 실행이 끝나기 전에 겹치지 않는다", async () => {
    // 준비
    const timer: { handler: (() => void) | null } = { handler: null };
    let runs = 0;
    let release: (() => void) | null = null;
    const stop = startDueJobScheduler(
      {
        async runOnce() {
          runs += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { success: true, actionsCount: 0, failures: [] };
        },
      },
      {
        intervalMs: 60_000,
        timers: {
          setInterval(fn) {
            timer.handler = fn;
            return 1;
          },
          clearInterval() {},
        },
      },
    );

    // 실행: 이전 실행이 끝나기 전에 틱을 두 번 발생
    timer.handler!();
    timer.handler!();
    // 확인
    assert.equal(runs, 1); // 이전 실행 중에는 겹치지 않음

    // 실행: 이전 실행을 끝내고 다시 틱 발생
    release!();
    await new Promise((resolve) => setImmediate(resolve));
    timer.handler!();
    // 확인
    assert.equal(runs, 2);
    stop();
  });

  it("프로젝트 마감·계약 결렬 배치를 같은 실행에 포함한다", async () => {
    // 준비
    let projects = 0;
    let contracts = 0;
    const runner = createDueJobRunner({
      services: {
        projectDeadlines: async () => {
          projects += 1;
          return { recruiting: 1, selecting: 1, expired: 1 };
        },
        contractBreaks: async () => {
          contracts += 1;
          return 2;
        },
      },
      targets: {},
      retries: 0,
    });

    // 실행
    const result = await runner.runOnce(t0);
    // 확인
    assert.equal(result.success, true);
    assert.equal(projects, 1);
    assert.equal(contracts, 1);
    assert.equal(result.actionsCount, 5);
  });

  it("프로젝트·계약 배치 실패를 job별로 남긴다", async () => {
    // 준비
    const runner = createDueJobRunner({
      services: {
        projectDeadlines: async () => {
          throw new Error("PROJECT_FAIL");
        },
        contractBreaks: async () => {
          throw new Error("CONTRACT_FAIL");
        },
      },
      targets: {},
      retries: 0,
    });

    // 실행
    const result = await runner.runOnce(t0);
    // 확인
    assert.equal(result.success, false);
    assert.deepEqual(result.failures.map((failure) => failure.job), ["PROJECT_DEADLINE", "CONTRACT_BREAK"]);
  });
  it("PG 주문 재조회는 시간 경계 대상을 처리하고 실패를 별도 job으로 기록한다", async () => {
    const recovered: string[] = [];
    let createdBefore: Date | undefined;
    const runner = createDueJobRunner({
      services: {
        paymentRecoveryService: {
          async reconcilePendingPayment(depositId) {
            recovered.push(depositId);
            if (depositId === "deposit-paid") return { completed: true };
            throw new Error("PG_UNAVAILABLE");
          },
        },
      },
      targets: {
        async pendingDepositIds(before) {
          createdBefore = before;
          return ["deposit-paid", "deposit-unavailable"];
        },
      },
      retries: 0,
      clock: { now: () => t0 },
    });

    // 실행
    const result = await runner.runOnce();

    // 확인
    assert.equal(createdBefore?.getTime(), t0.getTime() - 15 * 60_000);
    assert.deepEqual(recovered, ["deposit-paid", "deposit-unavailable"]);
    assert.equal(result.success, false);
    assert.equal(result.actionsCount, 1);
    assert.deepEqual(result.failures.map((failure) => failure.job), ["TOSS_PAYMENT_RECONCILIATION"]);
  });
});
