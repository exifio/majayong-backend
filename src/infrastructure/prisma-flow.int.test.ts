import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "../../tests/test-db.ts";
import { createPrismaRepositories } from "./prisma-store.ts";
import { CancellationService } from "../modules/cancellation/index.ts";
import { DepositCompletionService } from "../modules/deposit/index.ts";
import { DeliveryService } from "../modules/delivery/index.ts";
import { SettlementService } from "../modules/settlement/policy.ts";

const hasDatabase = Boolean(testDatabaseUrl());

describe("INT-C-02: Prisma 저장소 골든 패스", { skip: hasDatabase ? false : "DATABASE_URL 없음" }, () => {
  it("예치 확정→구간→납품→검수→지급→완료를 같은 계약으로 연결", async () => {
    // 준비: 아이디 생성
    const prisma = new PrismaClient();
    const clientId = randomUUID();
    const supplierId = randomUUID();
    const draftId = randomUUID();
    const projectId = randomUUID();
    const applicationId = randomUUID();
    const contractId = randomUUID();
    const blockId = randomUUID();
    const interimItemId = randomUUID();
    const finalItemId = randomUUID();

    try {
      // 준비: 계약·블록·항목 데이터 생성
      await prisma.user.create({ data: { id: clientId, email: `c-${clientId}@test.local`, role: "CLIENT" } });
      await prisma.user.create({ data: { id: supplierId, email: `s-${supplierId}@test.local`, role: "SUPPLIER" } });
      await prisma.supplierProfile.create({
        data: {
          userId: supplierId,
          displayName: "공급자",
          industryCodes: [],
          skills: [],
          businessType: "BUSINESS",
          payoutVerifiedAt: new Date("2026-11-01T00:00:00Z"),
        },
      });
      await prisma.draft.create({ data: { id: draftId, clientId, entryType: "SENTENCE" } });
      await prisma.project.create({
        data: {
          id: projectId,
          draftId,
          confirmedAt: new Date(),
          disclosureConsentVersion: "v1",
          title: "테스트",
          summary: "테스트",
          industryCode: "I",
          requiredSkills: [],
        },
      });
      await prisma.application.create({
        data: {
          id: applicationId,
          projectId,
          supplierId,
          specVersionNo: 1,
          totalAmount: 3_100_000,
          durationDays: 42,
          firstViewedAt: new Date(),
          status: "ACCEPTED",
        },
      });
      await prisma.contract.create({
        data: {
          id: contractId,
          applicationId,
          specVersionNo: 1,
          status: "ACTIVE",
          agreedAmount: 3_100_000,
          durationDays: 42,
          clientFee: 155_000,
          supplierFee: 155_000,
          consentDeadline: new Date(),
          contentHash: "hash",
          depositDeadline: new Date("2099-01-01T00:00:00Z"),
          interimRatio: 50,
        },
      });
      await prisma.blockCatalog.create({
        data: {
          id: blockId,
          code: `b-${blockId}`,
          name: "블록",
          functionSummary: "f",
          description: "d",
          industryCode: "I",
          techTags: [],
          unitPrice: 1_000,
          priceBasis: "b",
        },
      });
      await prisma.contractItem.createMany({
        data: [
          { id: interimItemId, contractId, blockId, title: "중간", description: "d", origin: "AGREEMENT", stage: "INTERIM" },
          { id: finalItemId, contractId, blockId, title: "최종", description: "d", origin: "AGREEMENT", stage: "FINAL" },
        ],
      });

      // 준비: 저장소·서비스 구성
      const repos = createPrismaRepositories(prisma);
      const clock = { now: () => new Date("2026-11-04T05:20:00.000Z") };
      const completion = new DepositCompletionService({
        repo: repos.depositRepository,
        contractsPort: repos.contractsPort,
        marketplacePort: {
          async autoRejectCompetingApplications() {
            return { rejectedCount: 0 };
          },
        },
        clock,
      });
      const settlement = new SettlementService({ repo: repos.settlementRepository, clock });
      const delivery = new DeliveryService({ repo: repos.deliveryRepository, settlementPort: settlement, clock });

      // 실행: 예치 생성 후 확정
      const deposit = await repos.depositRepository.createDeposit({
        contractId,
        principal: 3_100_000,
        clientFee: 155_000,
        amount: 3_255_000,
        method: "CARD",
        status: "PENDING",
        idempotencyKey: `flow-${contractId}`,
        pgKey: null,
        depositedAt: null,
      });
      await completion.completeDeposit({ depositId: deposit.id, pgKey: "pk-flow" });

      // 준비: 취소 요청 상태로 전환
      const cancellation = new CancellationService({ repo: repos.cancellationRepository, clock });
      await prisma.contract.update({
        where: { id: contractId },
        data: {
          status: "CANCEL_REQUESTED",
          cancelCause: "CLIENT",
          cancelRequestedBy: clientId,
          cancelRequestedAt: clock.now(),
          cancelNote: "D-16 regression",
        },
      });

      // 실행: 공급자 취소 합의
      const agreed = await cancellation.agreeCancellation(
        { userId: supplierId, role: "SUPPLIER" },
        { contractId },
      );
      // 확인: 합의 취소는 전액 환불
      assert.equal(agreed.status, "CANCELLED");
      assert.equal(agreed.compensationRate, null);
      assert.equal(agreed.refundAmount, 3_255_000);
      assert.equal(agreed.settledAmount, 0);
      assert.equal(agreed.clientFeeRefund, 155_000);
      const fullRefund = await prisma.contract.findUnique({ where: { id: contractId } });
      assert.equal(fullRefund?.status, "CANCELLED");
      assert.equal(fullRefund?.compensationRate, null);

      // 실행: 관리자 판정도 같은 nullable 전액 환불 표현을 쓴다.
      await prisma.contract.update({
        where: { id: contractId },
        data: {
          status: "CANCEL_REQUESTED",
          cancelResolution: null,
          cancelResolvedAt: null,
          compensationRate: null,
          refundAmount: null,
          settledAmount: null,
          clientFeeRefund: null,
          cancelEscalatedAt: clock.now(),
        },
      });
      const decided = await cancellation.decideCancellation({
        contractId,
        compensationRate: 0,
        reason: "D-16 regression",
      });
      // 확인
      assert.equal(decided.compensationRate, null);
      assert.equal(decided.refundAmount, 3_255_000);
      assert.equal(decided.settledAmount, 0);

      // 실행: 계약을 다시 진행 상태로 되돌리고 취소 필드 초기화
      await prisma.contract.update({
        where: { id: contractId },
        data: {
          status: "ACTIVE",
          cancelCause: null,
          cancelRequestedBy: null,
          cancelRequestedAt: null,
          cancelNote: null,
          cancelEscalatedAt: null,
          cancelResolution: null,
          cancelResolvedAt: null,
          compensationRate: null,
          refundAmount: null,
          settledAmount: null,
          clientFeeRefund: null,
          refundReason: null,
        },
      });

      // 실행 및 확인: 예치 확정으로 생성된 중간·최종 분할 조회
      const installments = await repos.settlementRepository.listInstallments(contractId);
      assert.equal(installments.length, 2);
      const interim = installments.find((row) => row.stage === "INTERIM")!;
      const final = installments.find((row) => row.stage === "FINAL")!;

      // 실행: 중간 구간 납품 → 검수 승인 → 지급
      const d1 = await delivery.submitDelivery(
        { userId: supplierId, role: "SUPPLIER" },
        { installmentId: interim.id, items: [{ contractItemId: interimItemId, links: [], files: [], howToCheck: "확인" }] },
      );
      await delivery.approveItem(
        { userId: clientId, role: "CLIENT" },
        { contractItemId: interimItemId, deliveryId: d1.id },
      );
      // 확인
      assert.equal((await settlement.releaseInstallment({ installmentId: interim.id })).status, "RELEASED");

      // 실행: 최종 구간 납품 → 검수 승인 → 지급
      const d2 = await delivery.submitDelivery(
        { userId: supplierId, role: "SUPPLIER" },
        { installmentId: final.id, items: [{ contractItemId: finalItemId, links: [], files: [], howToCheck: "확인" }] },
      );
      await delivery.approveItem(
        { userId: clientId, role: "CLIENT" },
        { contractItemId: finalItemId, deliveryId: d2.id },
      );
      // 확인: 두 구간 지급 후 계약 완료
      assert.equal((await settlement.releaseInstallment({ installmentId: final.id })).status, "RELEASED");
      assert.equal((await repos.settlementRepository.getContract(contractId))?.status, "COMPLETED");

      // 실행: 파일 메타데이터를 Prisma에 저장
      const file = await repos.fileRepository.saveFileMetadata({
        purpose: "SUPPORT_INQUIRY",
        inquiryId: "inquiry-1",
        uploaderId: clientId,
        objectKey: `inquiry/inquiry-1/${randomUUID()}/a.pdf`,
        fileName: "a.pdf",
        fileSize: 10,
        mimeType: "application/pdf",
      });
      // 확인: 문의 첨부 건수로 조회된다.
      assert.equal((await repos.fileRepository.getFileMetadata(file.id))?.fileSize, 10);
      assert.equal(await repos.fileRepository.countFilesInquiry("inquiry-1"), 1);
    } finally {
      await prisma.fileAttachment.deleteMany({ where: { uploaderId: clientId } });
      await prisma.inspectionRequest.deleteMany({ where: { delivery: { installment: { contractId } } } });
      await prisma.delivery.deleteMany({ where: { installment: { contractId } } });
      await prisma.paymentEvent.deleteMany({ where: { deposit: { contractId } } });
      await prisma.paymentInstallment.deleteMany({ where: { contractId } });
      await prisma.escrowDeposit.deleteMany({ where: { contractId } });
      await prisma.contractItem.deleteMany({ where: { contractId } });
      await prisma.contract.deleteMany({ where: { id: contractId } });
      await prisma.application.deleteMany({ where: { id: applicationId } });
      await prisma.project.deleteMany({ where: { id: projectId } });
      await prisma.draft.deleteMany({ where: { id: draftId } });
      await prisma.blockCatalog.deleteMany({ where: { id: blockId } });
      await prisma.supplierProfile.deleteMany({ where: { userId: supplierId } });
      await prisma.user.deleteMany({ where: { id: { in: [clientId, supplierId] } } });
      await prisma.$disconnect();
    }
  });
});
