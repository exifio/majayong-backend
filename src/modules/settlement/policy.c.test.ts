import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SettlementService,
  SettlementHttpError,
  createInMemorySettlementRepository,
  type SettlementContractInfo,
} from "./policy.ts";

describe("C-05: 지급 구간·정산 카드·세금 증빙", () => {
  const baseTime = new Date("2026-11-20T10:00:00.000Z");

  function createTestSetup(options?: { supplierKind?: "INDIVIDUAL" | "BUSINESS"; payoutVerified?: boolean }) {
    const repo = createInMemorySettlementRepository();

    const supplierKind = options?.supplierKind ?? "INDIVIDUAL";
    const payoutVerified = options?.payoutVerified ?? true;

    const contract: SettlementContractInfo = {
      id: "contract-c05",
      clientUserId: "client-c05",
      supplierUserId: "supplier-c05",
      status: "ACTIVE",
      paymentStatus: "DEPOSITED",
      agreedAmount: 3_100_000,
      clientFee: 155_000,
      totalDeposited: 3_255_000,
      interimRatio: 50,
      supplierKind,
      payoutVerifiedAt: payoutVerified ? new Date("2026-11-01T00:00:00.000Z") : null,
      payoutAccountNo: "110-123-456789", // 민감 계좌번호
    };

    const interimInstallment = {
      id: "inst-interim",
      contractId: contract.id,
      stage: "INTERIM" as const,
      ratio: 50,
      amount: 1_550_000,
      supplierFee: 77_500,
      withholdingTax: 0,
      releaseAmount: 1_472_500,
      status: "PENDING" as const,
      approvedAt: null,
      releasedAt: null,
      taxInvoiceIssuedAt: null,
    };

    const finalInstallment = {
      id: "inst-final",
      contractId: contract.id,
      stage: "FINAL" as const,
      ratio: 50,
      amount: 1_550_000,
      supplierFee: 77_500,
      withholdingTax: 0,
      releaseAmount: 1_472_500,
      status: "PENDING" as const,
      approvedAt: null,
      releasedAt: null,
      taxInvoiceIssuedAt: null,
    };

    const item1 = {
      id: "item-1",
      contractId: contract.id,
      stage: "INTERIM" as const,
      title: "기능 1",
      approvedAt: null,
    };

    const item2 = {
      id: "item-2",
      contractId: contract.id,
      stage: "INTERIM" as const,
      title: "기능 2",
      approvedAt: null,
    };

    const finalItem = {
      id: "item-final",
      contractId: contract.id,
      stage: "FINAL" as const,
      title: "최종 기능",
      approvedAt: null,
    };

    repo.seedContract(contract);
    repo.seedInstallments([interimInstallment, finalInstallment]);
    repo.seedContractItems([item1, item2, finalItem]);

    const service = new SettlementService({
      repo,
      clock: { now: () => baseTime },
    });

    return { repo, contract, interimInstallment, finalInstallment, item1, item2, finalItem, service };
  }

  it("C-05-T01 한 항목 미승인으로 부분지급 차단", async () => {
    // 준비: item1만 승인, item2는 아직 미승인
    const { service, contract, interimInstallment, item1, repo } = createTestSetup();
    await repo.updateContractItem(item1.id, { approvedAt: baseTime });

    // 실행 및 확인: 지급 승인 진입 시 미승인 항목 때문에 400으로 거부
    await assert.rejects(
      () =>
        service.approveInstallment({
          contractId: contract.id,
          installmentId: interimInstallment.id,
        }),
      (err: unknown) => {
        if (!(err instanceof SettlementHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /모든 계약 항목이 승인/);
        return true;
      },
    );
  });

  it("C-05-T01b 승인 전 구간은 지급하지 않음", async () => {
    // 준비
    const { service, interimInstallment, repo } = createTestSetup();

    // 실행 및 확인: 승인 전 구간 지급은 400으로 거부
    await assert.rejects(
      () => service.releaseInstallment({ installmentId: interimInstallment.id }),
      (err: unknown) => {
        if (!(err instanceof SettlementHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /승인 완료된 구간만/);
        return true;
      },
    );

    // 확인: 저장 상태는 PENDING 그대로
    const stored = await repo.getInstallment(interimInstallment.id);
    assert.equal(stored?.status, "PENDING");
    assert.equal(stored?.releasedAt, null);
  });

  it("C-05-T02 계좌 미인증 APPROVED 보류", async () => {
    // 준비: 계좌 미인증 상태에서 모든 항목 승인
    const { service, contract, interimInstallment, item1, item2, repo } = createTestSetup({
      payoutVerified: false,
    });
    await repo.updateContractItem(item1.id, { approvedAt: baseTime });
    await repo.updateContractItem(item2.id, { approvedAt: baseTime });

    // 실행: 지급 승인
    const result = await service.approveInstallment({
      contractId: contract.id,
      installmentId: interimInstallment.id,
    });

    // 확인: 계좌 미인증이므로 APPROVED에 머물고 지급(RELEASED)되지 않고 보류됨
    assert.equal(result.status, "APPROVED");
    assert.equal(result.releasedAt, null);
    assert.equal(result.holdReason, "PAYOUT_ACCOUNT_UNVERIFIED");

    // 실행 및 확인: 방출 시도는 400으로 거부
    await assert.rejects(
      () => service.releaseInstallment({ installmentId: interimInstallment.id }),
      (err: unknown) => {
        if (!(err instanceof SettlementHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /정산 계좌가 인증되지 않았습니다/);
        return true;
      },
    );
  });

  it("C-05-T03 개인 3.3% 소수점 원 단위 내림", async () => {
    // 준비: 개인 공급자, 계좌 인증 완료, 모든 항목 승인
    const { service, contract, interimInstallment, item1, item2, repo } = createTestSetup({
      supplierKind: "INDIVIDUAL",
      payoutVerified: true,
    });
    await repo.updateContractItem(item1.id, { approvedAt: baseTime });
    await repo.updateContractItem(item2.id, { approvedAt: baseTime });

    // 실행: 승인 후 지급
    await service.approveInstallment({
      contractId: contract.id,
      installmentId: interimInstallment.id,
    });
    const released = await service.releaseInstallment({ installmentId: interimInstallment.id });

    // 확인: 1,550,000원 -> 수수료 77,500원(5%), 원천징수 51,150원(3.3%), 실수령 1,421,350원
    assert.equal(released.status, "RELEASED");
    assert.ok(released.releasedAt);
    assert.equal(released.amount, 1_550_000);
    assert.equal(released.supplierFee, 77_500);
    assert.equal(released.withholdingTax, 51_150);
    assert.equal(released.releaseAmount, 1_421_350);
  });

  it("C-05-T04 사업자 원천징수는 0원", async () => {
    // 준비: 사업자 공급자, 계좌 인증 완료, 모든 항목 승인
    const { service, contract, interimInstallment, item1, item2, repo } = createTestSetup({
      supplierKind: "BUSINESS",
      payoutVerified: true,
    });
    await repo.updateContractItem(item1.id, { approvedAt: baseTime });
    await repo.updateContractItem(item2.id, { approvedAt: baseTime });

    // 실행: 승인 후 지급
    await service.approveInstallment({
      contractId: contract.id,
      installmentId: interimInstallment.id,
    });
    const released = await service.releaseInstallment({ installmentId: interimInstallment.id });

    // 확인: 사업자는 원천징수 없이 5% 수수료만 차감
    assert.equal(released.status, "RELEASED");
    assert.equal(released.withholdingTax, 0);
    assert.equal(released.releaseAmount, 1_472_500);
  });

  it("C-05-T04b 사업자 공급자의 세금계산서 발행 표시", async () => {
    // 준비: 사업자 공급자, 계좌 인증 완료, 모든 항목 승인
    const { service, contract, interimInstallment, item1, item2, repo } = createTestSetup({
      supplierKind: "BUSINESS",
      payoutVerified: true,
    });
    await repo.updateContractItem(item1.id, { approvedAt: baseTime });
    await repo.updateContractItem(item2.id, { approvedAt: baseTime });
    await service.approveInstallment({
      contractId: contract.id,
      installmentId: interimInstallment.id,
    });
    await service.releaseInstallment({ installmentId: interimInstallment.id });

    // 실행: 공급자가 '세금계산서 발행했어요' 표시
    const marked = await service.markTaxInvoiceIssued(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      { installmentId: interimInstallment.id },
    );

    // 확인: 발행 시각 기록
    assert.ok(marked.taxInvoiceIssuedAt);
  });

  it("C-05-T05 구간 합계/끝수 정확", async () => {
    // 준비: 개인 공급자, 계좌 인증 완료
    const { service, contract, interimInstallment, finalInstallment, item1, item2, finalItem, repo } = createTestSetup({
      supplierKind: "INDIVIDUAL",
      payoutVerified: true,
    });

    // 실행: 1구간 승인 및 방출
    await repo.updateContractItem(item1.id, { approvedAt: baseTime });
    await repo.updateContractItem(item2.id, { approvedAt: baseTime });
    await service.approveInstallment({ contractId: contract.id, installmentId: interimInstallment.id });
    const r1 = await service.releaseInstallment({ installmentId: interimInstallment.id });

    // 실행: 2구간(FINAL) 승인 및 방출
    await repo.updateContractItem(finalItem.id, { approvedAt: baseTime });
    await service.approveInstallment({ contractId: contract.id, installmentId: finalInstallment.id });
    const r2 = await service.releaseInstallment({ installmentId: finalInstallment.id });

    // 확인: 구간 합계 검증
    assert.equal(r1.amount + r2.amount, contract.agreedAmount);
    assert.equal(r1.supplierFee + r2.supplierFee, 155_000);
    assert.equal(r1.withholdingTax + r2.withholdingTax, 102_300);
    assert.equal(r1.releaseAmount + r2.releaseAmount, 2_842_700);

    // 확인: 두 구간 모두 방출 시 계약은 COMPLETED 상태 전이
    const updatedContract = await repo.getContract(contract.id);
    assert.equal(updatedContract?.paymentStatus, "RELEASED");
    assert.equal(updatedContract?.status, "COMPLETED");
  });

  it("C-05-T06 순서 어긋난 최종 구간 지급 금지", async () => {
    // 준비: 최종 항목만 승인, 중간 구간은 아직 RELEASED 아님
    const { service, contract, finalInstallment, finalItem, repo } = createTestSetup();
    await repo.updateContractItem(finalItem.id, { approvedAt: baseTime });

    // 실행 및 확인: FINAL 구간 지급 승인은 400으로 거부
    await assert.rejects(
      () =>
        service.approveInstallment({
          contractId: contract.id,
          installmentId: finalInstallment.id,
        }),
      (err: unknown) => {
        if (!(err instanceof SettlementHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /중간 구간이 먼저 지급되어야 합니다/);
        return true;
      },
    );
  });

  it("C-05-T07 타인 정산 조회 거부", async () => {
    // 준비
    const { service, contract } = createTestSetup();

    // 실행 및 확인: 타인이 정산 카드 조회 시 403으로 거부
    await assert.rejects(
      () =>
        service.getContractStatement(
          { userId: "alien-user", role: "CLIENT" },
          contract.id,
        ),
      (err: unknown) => {
        if (!(err instanceof SettlementHttpError)) return false;
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  it("C-05-T07b 계좌번호 원문은 정산 카드에 노출되지 않음", async () => {
    // 준비
    const { service, contract } = createTestSetup();

    // 실행: 의뢰인이 정산 카드 조회
    const clientView = await service.getContractStatement(
      { userId: contract.clientUserId, role: "CLIENT" },
      contract.id,
    );
    // 확인: 상대방 계좌번호 원문이 노출되지 않음
    assert.equal("payoutAccountNo" in clientView, false);
    assert.ok("totalDeposited" in clientView);
    assert.equal(clientView.totalDeposited, 3_255_000);

    // 실행: 공급자가 정산 카드 조회
    const supplierView = await service.getContractStatement(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      contract.id,
    );
    // 확인: 본인 조회에서도 계좌번호는 마스킹되거나 비공개
    assert.equal("payoutAccountNo" in supplierView, false);
  });

  it("C-05-T08 실제 금융이체 네트워크 호출 0", async () => {
    // 준비: 외부 네트워크 호출을 감시하는 fetch 대체
    const { service, contract, interimInstallment, item1, item2, repo } = createTestSetup({
      supplierKind: "INDIVIDUAL",
      payoutVerified: true,
    });

    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      calls.push(String(input));
      return Promise.reject(new Error("REAL_BANK_TRANSFER_BLOCKED"));
    };

    try {
      await repo.updateContractItem(item1.id, { approvedAt: baseTime });
      await repo.updateContractItem(item2.id, { approvedAt: baseTime });

      // 실행: 승인 후 지급
      await service.approveInstallment({
        contractId: contract.id,
        installmentId: interimInstallment.id,
      });

      const released = await service.releaseInstallment({ installmentId: interimInstallment.id });
      // 확인: 지급은 성공하지만 실제 외부 금융 이체 네트워크 호출은 0건
      assert.equal(released.status, "RELEASED");
      assert.equal(calls.length, 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  async function approveAllInterimItem(
    repo: ReturnType<typeof createInMemorySettlementRepository>,
    item1: { id: string },
    item2: { id: string },
  ) {
    await repo.updateContractItem(item1.id, { approvedAt: baseTime });
    await repo.updateContractItem(item2.id, { approvedAt: baseTime });
  }

  it("C-05-F01 취소 요청 중 승인·지급은 실제 호출에서 차단됨", async () => {
    // 준비: 모든 항목 승인 후 취소 요청 상태로 변경
    const { service, contract, interimInstallment, item1, item2, repo } = createTestSetup();
    await approveAllInterimItem(repo, item1, item2);
    repo.seedContract({ ...contract, status: "CANCEL_REQUESTED" });

    // 실행 및 확인: 지급 승인은 409로 거부되고 구간은 PENDING 유지
    await assert.rejects(
      () =>
        service.approveInstallment({
          contractId: contract.id,
          installmentId: interimInstallment.id,
        }),
      (err: unknown) => err instanceof SettlementHttpError && err.status === 409,
    );
    assert.equal((await repo.getInstallment(interimInstallment.id))?.status, "PENDING");

    // 준비: 구간을 APPROVED 상태로 만든 뒤
    repo.seedInstallments([{ ...interimInstallment, status: "APPROVED" }]);
    // 실행 및 확인: 지급도 409로 거부되고 해제 시각은 비어 있음
    await assert.rejects(
      () => service.releaseInstallment({ installmentId: interimInstallment.id }),
      (err: unknown) => err instanceof SettlementHttpError && err.status === 409,
    );
    const stored = await repo.getInstallment(interimInstallment.id);
    assert.equal(stored?.status, "APPROVED");
    assert.equal(stored?.releasedAt, null);
  });

  it("C-05-F02 RELEASED는 되돌아가지 않음", async () => {
    // 준비: 모든 항목 승인 후 1구간 지급 완료
    const { service, contract, interimInstallment, item1, item2, repo } = createTestSetup();
    await approveAllInterimItem(repo, item1, item2);
    await service.approveInstallment({ contractId: contract.id, installmentId: interimInstallment.id });
    const released = await service.releaseInstallment({ installmentId: interimInstallment.id });

    // 실행: 이미 지급된 구간을 다시 승인
    const reApproved = await service.approveInstallment({
      contractId: contract.id,
      installmentId: interimInstallment.id,
    });
    // 확인: 상태와 해제 시각이 그대로 유지됨
    assert.equal(reApproved.status, "RELEASED");
    assert.equal(reApproved.releasedAt?.toISOString(), released.releasedAt?.toISOString());

    // 실행 및 확인: 이미 지급된 구간의 재지급은 거부
    await assert.rejects(
      () => service.releaseInstallment({ installmentId: interimInstallment.id }),
      (err: unknown) => err instanceof SettlementHttpError,
    );
    const after = await repo.getInstallment(interimInstallment.id);
    assert.equal(after?.status, "RELEASED");
    assert.equal(after?.releasedAt?.toISOString(), released.releasedAt?.toISOString());
  });

  it("C-05-F02b 최종 구간 지급은 중간 지급을 강제", async () => {
    // 준비: 최종 항목 승인, 최종 구간을 APPROVED로 만든 상태
    const fresh = createTestSetup();
    await fresh.repo.updateContractItem(fresh.finalItem.id, { approvedAt: baseTime });
    fresh.repo.seedInstallments([{ ...fresh.finalInstallment, status: "APPROVED" }]);

    // 실행 및 확인: 중간 구간 미지급 상태에서 최종 구간 release는 거부
    await assert.rejects(
      () => fresh.service.releaseInstallment({ installmentId: fresh.finalInstallment.id }),
      (err: unknown) => err instanceof SettlementHttpError && /중간 구간/.test(err.message),
    );
    // 확인: 최종 구간은 APPROVED로 유지
    assert.equal((await fresh.repo.getInstallment(fresh.finalInstallment.id))?.status, "APPROVED");
  });

  it("C-05-F03 미지급 구간 예상 실수령액에 수수료·원천징수 반영", async () => {
    // 준비: 개인 공급자 계약
    const individual = createTestSetup({ supplierKind: "INDIVIDUAL" });

    // 실행: 공급자가 정산 카드 조회
    const individualView = await individual.service.getContractStatement(
      { userId: individual.contract.supplierUserId, role: "SUPPLIER" },
      individual.contract.id,
    );
    // 확인: 1,421,350 × 2구간 (지급 전에도 동일 정책)
    assert.ok("expectedToReceive" in individualView);
    assert.equal(individualView.expectedToReceive, 2_842_700);

    // 준비: 사업자 공급자 계약
    const business = createTestSetup({ supplierKind: "BUSINESS" });
    // 실행: 공급자가 정산 카드 조회
    const businessView = await business.service.getContractStatement(
      { userId: business.contract.supplierUserId, role: "SUPPLIER" },
      business.contract.id,
    );
    // 확인: 사업자는 원천징수 없이 5% 수수료만 반영
    assert.ok("expectedToReceive" in businessView);
    assert.equal(businessView.expectedToReceive, 2_945_000);
  });

  it("C-05-F04 정산 조회 서비스·시뮬레이션 표기·권한", async () => {
    // 준비: 사업자 공급자 계약
    const { service, contract } = createTestSetup({
      supplierKind: "BUSINESS",
    });

    // 실행: 의뢰인의 지급 내역 조회
    const statements = await service.getMyPaymentStatements({
      userId: contract.clientUserId,
      role: "CLIENT",
    });
    // 확인: 시뮬레이션 표기, 이체 안내, 계좌번호 원문 미노출
    assert.equal(statements.simulated, true);
    assert.match(statements.transferNote, /이체/);
    assert.equal(statements.statements.length, 1);
    assert.equal(JSON.stringify(statements).includes("110-123-456789"), false);

    // 실행: 의뢰인의 구간 목록 조회
    const installments = await service.listInstallments(
      { userId: contract.clientUserId, role: "CLIENT" },
      contract.id,
    );
    // 확인: 시뮬레이션 표기와 구간 2건, 계좌번호 원문 미노출
    assert.equal(installments.simulated, true);
    assert.equal(installments.installments.length, 2);
    assert.equal(JSON.stringify(installments).includes("110-123-456789"), false);

    // 실행 및 확인: 외부인은 403, 내역이 없는 사용자는 빈 목록
    await assert.rejects(
      () => service.listInstallments({ userId: "outsider", role: "CLIENT" }, contract.id),
      (err: unknown) => err instanceof SettlementHttpError && err.status === 403,
    );
    const empty = await service.getMyPaymentStatements({ userId: "outsider", role: "CLIENT" });
    assert.equal(empty.statements.length, 0);
  });

  it("C-05-F04b 세금계산서 발행 표시는 승인 상태에서만 가능", async () => {
    // 준비: 사업자 공급자 계약, 구간은 아직 PENDING
    const { service, contract, interimInstallment, item1, item2, repo } = createTestSetup({
      supplierKind: "BUSINESS",
    });

    // 실행 및 확인: 승인 전(PENDING)에는 409로 거부되고 발행 시각이 남지 않음
    await assert.rejects(
      () =>
        service.markTaxInvoiceIssued(
          { userId: contract.supplierUserId, role: "SUPPLIER" },
          { installmentId: interimInstallment.id },
        ),
      (err: unknown) => err instanceof SettlementHttpError && err.status === 409,
    );
    assert.equal((await repo.getInstallment(interimInstallment.id))?.taxInvoiceIssuedAt, null);

    // 실행: 모든 항목 승인 후 구간 승인, 발행 표시
    await approveAllInterimItem(repo, item1, item2);
    await service.approveInstallment({ contractId: contract.id, installmentId: interimInstallment.id });
    const marked = await service.markTaxInvoiceIssued(
      { userId: contract.supplierUserId, role: "SUPPLIER" },
      { installmentId: interimInstallment.id },
    );
    // 확인: 발행 시각 기록
    assert.ok(marked.taxInvoiceIssuedAt);
  });

  it("C-05-F05 계좌 인증 후 보류 구간 재개는 안전하고 멱등", async () => {
    // 준비: 계좌 미인증 상태에서 모든 항목 승인 후 승인 요청
    const { service, contract, interimInstallment, item1, item2, repo } = createTestSetup({
      payoutVerified: false,
    });
    await approveAllInterimItem(repo, item1, item2);
    const held = await service.approveInstallment({
      contractId: contract.id,
      installmentId: interimInstallment.id,
    });
    // 확인: 계좌 미인증으로 보류
    assert.equal(held.holdReason, "PAYOUT_ACCOUNT_UNVERIFIED");

    // 실행 및 확인: 인증 전에는 재개 0
    assert.equal((await service.resumeHeldInstallments(contract.id)).resumed, 0);

    // 실행: 계좌 인증 후 재개
    await repo.updateContract(contract.id, { payoutVerifiedAt: baseTime });
    const resumed = await service.resumeHeldInstallments(contract.id);
    // 확인: 보류 구간 1건이 승인 상태로 재개되고 사유가 사라짐
    assert.equal(resumed.resumed, 1);
    const after = await repo.getInstallment(interimInstallment.id);
    assert.equal(after?.status, "APPROVED");
    assert.equal(after?.holdReason, null);

    // 실행 및 확인: 중복 트리거에도 추가 변경 없음
    assert.equal((await service.resumeHeldInstallments(contract.id)).resumed, 0);

    // 실행: 재개된 구간 지급
    const released = await service.releaseInstallment({ installmentId: interimInstallment.id });
    // 확인: 지급 성공, 재지급은 거부
    assert.equal(released.status, "RELEASED");
    await assert.rejects(
      () => service.releaseInstallment({ installmentId: interimInstallment.id }),
      (err: unknown) => err instanceof SettlementHttpError,
    );

    // 준비: 취소 요청 중인 별도 계약
    const cancelled = createTestSetup({ payoutVerified: false });
    await approveAllInterimItem(cancelled.repo, cancelled.item1, cancelled.item2);
    await cancelled.service.approveInstallment({
      contractId: cancelled.contract.id,
      installmentId: cancelled.interimInstallment.id,
    });
    await cancelled.repo.updateContract(cancelled.contract.id, { payoutVerifiedAt: baseTime });
    cancelled.repo.seedContract({ ...cancelled.contract, status: "CANCEL_REQUESTED" });

    // 실행 및 확인: 취소 중에는 재개하지 않고 보류 사유가 유지됨
    assert.equal((await cancelled.service.resumeHeldInstallments(cancelled.contract.id)).resumed, 0);
    assert.equal(
      (await cancelled.repo.getInstallment(cancelled.interimInstallment.id))?.holdReason,
      "PAYOUT_ACCOUNT_UNVERIFIED",
    );
  });
});
