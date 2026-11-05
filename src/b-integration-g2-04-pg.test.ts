import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  PrismaClient,
  type ApplicationStatus,
  type ContractStatus,
  type PaymentStatus,
  type ProjectStatus,
} from "@prisma/client";
import { testDatabaseUrl } from "../tests/test-db.ts";
import { createIntegrationServices } from "./composition.ts";
import { createPrismaRepositories } from "./infrastructure/prisma-store.ts";
import { createContractItemSourcePort, createIntegrationPorts } from "./integration/external-ports.ts";
import { createPrismaIntegrationDb, createPrismaPorts } from "./integration/prisma-wiring.ts";
import { acceptAgreement } from "./modules/contract/lifecycle.ts";
import { createPrismaContractUnitOfWork } from "./modules/contract/prisma-adapter.ts";
import { createPrismaApplicationReadPort } from "./modules/application/prisma-adapter.ts";
import { createAProjectViewPort } from "./integration/a-ports.ts";
import { createAProjectDb } from "./integration/prisma-wiring.ts";
import { createNotificationBridge } from "./modules/notification/c-bridge.ts";
import { createPrismaNotificationTx, type NotificationDbClient } from "./modules/notification/prisma-adapter.ts";
import { SettlementService } from "./modules/settlement/policy.ts";
import type { FileStorageAdapter } from "./modules/files/index.ts";

// G2-04: 기한 알림·검수/지급 보류·이벤트/SYSTEM 메시지를 실제 PostgreSQL로 확인한다.
// DATABASE_URL이 없으면 skip한다(전용 테스트 DB에서만 실행, 실제/공유 DB 금지).
const hasDatabase = Boolean(testDatabaseUrl());
const NOW = new Date("2026-11-04T05:20:00.000Z");
const DEPOSIT_DUE_AT = new Date("2026-11-05T05:20:00.000Z");
const WORK_DUE_AT = new Date("2026-11-05T03:20:00.000Z");
const INSPECTION_DUE_AT = new Date("2026-11-05T04:20:00.000Z");

type Ids = {
  clientId: string;
  supplierId: string;
  draftId: string;
  projectId: string;
  blockId: string;
  specItemId: string;
  applicationId: string;
  contractId: string | null;
  installmentId: string | null;
  contractItemId: string | null;
  deliveryId: string | null;
};

type SeedOptions = {
  projectStatus?: ProjectStatus;
  applicationStatus?: ApplicationStatus;
  withContract?: boolean;
  contractStatus?: ContractStatus;
  paymentStatus?: PaymentStatus;
  payoutVerifiedAt?: Date | null;
  depositDeadline?: Date | null;
  workDueAt?: Date | null;
  withInstallment?: boolean;
  withInspectionDue?: boolean;
  inspectionDueAt?: Date;
  approvedItem?: boolean;
};

async function seed(prisma: PrismaClient, options: SeedOptions = {}): Promise<Ids> {
  const ids: Ids = {
    clientId: randomUUID(),
    supplierId: randomUUID(),
    draftId: randomUUID(),
    projectId: randomUUID(),
    blockId: randomUUID(),
    specItemId: randomUUID(),
    applicationId: randomUUID(),
    contractId: null,
    installmentId: null,
    contractItemId: null,
    deliveryId: null,
  };
  await prisma.user.createMany({
    data: [
      { id: ids.clientId, email: `g204-c-${ids.clientId}@test.local`, role: "CLIENT" },
      { id: ids.supplierId, email: `g204-s-${ids.supplierId}@test.local`, role: "SUPPLIER" },
    ],
  });
  await prisma.supplierProfile.create({
    data: {
      userId: ids.supplierId,
      displayName: "공급자",
      industryCodes: [],
      skills: [],
      businessType: "BUSINESS",
      payoutVerifiedAt: options.payoutVerifiedAt === undefined ? NOW : options.payoutVerifiedAt,
    },
  });
  await prisma.blockCatalog.create({
    data: {
      id: ids.blockId,
      code: `g204-${ids.blockId}`,
      name: "예약",
      functionSummary: "예약",
      description: "예약",
      industryCode: "FOOD",
      techTags: [],
      unitPrice: 1_000,
      priceBasis: "test",
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
      status: options.projectStatus ?? "RECRUITING",
      currentVersion: 1,
    },
  });
  await prisma.specItem.create({
    data: {
      id: ids.specItemId,
      projectId: ids.projectId,
      versionNo: 1,
      blockId: ids.blockId,
      title: "예약",
      description: "예약 기능",
      origin: "FIRST_SENTENCE",
      unitPrice: 1_000,
      status: "INCLUDED",
      sortOrder: 0,
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
      status: options.applicationStatus ?? "SUBMITTED",
      items: { create: [{ specItemId: ids.specItemId, isAvailable: true }] },
    },
  });

  if (options.withContract !== false) {
    ids.contractId = randomUUID();
    ids.contractItemId = randomUUID();
    ids.installmentId = options.withInstallment === true ? randomUUID() : null;
    await prisma.contract.create({
      data: {
        id: ids.contractId,
        applicationId: ids.applicationId,
        specVersionNo: 1,
        status: options.contractStatus ?? "ACTIVE",
        agreedAmount: 3_100_000,
        durationDays: 42,
        clientFee: 155_000,
        supplierFee: 155_000,
        consentDeadline: NOW,
        contentHash: "hash-g204",
        depositDeadline: options.depositDeadline ?? null,
        workDueAt: options.workDueAt ?? null,
        paymentStatus: options.paymentStatus ?? "PENDING",
        interimRatio: 50,
      },
    });
    await prisma.contractItem.create({
      data: {
        id: ids.contractItemId,
        contractId: ids.contractId,
        blockId: ids.blockId,
        title: "예약",
        description: "예약 기능",
        origin: "AGREEMENT",
        stage: "INTERIM",
        approvedAt:
          options.approvedItem === false
            ? null
            : options.withInstallment === true && options.withInspectionDue !== true
              ? NOW
              : null,
      },
    });
    if (options.withInstallment === true) {
      await prisma.paymentInstallment.create({
        data: {
          id: ids.installmentId as string,
          contractId: ids.contractId,
          stage: "INTERIM",
          ratio: 50,
          amount: 1_550_000,
          supplierFee: 77_500,
          withholdingTax: 0,
          releaseAmount: 1_472_500,
          status: options.withInspectionDue === true ? "DELIVERED" : "PENDING",
        },
      });
      if (options.withInspectionDue === true) {
        ids.deliveryId = randomUUID();
        await prisma.delivery.create({
          data: {
            id: ids.deliveryId,
            installmentId: ids.installmentId as string,
            attemptNo: 1,
            items: [
              {
                contractItemId: ids.contractItemId,
                links: [],
                files: [],
                howToCheck: "예약 화면",
              },
            ],
            status: "SUBMITTED",
            inspectionDueAt: options.inspectionDueAt ?? INSPECTION_DUE_AT,
          },
        });
      }
    }
  }
  return ids;
}

async function cleanup(prisma: PrismaClient, ids: Ids): Promise<void> {
  const applicationIds = [ids.applicationId];
  const userIds = [ids.clientId, ids.supplierId];
  await prisma.notification.deleteMany({
    where: { OR: [{ userId: { in: userIds } }, { targetId: { in: applicationIds } }] },
  });
  await prisma.applicationMessage.deleteMany({ where: { applicationId: { in: applicationIds } } });
  await prisma.eventLog.deleteMany({
    where: { OR: [{ projectId: ids.projectId }, { userId: { in: userIds } }] },
  });
  const contracts = await prisma.contract.findMany({
    where: { applicationId: ids.applicationId },
    select: { id: true },
  });
  const contractIds = contracts.map((contract) => contract.id);
  if (ids.deliveryId !== null) {
    await prisma.delivery.deleteMany({ where: { id: ids.deliveryId } });
  }
  await prisma.paymentInstallment.deleteMany({ where: { contractId: { in: contractIds } } });
  await prisma.contractItem.deleteMany({ where: { contractId: { in: contractIds } } });
  await prisma.escrowDeposit.deleteMany({ where: { contractId: { in: contractIds } } });
  await prisma.contract.deleteMany({ where: { applicationId: ids.applicationId } });
  await prisma.applicationItem.deleteMany({ where: { applicationId: { in: applicationIds } } });
  await prisma.application.deleteMany({ where: { id: { in: applicationIds } } });
  await prisma.specItem.deleteMany({ where: { projectId: ids.projectId } });
  await prisma.project.deleteMany({ where: { id: ids.projectId } });
  await prisma.draft.deleteMany({ where: { id: ids.draftId } });
  await prisma.blockCatalog.deleteMany({ where: { id: ids.blockId } });
  await prisma.supplierProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function services(prisma: PrismaClient, ids: Ids) {
  const prismaPorts = createPrismaPorts(prisma);
  return createIntegrationServices({
    prisma,
    webhookSecret: "unused",
    clock: { now: () => NOW },
    ports: {
      marketplace: {
        async autoRejectCompetingApplications() {
          return { rejectedCount: 0 };
        },
      },
      notifications: createNotificationBridge(createPrismaNotificationTx(prismaPorts.notification), {
        now: () => NOW,
      }),
      profileReview: {
        async updateProfileReviewStats() {
          return { success: true };
        },
      },
      storage: {} as unknown as FileStorageAdapter,
      catalogAdmin: {
        async executeBlockAction(input) {
          return { success: true, blockId: input.blockId, action: input.action };
        },
      },
    },
  });
}

describe("INT-G2-04: 알림·이벤트·검수 경계", { skip: hasDatabase ? false : "DATABASE_URL 없음" }, () => {
  it("C 기한 알림은 dueAt payload로 1회만 생성된다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma, {
      depositDeadline: DEPOSIT_DUE_AT,
      workDueAt: WORK_DUE_AT,
      withInstallment: true,
      withInspectionDue: true,
    });
    try {
      const { inspections } = services(prisma, ids);
      // 실행
      await inspections.sendDueNotifications(ids.contractId as string, NOW);
      await inspections.sendDueNotifications(ids.contractId as string, NOW);

      // 확인
      const depositDue = await prisma.notification.findMany({
        where: { userId: ids.clientId, type: "DEPOSIT_DUE", targetId: ids.contractId as string },
      });
      assert.equal(depositDue.length, 1);
      assert.deepEqual(depositDue[0]?.payload, { dueAt: DEPOSIT_DUE_AT.toISOString() });

      const workDue = await prisma.notification.findMany({
        where: { userId: ids.supplierId, type: "WORK_DUE", targetId: ids.contractId as string },
      });
      assert.equal(workDue.length, 1);
      assert.deepEqual(workDue[0]?.payload, { dueAt: WORK_DUE_AT.toISOString() });

      const inspectionDue = await prisma.notification.findMany({
        where: { userId: ids.clientId, type: "INSPECTION_DUE", targetId: ids.deliveryId as string },
      });
      assert.equal(inspectionDue.length, 1);
      assert.deepEqual(inspectionDue[0]?.payload, { dueAt: INSPECTION_DUE_AT.toISOString() });
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("작업 마감이 지나면 WORK_OVERDUE를 양쪽에 1회씩 만든다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma, {
      paymentStatus: "DEPOSITED",
      workDueAt: new Date("2026-11-03T05:20:00.000Z"),
    });
    try {
      const { inspections } = services(prisma, ids);
      // 실행
      await inspections.sendDueNotifications(ids.contractId as string, NOW);
      await inspections.sendDueNotifications(ids.contractId as string, NOW);

      // 확인
      for (const userId of [ids.clientId, ids.supplierId]) {
        const rows = await prisma.notification.findMany({
          where: { userId, type: "WORK_OVERDUE", targetId: ids.contractId as string },
        });
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0]?.payload, { dueAt: "2026-11-03T05:20:00.000Z" });
      }
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("검수 미승인 항목이 남아 있으면 구간 승인을 막는다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma, {
      withInstallment: true,
      approvedItem: false,
      paymentStatus: "DEPOSITED",
    });
    try {
      const repos = createPrismaRepositories(prisma);
      const settlement = new SettlementService({
        repo: repos.settlementRepository,
        clock: { now: () => NOW },
      });
      // 실행 및 확인
      await assert.rejects(
        () => settlement.approveInstallment({
          contractId: ids.contractId as string,
          installmentId: ids.installmentId as string,
        }),
        /모든 계약 항목이 승인/,
      );
      // 확인
      const stored = await prisma.paymentInstallment.findUniqueOrThrow({
        where: { id: ids.installmentId as string },
      });
      assert.equal(stored.status, "PENDING");
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("검수 기한이 지나면 미승인 항목을 자동 승인하고 AUTO_APPROVED를 보낸다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma, {
      withInstallment: true,
      withInspectionDue: true,
      inspectionDueAt: new Date("2026-11-04T04:00:00.000Z"),
      paymentStatus: "DEPOSITED",
    });
    try {
      const { inspections } = services(prisma, ids);
      // 실행
      const result = await inspections.processAutoApproval(ids.deliveryId as string, NOW);
      // 확인
      assert.equal(result.autoApprovedCount, 1);

      assert.ok(
        (await prisma.contractItem.findUniqueOrThrow({ where: { id: ids.contractItemId as string } })).approvedAt !== null,
      );
      assert.equal(
        (await prisma.paymentInstallment.findUniqueOrThrow({ where: { id: ids.installmentId as string } })).status,
        "APPROVED",
      );
      for (const userId of [ids.clientId, ids.supplierId]) {
        assert.equal(
          await prisma.notification.count({
            where: { userId, type: "AUTO_APPROVED", targetId: ids.deliveryId as string },
          }),
          1,
        );
      }
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("취소 요청 중에는 구간 승인·지급을 막는다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma, { withInstallment: true, paymentStatus: "DEPOSITED" });
    try {
      const repos = createPrismaRepositories(prisma);
      const settlement = new SettlementService({
        repo: repos.settlementRepository,
        clock: { now: () => NOW },
      });
      await prisma.contract.update({
        where: { id: ids.contractId as string },
        data: { status: "CANCEL_REQUESTED" },
      });

      // 실행 및 확인
      await assert.rejects(
        () => settlement.approveInstallment({
          contractId: ids.contractId as string,
          installmentId: ids.installmentId as string,
        }),
        /취소 중에는/,
      );
      await assert.rejects(
        () => settlement.releaseInstallment({ installmentId: ids.installmentId as string }),
        /취소 중에는/,
      );
      // 확인
      const stored = await prisma.paymentInstallment.findUniqueOrThrow({
        where: { id: ids.installmentId as string },
      });
      assert.equal(stored.status, "PENDING");
      assert.equal(stored.releasedAt, null);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("계좌 미인증이면 승인돼도 지급하지 않고, 인증 후 지급한다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma, {
      payoutVerifiedAt: null,
      withInstallment: true,
      paymentStatus: "DEPOSITED",
    });
    try {
      const repos = createPrismaRepositories(prisma);
      const settlement = new SettlementService({
        repo: repos.settlementRepository,
        clock: { now: () => NOW },
      });
      const contractId = ids.contractId as string;
      const installmentId = ids.installmentId as string;

      // 실행
      const approved = await settlement.approveInstallment({ contractId, installmentId });
      // 확인
      assert.equal(approved.status, "APPROVED");
      assert.equal(approved.holdReason, "PAYOUT_ACCOUNT_UNVERIFIED");

      // 실행 및 확인
      await assert.rejects(
        () => settlement.releaseInstallment({ installmentId }),
        /계좌가 인증되지 않았습니다/,
      );
      // 확인
      const held = await prisma.paymentInstallment.findUniqueOrThrow({ where: { id: installmentId } });
      assert.equal(held.status, "APPROVED");
      assert.equal(held.releasedAt, null);

      // 실행
      await prisma.supplierProfile.update({ where: { userId: ids.supplierId }, data: { payoutVerifiedAt: NOW } });
      const released = await settlement.releaseInstallment({ installmentId });
      // 확인
      assert.equal(released.status, "RELEASED");
      assert.equal(released.releasedAt?.getTime(), NOW.getTime());
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("동시 상세 열람에서도 최초 열람 시각이 결정적이다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma, { withContract: false });
    try {
      const view = createAProjectViewPort(createAProjectDb(prisma));
      const earlier = new Date("2026-11-04T01:00:00.000Z");
      const later = new Date("2026-11-04T02:00:00.000Z");
      // 실행
      await Promise.all([
        view.recordFirstView({ projectId: ids.projectId, supplierId: ids.supplierId, at: later }),
        view.recordFirstView({ projectId: ids.projectId, supplierId: ids.supplierId, at: earlier }),
      ]);

      // 확인
      const rows = await prisma.eventLog.findMany({
        where: { projectId: ids.projectId, type: "SPEC_DETAIL_VIEWED", userId: ids.supplierId },
        orderBy: { occurredAt: "asc" },
      });
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.occurredAt.getTime(), earlier.getTime());
      assert.equal(rows[0]?.userId, ids.supplierId);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("기한 알림 중 하나가 실패하면 같은 계약의 알림이 모두 롤백된다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma, {
      depositDeadline: DEPOSIT_DUE_AT,
      workDueAt: WORK_DUE_AT,
    });
    try {
      const prismaPorts = createPrismaPorts(prisma);
      const realBridge = createNotificationBridge(
        createPrismaNotificationTx(prismaPorts.notification),
        {
          now: () => NOW,
          notificationTxFor: (tx) => createPrismaNotificationTx(tx as NotificationDbClient),
        },
      );
      let calls = 0;
      const { inspections } = createIntegrationServices({
        prisma,
        webhookSecret: "unused",
        clock: { now: () => NOW },
        ports: {
          marketplace: {
            async autoRejectCompetingApplications() {
              return { rejectedCount: 0 };
            },
          },
          notifications: {
            async createOnce(input, tx) {
              calls += 1;
              if (calls === 2) throw new Error("SECOND_NOTIFICATION_FAILED");
              return realBridge.createOnce(input, tx);
            },
          },
          profileReview: {
            async updateProfileReviewStats() {
              return { success: true };
            },
          },
          storage: {} as unknown as FileStorageAdapter,
          catalogAdmin: {
            async executeBlockAction(input) {
              return { success: true, blockId: input.blockId, action: input.action };
            },
          },
        },
      });

      // 실행 및 확인
      await assert.rejects(
        () => inspections.sendDueNotifications(ids.contractId as string, NOW),
        /SECOND_NOTIFICATION_FAILED/,
      );
      // 확인
      assert.equal(
        await prisma.notification.count({
          where: { userId: { in: [ids.clientId, ids.supplierId] } },
        }),
        0,
      );
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("합의 완료는 프로젝트·지원 상태·SYSTEM 메시지·알림·이벤트를 한 번에 남긴다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma, { projectStatus: "RECRUITING", applicationStatus: "SUBMITTED", withContract: false });
    try {
      const prismaPorts = createPrismaPorts(prisma);
      const application = await createPrismaApplicationReadPort(prismaPorts.applicationRead).findRevision(
        ids.applicationId,
      );
      assert.ok(application !== null);
      const sources = await createContractItemSourcePort(createPrismaIntegrationDb(prisma)).listSources(
        ids.applicationId,
      );
      const uow = createPrismaContractUnitOfWork(
        prismaPorts.contract,
        createIntegrationPorts(createPrismaIntegrationDb(prisma), { now: () => NOW }).depositAttempts,
      );

      // 실행
      const { contract } = await acceptAgreement(uow, {
        actor: { userId: ids.clientId, role: "CLIENT" },
        application,
        agreement: {
          items: [
            {
              blockId: ids.blockId,
              specItemId: ids.specItemId,
              title: "예약",
              stage: "INTERIM",
              conditions: [],
            },
          ],
          interimRatio: 50,
          ratioState: "DECIDED",
          cachedAt: NOW,
          lastMessageAt: null,
        },
        items: sources,
        now: NOW,
      });

      // 확인
      assert.equal(contract.status, "PENDING_CONSENT");
      assert.equal(
        (await prisma.project.findUniqueOrThrow({ where: { id: ids.projectId } })).status,
        "ACCEPTED",
      );
      assert.equal(
        (await prisma.application.findUniqueOrThrow({ where: { id: ids.applicationId } })).status,
        "ACCEPTED",
      );

      const systemMessage = await prisma.applicationMessage.findFirst({
        where: { applicationId: ids.applicationId, kind: "SYSTEM" },
      });
      assert.ok(systemMessage?.body.includes("임시 계약"));

      assert.equal(
        await prisma.notification.count({
          where: { userId: ids.supplierId, type: "APPLICATION_ACCEPTED", targetId: contract.id },
        }),
        1,
      );
      assert.equal(
        await prisma.eventLog.count({
          where: { userId: ids.clientId, type: "APPLICATION_ACCEPTED" },
        }),
        1,
      );
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });
});
