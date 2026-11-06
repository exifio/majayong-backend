import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "../../tests/test-db.ts";
import { createPrismaRepositories } from "../infrastructure/prisma-store.ts";
import { createPrismaDueJobTargets } from "../infrastructure/prisma-due-targets.ts";
import { DepositCompletionService } from "../modules/deposit/index.ts";
import { DeliveryService, InspectionBatchService } from "../modules/delivery/index.ts";
import { CancellationService } from "../modules/cancellation/index.ts";
import { runProjectDeadlineBatch } from "../modules/project/service.ts";
import { breakExpiredContracts } from "../modules/contract/lifecycle.ts";
import { createPrismaContractUnitOfWork } from "../modules/contract/prisma-adapter.ts";
import { createPrismaPorts } from "../integration/prisma-wiring.ts";
import { createDueJobRunner } from "./index.ts";

const hasDatabase = Boolean(testDatabaseUrl());

describe("INT-C-04: Prisma 기한 대상·배치", { skip: hasDatabase ? false : "DATABASE_URL 없음" }, () => {
  it("DB 대상 조회와 예치·취소·자동승인·알림 실행", async () => {
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
    const pendingDepositId = randomUUID();
    const now = new Date("2026-11-04T05:20:00.000Z");
    const depositRecoveryCutoff = new Date(now.getTime() - 15 * 60 * 1000);

    try {
      // 준비: 계약·블록·항목 데이터 생성
      await prisma.user.create({ data: { id: clientId, email: `c-${clientId}@t.local`, role: "CLIENT" } });
      await prisma.user.create({ data: { id: supplierId, email: `s-${supplierId}@t.local`, role: "SUPPLIER" } });
      await prisma.supplierProfile.create({ data: { userId: supplierId, displayName: "공급자", industryCodes: [], skills: [], payoutVerifiedAt: now } });
      await prisma.draft.create({ data: { id: draftId, clientId, entryType: "SENTENCE" } });
      await prisma.project.create({ data: { id: projectId, draftId, confirmedAt: now, disclosureConsentVersion: "v1", title: "t", summary: "s", industryCode: "I", requiredSkills: [] } });
      await prisma.application.create({ data: { id: applicationId, projectId, supplierId, specVersionNo: 1, totalAmount: 3_100_000, durationDays: 42, firstViewedAt: now, status: "ACCEPTED" } });
      await prisma.contract.create({
        data: {
          id: contractId,
          applicationId,
          specVersionNo: 1,
          status: "ACTIVE",
          paymentStatus: "PENDING",
          agreedAmount: 3_100_000,
          durationDays: 42,
          clientFee: 155_000,
          supplierFee: 155_000,
          consentDeadline: now,
          contentHash: "h",
          depositDeadline: new Date(now.getTime() - 60_000),
          workDueAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
          interimRatio: 50,
        },
      });
      await prisma.blockCatalog.create({ data: { id: blockId, code: `b-${blockId}`, name: "블록", functionSummary: "f", description: "d", industryCode: "I", techTags: [], unitPrice: 1_000, priceBasis: "b" } });
      await prisma.contractItem.create({ data: { id: interimItemId, contractId, blockId, title: "중간", description: "d", origin: "AGREEMENT", stage: "INTERIM" } });

      // 준비: 서비스·대상 어댑터 구성
      const repos = createPrismaRepositories(prisma);
      const clock = { now: () => now };
      const completion = new DepositCompletionService({
        repo: repos.depositRepository,
        contractsPort: repos.contractsPort,
        marketplacePort: { async autoRejectCompetingApplications() { return { rejectedCount: 0 }; } },
        clock,
      });
      const cancellation = new CancellationService({ repo: repos.cancellationRepository, clock });
      const notifications: Array<{ userId: string; type: string }> = [];
      const batch = new InspectionBatchService({
        repo: repos.deliveryRepository,
        notificationPorts: {
          async createOnce(input) {
            notifications.push({ userId: input.userId, type: input.type });
            return { created: true };
          },
        },
        clock,
      });
      const targets = createPrismaDueJobTargets(prisma);

      // 실행 및 확인: 기한 대상 조회
      assert.ok((await targets.depositContractIds!(now)).includes(contractId));
      assert.ok((await targets.notificationContractIds!(now)).includes(contractId));

      // 실행 및 확인: 예치 기한 경과 + 입금 시도 없음 → 계약 결렬
      assert.equal((await completion.expireDepositIfDue(contractId, now)).expired, true);
      assert.equal((await repos.settlementRepository.getContract(contractId))?.status, "CANCELLED");

      // 실행: 취소 3일 무응답 → 운영자 대기
      await prisma.contract.update({
        where: { id: contractId },
        data: {
          status: "CANCEL_REQUESTED",
          paymentStatus: "PENDING",
          cancelRequestedAt: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000),
          cancelCause: "CLIENT",
          cancelRequestedBy: clientId,
          cancelNote: "취소",
          cancelResolvedAt: null,
          cancelEscalatedAt: null,
        },
      });
      // 확인
      assert.ok((await targets.cancellationContractIds!(now)).includes(contractId));
      assert.equal((await cancellation.checkCancellationDeadlines(contractId, now)).escalatedToAdmin, true);

      // 실행: 자동 승인 대상 생성 — 활성 계약 + 기한 지난 최신 납품
      await prisma.contract.update({ where: { id: contractId }, data: { status: "ACTIVE" } });
      const interim = await prisma.paymentInstallment.create({
        data: { contractId, stage: "INTERIM", ratio: 50, amount: 1_550_000, supplierFee: 77_500, releaseAmount: 1_472_500, status: "DELIVERED" },
      });
      const delivery = await prisma.delivery.create({
        data: {
          installmentId: interim.id,
          attemptNo: 1,
          items: [{ contractItemId: interimItemId, links: [], files: [], howToCheck: "확인" }],
          status: "SUBMITTED",
          submittedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
          inspectionDueAt: new Date(now.getTime() - 1000),
        },
      });
      assert.ok((await targets.deliveryIds!(now)).includes(delivery.id));
      assert.equal((await batch.processAutoApproval(delivery.id, now)).autoApprovedCount, 1);

      // 실행: 기한 안내 발송 — 작업 마감 12시간 전 공급자에게 1회
      await batch.sendDueNotifications(contractId, now);
      // 확인
      assert.equal(notifications.filter((row) => row.type === "WORK_DUE").length, 1);
      // 준비: 15분 경계의 PENDING 주문
      await prisma.escrowDeposit.create({
        data: {
          id: pendingDepositId,
          contractId,
          principal: 3_100_000,
          clientFee: 155_000,
          amount: 3_255_000,
          idempotencyKey: `due-recovery-${pendingDepositId}`,
          status: "PENDING",
          createdAt: depositRecoveryCutoff,
        },
      });
      // 확인: 경계 시각은 포함된다
      assert.equal(
        (await targets.pendingDepositIds!(depositRecoveryCutoff)).includes(pendingDepositId),
        true,
      );
      // 실행: 주문 생성 시각이 경계 뒤면 대상에서 제외된다
      await prisma.escrowDeposit.update({
        where: { id: pendingDepositId },
        data: { createdAt: new Date(depositRecoveryCutoff.getTime() + 1) },
      });
      assert.equal(
        (await targets.pendingDepositIds!(depositRecoveryCutoff)).includes(pendingDepositId),
        false,
      );
      // 실행: 경계 안이어도 완료한 주문은 대상에서 제외된다
      await prisma.escrowDeposit.update({
        where: { id: pendingDepositId },
        data: { createdAt: depositRecoveryCutoff, status: "COMPLETED" },
      });
      assert.equal(
        (await targets.pendingDepositIds!(depositRecoveryCutoff)).includes(pendingDepositId),
        false,
      );
    } finally {
      await prisma.inspectionRequest.deleteMany({ where: { delivery: { installment: { contractId } } } });
      await prisma.delivery.deleteMany({ where: { installment: { contractId } } });
      await prisma.paymentInstallment.deleteMany({ where: { contractId } });
      await prisma.contractItem.deleteMany({ where: { contractId } });
      await prisma.escrowDeposit.deleteMany({ where: { contractId } });
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

  it("모집 마감·서명 기한 배치를 연결하고 두 워커가 동시에 돌아도 한 번만 반영한다", async () => {
    // 준비: 아이디 생성
    const prisma = new PrismaClient();
    const clientId = randomUUID();
    const supplierId = randomUUID();
    const now = new Date("2026-11-04T05:20:00.000Z");
    const draftId = randomUUID();
    const closedDraftId = randomUUID();
    const contractedDraftId = randomUUID();
    const scheduledProjectId = randomUUID();
    const closedProjectId = randomUUID();
    const contractedProjectId = randomUUID();
    const applicationId = randomUUID();
    const contractId = randomUUID();

    try {
      // 준비: 프로젝트·지원·계약 데이터 생성
      await prisma.user.create({ data: { id: clientId, email: `pj-${clientId}@t.local`, role: "CLIENT" } });
      await prisma.user.create({ data: { id: supplierId, email: `ps-${supplierId}@t.local`, role: "SUPPLIER" } });
      await prisma.supplierProfile.create({ data: { userId: supplierId, displayName: "공급자", industryCodes: [], skills: [], payoutVerifiedAt: now } });
      await prisma.draft.create({ data: { id: draftId, clientId, entryType: "SENTENCE" } });
      await prisma.draft.create({ data: { id: closedDraftId, clientId, entryType: "SENTENCE" } });
      await prisma.draft.create({ data: { id: contractedDraftId, clientId, entryType: "SENTENCE" } });
      await prisma.project.create({
        data: {
          id: scheduledProjectId, draftId, confirmedAt: now, disclosureConsentVersion: "v1",
          title: "모집 예정", summary: "s", industryCode: "I", requiredSkills: [],
          status: "SCHEDULED",
          recruitStartAt: new Date(now.getTime() - 60_000),
          deadline: new Date(now.getTime() + 86_400_000),
        },
      });
      await prisma.project.create({
        data: {
          id: closedProjectId, draftId: closedDraftId, confirmedAt: now, disclosureConsentVersion: "v1",
          title: "모집 마감", summary: "s", industryCode: "I", requiredSkills: [],
          status: "RECRUITING",
          recruitStartAt: new Date(now.getTime() - 172_800_000),
          deadline: new Date(now.getTime() - 60_000),
        },
      });
      await prisma.project.create({
        data: {
          id: contractedProjectId, draftId: contractedDraftId, confirmedAt: now, disclosureConsentVersion: "v1",
          title: "계약 진행", summary: "s", industryCode: "I", requiredSkills: [],
          status: "ACCEPTED",
          recruitStartAt: new Date(now.getTime() - 172_800_000),
          deadline: new Date(now.getTime() + 604_800_000),
        },
      });
      await prisma.application.create({
        data: {
          id: applicationId, projectId: contractedProjectId, supplierId, specVersionNo: 1,
          totalAmount: 1_000_000, durationDays: 7, firstViewedAt: now, status: "ACCEPTED",
        },
      });
      await prisma.contract.create({
        data: {
          id: contractId, applicationId, specVersionNo: 1, status: "PENDING_CONSENT",
          agreedAmount: 1_000_000, durationDays: 7, clientFee: 50_000, supplierFee: 50_000,
          consentDeadline: new Date(now.getTime() - 60_000), contentHash: "h", interimRatio: 50,
        },
      });

      // 준비: 계약 단위작업 구성
      const contractUow = createPrismaContractUnitOfWork(
        createPrismaPorts(prisma).contract,
        { hasDepositAttempt: async () => false },
      );

      // 실행: 두 워커가 같은 시각에 프로젝트 마감 배치 실행
      const projectRuns = await Promise.all([
        runProjectDeadlineBatch(prisma, {}, now),
        runProjectDeadlineBatch(prisma, {}, now),
      ]);
      const projectActions = projectRuns.reduce((sum, row) => sum + row.recruiting + row.selecting + row.expired, 0);
      // 확인: 프로젝트 전이는 2건만 반영된다.
      assert.equal(projectActions, 2);

      // 실행: 두 워커가 같은 시각에 계약 결렬 배치 실행
      const breakRuns = await Promise.all([
        breakExpiredContracts(contractUow, { now }),
        breakExpiredContracts(contractUow, { now }),
      ]);
      // 확인: 계약 결렬은 1건만 반영된다.
      assert.equal(breakRuns[0] + breakRuns[1], 1);

      // 확인: 최종 상태
      assert.equal((await prisma.project.findUnique({ where: { id: scheduledProjectId } }))?.status, "RECRUITING");
      assert.equal((await prisma.project.findUnique({ where: { id: closedProjectId } }))?.status, "EXPIRED");
      assert.equal((await prisma.contract.findUnique({ where: { id: contractId } }))?.status, "CANCELLED");

      // 준비: 통합 러너 구성
      const runner = createDueJobRunner({
        services: {
          projectDeadlines: (at) => runProjectDeadlineBatch(prisma, {}, at),
          contractBreaks: (at) => breakExpiredContracts(contractUow, { now: at }),
        },
        targets: {},
        retries: 0,
        clock: { now: () => now },
      });

      // 실행: 통합 러너 1회 실행
      const result = await runner.runOnce();
      // 확인: 두 배치를 실제로 호출한다.
      assert.equal(result.success, true);
      assert.equal(result.failures.length, 0);
    } finally {
      await prisma.notification.deleteMany({ where: { userId: { in: [clientId, supplierId] } } });
      await prisma.eventLog.deleteMany({ where: { userId: { in: [clientId, supplierId] } } });
      await prisma.contract.deleteMany({ where: { id: contractId } });
      await prisma.application.deleteMany({ where: { id: applicationId } });
      await prisma.project.deleteMany({ where: { id: { in: [scheduledProjectId, closedProjectId, contractedProjectId] } } });
      await prisma.draft.deleteMany({ where: { id: { in: [draftId, closedDraftId, contractedDraftId] } } });
      await prisma.supplierProfile.deleteMany({ where: { userId: supplierId } });
      await prisma.user.deleteMany({ where: { id: { in: [clientId, supplierId] } } });
      await prisma.$disconnect();
    }
  });
});
