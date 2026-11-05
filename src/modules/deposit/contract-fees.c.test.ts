import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DepositCompletionService,
  createInMemoryDepositRepository,
  type DepositContractInfo,
} from "./index.ts";
import {
  AdapterMissingError,
  MoneyError,
  PortError,
  endOfKstDayPlus,
  approvalGate,
  assertCompensationRate,
  blocksDepositDeadlineCancel,
  calculateCancelSettlement,
  calculateClientDeposit,
  calculateSupplierRelease,
  canOpenDeposit,
  isClientFullRefund,
  competingRejectOnSign,
  createMemoryAccounts,
  createMemoryContractPorts,
  createMemoryNotifications,
  createMockPayout,
  createMockStorage,
  createMockToss,
  fixedClock,
  freezeAgreementTerms,
  isInspectionBasis,
  onDepositCompleted,
  requireDepositContractTerms,
  requireExternalAdapters,
  splitInstallments,
} from "../settlement/policy.ts";

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

const depositClock = new Date("2026-11-04T05:20:00.000Z");

function depositFixture(patch: Partial<DepositContractInfo> = {}): DepositContractInfo {
  return {
    id: "deposit-terms",
    projectId: "proj-1",
    applicationId: "app-1",
    clientUserId: "client-1",
    supplierUserId: "supplier-1",
    status: "ACTIVE",
    paymentStatus: "PENDING",
    agreedAmount: 1_000_000,
    clientFee: 50_000,
    interimRatio: 40,
    durationDays: 35,
    depositDeadline: new Date("2026-11-07T14:59:59.999Z"),
    totalDeposited: 0,
    workDueAt: null,
    ...patch,
  };
}

function completionHarness(contract: DepositContractInfo) {
  const repo = createInMemoryDepositRepository();
  let rejected = 0;
  const service = new DepositCompletionService({
    repo,
    contractsPort: {
      async getContract(id) {
        return id === contract.id ? contract : null;
      },
      async updateContract(id, patch) {
        if (id !== contract.id) {
          throw new Error("missing contract");
        }
        Object.assign(contract, patch);
        return contract;
      },
    },
    marketplacePort: {
      async autoRejectCompetingApplications() {
        rejected += 1;
        return { rejectedCount: 1 };
      },
    },
    clock: { now: () => depositClock },
  });
  return { repo, service, rejectedCount: () => rejected };
}

describe("C-00 계약·예치 공통 규칙", () => {
  it("C-00-T01 합의금 1,000,000원의 의뢰인 수수료와 예치액", () => {
    // 준비: 합의금 1,000,000원과 3,100,000원
    // 실행 및 확인: 5% 수수료가 더해진 예치액
    assert.deepEqual(calculateClientDeposit(1_000_000), {
      principal: 1_000_000,
      clientFee: 50_000,
      depositAmount: 1_050_000,
    });
    assert.deepEqual(calculateClientDeposit(3_100_000), {
      principal: 3_100_000,
      clientFee: 155_000,
      depositAmount: 3_255_000,
    });
  });

  it("C-00-T02 중간 비율 10/50/90과 최종 잔여액", () => {
    // 준비: 끝수가 있는 합의금과 균등 분할 금액
    // 실행 및 확인: 비율별 중간·최종 분할과 허용 범위 밖 거부
    assert.deepEqual(splitInstallments(1_000_001, 10), { interimAmount: 100_000, finalAmount: 900_001 });
    assert.deepEqual(splitInstallments(1_000_001, 50), { interimAmount: 500_000, finalAmount: 500_001 });
    assert.deepEqual(splitInstallments(1_000_001, 90), { interimAmount: 900_000, finalAmount: 100_001 });
    const even = splitInstallments(3_100_000, 50);
    assert.deepEqual(even, { interimAmount: 1_550_000, finalAmount: 1_550_000 });
    assert.equal(even.interimAmount + even.finalAmount, 3_100_000);
    assert.throws(() => splitInstallments(1_000_000, 9), MoneyError);
    assert.throws(() => splitInstallments(1_000_000, 91), MoneyError);
  });

  it("C-00-T03 0·음수·소수·Int 초과를 거부", () => {
    // 준비: 경계를 벗어난 금액 입력
    // 실행 및 확인: 모두 MoneyError로 거부
    assert.throws(() => calculateClientDeposit(0), MoneyError);
    assert.throws(() => calculateClientDeposit(-1), MoneyError);
    assert.throws(() => calculateClientDeposit(0.5), MoneyError);
    assert.throws(() => calculateClientDeposit(2_147_483_648), MoneyError);
    assert.throws(() => calculateSupplierRelease({ amount: 0, kind: "INDIVIDUAL" }), MoneyError);
    assert.throws(() => calculateSupplierRelease({ amount: -1, kind: "BUSINESS" }), MoneyError);
    assert.throws(() => calculateSupplierRelease({ amount: 0.5, kind: "BUSINESS" }), MoneyError);
    assert.throws(() => calculateSupplierRelease({ amount: 2_147_483_648, kind: "BUSINESS" }), MoneyError);
    assert.throws(() => calculateClientDeposit(2_100_000_000), MoneyError);
  });

  it("C-00-T04 수수료와 원천징수를 금액에서 각각 원 단위로 내림", () => {
    // 준비: 개인·사업자 지급액과 소액 지급액
    // 실행 및 확인: 수수료·원천징수·실수령액 계산
    assert.deepEqual(calculateSupplierRelease({ amount: 1_550_000, kind: "INDIVIDUAL" }), {
      supplierFee: 77_500,
      withholdingTax: 51_150,
      releaseAmount: 1_421_350,
    });
    assert.deepEqual(calculateSupplierRelease({ amount: 1_550_000, kind: "BUSINESS" }), {
      supplierFee: 77_500,
      withholdingTax: 0,
      releaseAmount: 1_472_500,
    });
    assert.deepEqual(calculateSupplierRelease({ amount: 16, kind: "INDIVIDUAL" }), {
      supplierFee: 0,
      withholdingTax: 0,
      releaseAmount: 16,
    });
    assert.deepEqual(calculateSupplierRelease({ amount: 1_000, kind: "INDIVIDUAL" }), {
      supplierFee: 50,
      withholdingTax: 33,
      releaseAmount: 917,
    });
  });

  it("C-00-T05 어댑터가 없으면 실 API를 호출하지 않음", async () => {
    // 준비: 실제 네트워크 호출을 감시하는 fetch 대체
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      calls.push(String(input));
      return Promise.reject(new Error("real network"));
    };
    try {
      // 실행: 어댑터 없는 호출과 mock 어댑터 호출
      assert.throws(() => requireExternalAdapters(undefined), AdapterMissingError);
      assert.throws(() => requireExternalAdapters({}), AdapterMissingError);
      const ready = requireExternalAdapters({
        toss: createMockToss(),
        storage: createMockStorage(),
        payout: createMockPayout(),
      });
      // 확인: mock 응답만 반환하고 실 네트워크 호출은 0건
      assert.deepEqual(await ready.toss.readPayment("order-1"), { status: "UNKNOWN" });
      assert.deepEqual(await ready.storage.signRead("obj"), { url: "mock:obj", expiresInSec: 60 });
      assert.deepEqual(await ready.payout.check("supplier-1"), { verified: false, mode: "MOCK" });
      assert.equal(calls.length, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("취소 예시 수식과 보상 비율 검증, 24시간 예외는 D-16 승인 대기", () => {
    // 준비: 합의금 3,100,000원과 예치·요청 시각
    // 실행 및 확인: 취소 정산 금액과 보상 비율 범위
    assert.deepEqual(
      calculateCancelSettlement({
        principal: 3_100_000,
        clientFee: 155_000,
        compensationPrincipal: 775_000,
      }),
      {
        supplierFee: 38_750,
        clientFeeKept: 38_750,
        clientFeeRefund: 116_250,
        refundAmount: 2_441_250,
        settledAmount: 736_250,
      },
    );
    assert.throws(() => assertCompensationRate("CLIENT", 0), MoneyError);
    assert.throws(() => assertCompensationRate("CLIENT", 49), MoneyError);
    assert.doesNotThrow(() => assertCompensationRate("CLIENT", 50));
    assert.doesNotThrow(() => assertCompensationRate("CLIENT", 100));
    assert.throws(() => assertCompensationRate("MUTUAL", 101), MoneyError);
    assert.doesNotThrow(() => assertCompensationRate("MUTUAL", 0));
    // 확인: 24시간 이내·무납품일 때만 전액 환불
    assert.equal(
      isClientFullRefund({
        cause: "CLIENT",
        depositedAt: new Date("2026-11-04T05:20:00.000Z"),
        requestedAt: new Date("2026-11-05T05:20:00.000Z"),
        installmentStatuses: ["PENDING", "PENDING"],
      }),
      true,
    );
    assert.equal(
      isClientFullRefund({
        cause: "CLIENT",
        depositedAt: new Date("2026-11-04T05:20:00.000Z"),
        requestedAt: new Date("2026-11-05T05:20:00.001Z"),
        installmentStatuses: ["PENDING"],
      }),
      false,
    );
    assert.equal(
      isClientFullRefund({
        cause: "CLIENT",
        depositedAt: new Date("2026-11-04T05:20:00.000Z"),
        requestedAt: new Date("2026-11-04T06:20:00.000Z"),
        installmentStatuses: ["DELIVERED"],
      }),
      false,
    );
  });

  it("서명에는 타 지원을 거절하지 않고 예치 완료에만 거절", () => {
    // 준비: 계약 상태·예치 상태별 입력
    // 실행 및 확인: 서명·예치 가능 조건과 완료 시 전이
    assert.equal(competingRejectOnSign(), false);
    assert.equal(canOpenDeposit("ACTIVE", "PENDING"), true);
    assert.equal(canOpenDeposit("PENDING_CONSENT", "PENDING"), false);
    assert.equal(canOpenDeposit("ACTIVE", "DEPOSITED"), false);
    assert.deepEqual(onDepositCompleted(), {
      contractStatus: "ACTIVE",
      paymentStatus: "DEPOSITED",
      depositStatus: "COMPLETED",
      rejectCompetingApplications: true,
    });
    assert.equal(blocksDepositDeadlineCancel("PENDING"), true);
    assert.equal(blocksDepositDeadlineCancel("HELD"), true);
    assert.equal(blocksDepositDeadlineCancel(null), false);
    assert.equal(approvalGate(false, true), "NOT_APPROVED");
    assert.equal(approvalGate(true, false), "HOLD_APPROVED");
    assert.equal(approvalGate(true, true), "READY_TO_RELEASE");
    assert.equal(isInspectionBasis("DECIDED"), true);
    assert.equal(isInspectionBasis("PROPOSED"), false);
    assert.equal(isInspectionBasis("UNDECIDED"), false);
  });

  it("기한은 한국 달력 23:59:59.999까지", () => {
    // 준비: 한국 시간 자정 경계가 다른 기준 시각
    const clock = fixedClock(Date.parse("2026-11-04T05:20:00.000Z"));
    const at = clock.now();
    // 확인: 고정 시계는 같은 시각을 반환
    assert.equal(at.toISOString(), "2026-11-04T05:20:00.000Z");
    assert.equal(clock.now().toISOString(), at.toISOString());
    // 실행 및 확인: 일수 더하기 결과가 KST 23:59:59.999로 고정됨
    assert.equal(endOfKstDayPlus(new Date("2026-11-03T00:00:00.000Z"), 7).toISOString(), "2026-11-10T14:59:59.999Z");
    assert.equal(endOfKstDayPlus(new Date("2026-11-04T05:20:00.000Z"), 3).toISOString(), "2026-11-07T14:59:59.999Z");
    assert.equal(endOfKstDayPlus(new Date("2026-11-03T15:30:00.000Z"), 3).toISOString(), "2026-11-07T14:59:59.999Z");
    assert.equal(endOfKstDayPlus(new Date("2026-11-04T15:00:00.000Z"), 3).toISOString(), "2026-11-08T14:59:59.999Z");
    assert.equal(endOfKstDayPlus(new Date("2026-12-12T00:00:00.000Z"), 7).toISOString(), "2026-12-19T14:59:59.999Z");
  });

  it("계약·계정·알림 포트 실패 의미", async () => {
    // 준비: 서명 완료·진행 중 계약과 계정·알림 포트
    const ports = createMemoryContractPorts([
      {
        id: "signed",
        status: "PENDING_CONSENT",
        paymentStatus: "PENDING",
        agreedAmount: 1_000_000,
        clientFee: 50_000,
        interimRatio: 50,
        durationDays: 42,
      },
      {
        id: "open",
        status: "ACTIVE",
        paymentStatus: "PENDING",
        agreedAmount: 1_000_000,
        clientFee: 50_000,
        interimRatio: 50,
        durationDays: 42,
      },
    ]);
    // 실행 및 확인: 없는 계약은 NOT_FOUND, 서명 전 계약은 CONFLICT
    await assert.rejects(() => ports.getDepositable("missing"), (error: unknown) => {
      assert.ok(error instanceof PortError);
      assert.equal(error.code, "NOT_FOUND");
      return true;
    });
    await assert.rejects(() => ports.getDepositable("signed"), (error: unknown) => {
      assert.ok(error instanceof PortError);
      assert.equal(error.code, "CONFLICT");
      return true;
    });
    const open = await ports.getDepositable("open");
    assert.equal(open.id, "open");

    // 실행 및 확인: 계좌 인증 여부와 없음(UNAVAILABLE)
    const accounts = createMemoryAccounts({ held: false, ready: true }, { held: false, ready: false });
    assert.equal(await accounts.requireVerifiedPayoutAccount("held"), false);
    assert.equal(await accounts.requireVerifiedPayoutAccount("ready"), true);
    assert.equal(await accounts.isSuspended("ready"), false);
    await assert.rejects(() => accounts.requireVerifiedPayoutAccount("missing"), (error: unknown) => {
      assert.ok(error instanceof PortError);
      assert.equal(error.code, "UNAVAILABLE");
      return true;
    });

    // 실행 및 확인: 알림은 같은 대상에 1회만 생성
    const notifications = createMemoryNotifications();
    assert.deepEqual(
      await notifications.createOnce({ userId: "u", type: "DEPOSIT_DUE", targetId: "c", targetUrl: "/a" }),
      { created: true },
    );
    assert.deepEqual(
      await notifications.createOnce({ userId: "u", type: "DEPOSIT_DUE", targetId: "c", targetUrl: "/b" }),
      { created: false },
    );
    assert.deepEqual(
      await notifications.createOnce({ userId: "u", type: "DEPOSIT_DUE", targetId: "other", targetUrl: "/a" }),
      { created: true },
    );
  });

  it("C-00-T09 예치 확정은 durationDays 누락을 42일로 채우지 않는다", async () => {
    // 준비: 기간이 없는 계약과 대기 중 예치
    const contract = depositFixture();
    delete contract.durationDays;
    const { repo, service, rejectedCount } = completionHarness(contract);
    const deposit = await repo.createDeposit({
      contractId: contract.id,
      principal: contract.agreedAmount,
      clientFee: contract.clientFee,
      amount: 1_050_000,
      method: "CARD",
      status: "PENDING",
      idempotencyKey: "c00-t09",
      pgKey: null,
      depositedAt: null,
    });

    // 실행: 예치 확정 시도
    // 확인: 기간 누락으로 거부되고 계약·예치·구간이 그대로 유지됨
    await assert.rejects(() => service.completeDeposit({ depositId: deposit.id, pgKey: "pg-t09" }), (error: unknown) => {
      assert.equal(readErrorCode(error), "MISSING_DURATION_DAYS");
      return true;
    });

    assert.equal(contract.paymentStatus, "PENDING");
    assert.equal(contract.workDueAt ?? null, null);
    assert.notEqual(contract.workDueAt?.toISOString(), endOfKstDayPlus(depositClock, 42).toISOString());
    assert.equal((await repo.listInstallments(contract.id)).length, 0);
    assert.equal(rejectedCount(), 0);
    assert.equal((await repo.findById(deposit.id))?.status, "PENDING");
  });

  it("C-00-T10 예치 확정은 interimRatio 누락을 50으로 채우지 않는다", async () => {
    // 준비: 중간 비율이 없는 계약과 대기 중 예치
    const contract = depositFixture();
    delete contract.interimRatio;
    const { repo, service, rejectedCount } = completionHarness(contract);
    const deposit = await repo.createDeposit({
      contractId: contract.id,
      principal: contract.agreedAmount,
      clientFee: contract.clientFee,
      amount: 1_050_000,
      method: "CARD",
      status: "PENDING",
      idempotencyKey: "c00-t10",
      pgKey: null,
      depositedAt: null,
    });

    // 실행: 예치 확정 시도
    // 확인: 비율 누락으로 거부되고 구간이 생성되지 않음
    await assert.rejects(() => service.completeDeposit({ depositId: deposit.id, pgKey: "pg-t10" }), (error: unknown) => {
      assert.equal(readErrorCode(error), "MISSING_INTERIM_RATIO");
      return true;
    });

    const installments = await repo.listInstallments(contract.id);
    assert.equal(installments.length, 0);
    assert.equal(contract.paymentStatus, "PENDING");
    assert.equal(rejectedCount(), 0);
  });

  it("C-00-T11 예치 가능 포트는 비어 있는 비율·기간을 기본값으로 바꾸지 않는다", async () => {
    // 준비: 기간·비율이 각각 빠진 계약과 정상 계약
    const missingDays = {
      id: "missing-days",
      status: "ACTIVE" as const,
      paymentStatus: "PENDING" as const,
      agreedAmount: 1_000_000,
      clientFee: 50_000,
      interimRatio: 40,
      durationDays: 35,
    };
    delete (missingDays as Partial<typeof missingDays>).durationDays;
    const missingRatio = {
      id: "missing-ratio",
      status: "ACTIVE" as const,
      paymentStatus: "PENDING" as const,
      agreedAmount: 1_000_000,
      clientFee: 50_000,
      interimRatio: 40,
      durationDays: 35,
    };
    delete (missingRatio as Partial<typeof missingRatio>).interimRatio;
    const ports = createMemoryContractPorts([
      missingDays,
      missingRatio,
      {
        id: "frozen",
        status: "ACTIVE",
        paymentStatus: "PENDING",
        agreedAmount: 1_000_000,
        clientFee: 50_000,
        interimRatio: 40,
        durationDays: 35,
      },
    ]);

    // 실행 및 확인: 누락 계약은 거부, 정상 계약은 계약 값 유지
    await assert.rejects(() => ports.getDepositable("missing-days"), (error: unknown) => {
      assert.equal(readErrorCode(error), "MISSING_DURATION_DAYS");
      return true;
    });
    await assert.rejects(() => ports.getDepositable("missing-ratio"), (error: unknown) => {
      assert.equal(readErrorCode(error), "MISSING_INTERIM_RATIO");
      return true;
    });
    const frozen = await ports.getDepositable("frozen");
    assert.equal(frozen.interimRatio, 40);
    assert.equal(frozen.durationDays, 35);
  });

  it("C-00-T12 계약 체결은 미정 비율만 50으로 고정하고 기간 42일을 만들지 않는다", () => {
    // 준비: 비율·기간이 비어 있거나 지정된 입력
    // 실행 및 확인: 미정 비율만 50으로 고정되고 기간 누락은 거부
    assert.deepEqual(freezeAgreementTerms({ interimRatio: undefined, durationDays: 35 }), {
      interimRatio: 50,
      durationDays: 35,
    });
    assert.deepEqual(freezeAgreementTerms({ interimRatio: null, durationDays: 35 }), {
      interimRatio: 50,
      durationDays: 35,
    });
    assert.deepEqual(freezeAgreementTerms({ interimRatio: 40, durationDays: 35 }), {
      interimRatio: 40,
      durationDays: 35,
    });
    assert.throws(() => freezeAgreementTerms({ interimRatio: undefined, durationDays: undefined }), (error: unknown) => {
      assert.equal(readErrorCode(error), "MISSING_DURATION_DAYS");
      return true;
    });
    assert.throws(() => freezeAgreementTerms({ interimRatio: undefined, durationDays: null }), (error: unknown) => {
      assert.equal(readErrorCode(error), "MISSING_DURATION_DAYS");
      return true;
    });
    assert.throws(() => freezeAgreementTerms({ interimRatio: 9, durationDays: 35 }), MoneyError);
    assert.throws(() => requireDepositContractTerms({ interimRatio: undefined, durationDays: 35 }), (error: unknown) => {
      assert.equal(readErrorCode(error), "MISSING_INTERIM_RATIO");
      return true;
    });
    assert.throws(() => requireDepositContractTerms({ interimRatio: null, durationDays: 35 }), (error: unknown) => {
      assert.equal(readErrorCode(error), "MISSING_INTERIM_RATIO");
      return true;
    });
    assert.deepEqual(requireDepositContractTerms({ interimRatio: 40, durationDays: 35 }), {
      interimRatio: 40,
      durationDays: 35,
    });
  });

  it("C-00-T13 예치 확정은 계약에 적힌 35일·40%만 사용한다", async () => {
    // 준비: 기간 35일·비율 40%의 계약과 대기 중 예치
    const contract = depositFixture();
    const { repo, service } = completionHarness(contract);
    const deposit = await repo.createDeposit({
      contractId: contract.id,
      principal: contract.agreedAmount,
      clientFee: contract.clientFee,
      amount: 1_050_000,
      method: "CARD",
      status: "PENDING",
      idempotencyKey: "c00-t13",
      pgKey: null,
      depositedAt: null,
    });
    // 실행: 예치 확정
    const result = await service.completeDeposit({ depositId: deposit.id, pgKey: "pg-t13" });
    // 확인: 계약 값 그대로 기한과 구간이 만들어진다
    assert.equal(result.contract.workDueAt?.toISOString(), endOfKstDayPlus(depositClock, 35).toISOString());
    assert.notEqual(result.contract.workDueAt?.toISOString(), endOfKstDayPlus(depositClock, 42).toISOString());
    const interim = result.installments.find((row) => row.stage === "INTERIM");
    const finalInstallment = result.installments.find((row) => row.stage === "FINAL");
    assert.equal(interim?.ratio, 40);
    assert.equal(interim?.amount, splitInstallments(1_000_000, 40).interimAmount);
    assert.equal(finalInstallment?.ratio, 60);
    assert.equal(finalInstallment?.amount, splitInstallments(1_000_000, 40).finalAmount);
  });
});
