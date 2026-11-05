import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "../../../tests/test-db.ts";
import { createPrismaRepositories } from "../../infrastructure/prisma-store.ts";
import { createPrismaPorts } from "../../integration/prisma-wiring.ts";
import { DepositCompletionService } from "./index.ts";
import { createMarketplaceAutoRejectPort } from "../application/marketplace-port.ts";
import {
  createApplicationTx,
  createPrismaApplicationUnitOfWork,
  type ApplicationDbClient,
} from "../application/prisma-adapter.ts";

// G2-03: 실제 PostgreSQL에서 예치 확정과 자동 거절이 같은 DB 트랜잭션에 묶이는지 확인한다.
// DATABASE_URL이 없으면 skip한다(전용 테스트 DB에서만 실행, 실제/공유 DB 금지).
const hasDatabase = Boolean(testDatabaseUrl());
const CLOCK = { now: () => new Date("2026-11-04T05:20:00.000Z") };

type Ids = {
  clientId: string;
  acceptedSupplierId: string;
  rivalSupplierId: string;
  draftId: string;
  projectId: string;
  acceptedApplicationId: string;
  rivalApplicationId: string;
  contractId: string;
  blockId: string;
};

async function seed(prisma: PrismaClient): Promise<Ids> {
  const ids: Ids = {
    clientId: randomUUID(),
    acceptedSupplierId: randomUUID(),
    rivalSupplierId: randomUUID(),
    draftId: randomUUID(),
    projectId: randomUUID(),
    acceptedApplicationId: randomUUID(),
    rivalApplicationId: randomUUID(),
    contractId: randomUUID(),
    blockId: randomUUID(),
  };
  await prisma.user.createMany({
    data: [
      { id: ids.clientId, email: `c-${ids.clientId}@test.local`, role: "CLIENT" },
      { id: ids.acceptedSupplierId, email: `s1-${ids.acceptedSupplierId}@test.local`, role: "SUPPLIER" },
      { id: ids.rivalSupplierId, email: `s2-${ids.rivalSupplierId}@test.local`, role: "SUPPLIER" },
    ],
  });
  await prisma.supplierProfile.createMany({
    data: [
      { userId: ids.acceptedSupplierId, displayName: "수락 공급자", industryCodes: [], skills: [], businessType: "BUSINESS", payoutVerifiedAt: new Date("2026-11-01T00:00:00Z") },
      { userId: ids.rivalSupplierId, displayName: "경쟁 공급자", industryCodes: [], skills: [], businessType: "BUSINESS", payoutVerifiedAt: new Date("2026-11-01T00:00:00Z") },
    ],
  });
  await prisma.draft.create({ data: { id: ids.draftId, clientId: ids.clientId, entryType: "SENTENCE" } });
  await prisma.project.create({
    data: {
      id: ids.projectId,
      draftId: ids.draftId,
      confirmedAt: new Date(),
      disclosureConsentVersion: "v1",
      title: "원자성",
      summary: "원자성",
      industryCode: "I",
      requiredSkills: [],
      status: "RECRUITING",
    },
  });
  await prisma.application.createMany({
    data: [
      {
        id: ids.acceptedApplicationId,
        projectId: ids.projectId,
        supplierId: ids.acceptedSupplierId,
        specVersionNo: 1,
        totalAmount: 3_100_000,
        durationDays: 42,
        firstViewedAt: new Date(),
        status: "ACCEPTED",
      },
      {
        id: ids.rivalApplicationId,
        projectId: ids.projectId,
        supplierId: ids.rivalSupplierId,
        specVersionNo: 1,
        totalAmount: 3_000_000,
        durationDays: 40,
        firstViewedAt: new Date(),
        status: "SUBMITTED",
      },
    ],
  });
  await prisma.contract.create({
    data: {
      id: ids.contractId,
      applicationId: ids.acceptedApplicationId,
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
      id: ids.blockId,
      code: `b-${ids.blockId}`,
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
      { contractId: ids.contractId, blockId: ids.blockId, title: "중간", description: "d", origin: "AGREEMENT", stage: "INTERIM" },
      { contractId: ids.contractId, blockId: ids.blockId, title: "최종", description: "d", origin: "AGREEMENT", stage: "FINAL" },
    ],
  });
  return ids;
}

async function cleanup(prisma: PrismaClient, ids: Ids): Promise<void> {
  await prisma.notification.deleteMany({
    where: {
      OR: [
        { userId: { in: [ids.clientId, ids.acceptedSupplierId, ids.rivalSupplierId] } },
        { targetId: { in: [ids.acceptedApplicationId, ids.rivalApplicationId] } },
      ],
    },
  });
  await prisma.paymentEvent.deleteMany({ where: { deposit: { contractId: ids.contractId } } });
  await prisma.paymentInstallment.deleteMany({ where: { contractId: ids.contractId } });
  await prisma.escrowDeposit.deleteMany({ where: { contractId: ids.contractId } });
  await prisma.contractItem.deleteMany({ where: { contractId: ids.contractId } });
  await prisma.contract.deleteMany({ where: { id: ids.contractId } });
  await prisma.application.deleteMany({ where: { projectId: ids.projectId } });
  await prisma.project.deleteMany({ where: { id: ids.projectId } });
  await prisma.draft.deleteMany({ where: { id: ids.draftId } });
  await prisma.blockCatalog.deleteMany({ where: { id: ids.blockId } });
  await prisma.supplierProfile.deleteMany({ where: { userId: { in: [ids.acceptedSupplierId, ids.rivalSupplierId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.clientId, ids.acceptedSupplierId, ids.rivalSupplierId] } } });
}

function integratedMarketplace(prisma: PrismaClient) {
  return createMarketplaceAutoRejectPort(
    createPrismaApplicationUnitOfWork(createPrismaPorts(prisma).application),
    (tx) => createApplicationTx(tx as ApplicationDbClient),
  );
}

describe("INT-G2-03: 예치 확정 자동 거절 원자성", { skip: hasDatabase ? false : "DATABASE_URL 없음" }, () => {
  it("예치 완료가 B 자동 거절을 같은 DB 트랜잭션에서 확정한다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const repos = createPrismaRepositories(prisma);
      const marketplace = integratedMarketplace(prisma);
      let runnerTx: unknown;
      let marketplaceTx: unknown;
      const completion = new DepositCompletionService({
        repo: repos.depositRepository,
        contractsPort: repos.contractsPort,
        marketplacePort: {
          async autoRejectCompetingApplications(input, tx) {
            marketplaceTx = tx;
            return marketplace.autoRejectCompetingApplications(input, tx);
          },
        },
        transactionRunner: {
          run: (work) =>
            prisma.$transaction((tx) => {
              runnerTx = tx;
              return work(tx as never);
            }),
        },
        clock: CLOCK,
      });

      const deposit = await repos.depositRepository.createDeposit({
        contractId: ids.contractId,
        principal: 3_100_000,
        clientFee: 155_000,
        amount: 3_255_000,
        method: "CARD",
        status: "PENDING",
        idempotencyKey: `g203-ok-${ids.contractId}`,
        pgKey: null,
        depositedAt: null,
      });

      await completion.completeDeposit({ depositId: deposit.id, pgKey: "pk-g203" });

      // 확인
      assert.equal((await prisma.application.findUnique({ where: { id: ids.acceptedApplicationId } }))?.status, "ACCEPTED");
      assert.equal((await prisma.application.findUnique({ where: { id: ids.rivalApplicationId } }))?.status, "AUTO_REJECTED");
      assert.equal(runnerTx, marketplaceTx, "자동 거절이 예치 트랜잭션 밖에서 실행됨");
      assert.equal((await repos.depositRepository.findById(deposit.id))?.status, "COMPLETED");
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("자동 거절 후 예치 확정이 실패하면 자동 거절도 함께 롤백된다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const repos = createPrismaRepositories(prisma);
      const realMarketplace = integratedMarketplace(prisma);
      // 자동 거절은 실제 통합 포트가 수행하고, 그 직후 실패시켜 예치 트랜잭션 전체를 되돌린다.
      const completion = new DepositCompletionService({
        repo: repos.depositRepository,
        contractsPort: repos.contractsPort,
        marketplacePort: {
          async autoRejectCompetingApplications(input, tx) {
            await realMarketplace.autoRejectCompetingApplications(input, tx);
            throw new Error("AFTER_REJECT");
          },
        },
        transactionRunner: { run: (work) => prisma.$transaction((tx) => work(tx as never)) },
        clock: CLOCK,
      });

      const deposit = await repos.depositRepository.createDeposit({
        contractId: ids.contractId,
        principal: 3_100_000,
        clientFee: 155_000,
        amount: 3_255_000,
        method: "CARD",
        status: "PENDING",
        idempotencyKey: `g203-rb-${ids.contractId}`,
        pgKey: null,
        depositedAt: null,
      });

      // 실행 및 확인
      await assert.rejects(
        () => completion.completeDeposit({ depositId: deposit.id, pgKey: "pk-rb" }),
        /AFTER_REJECT/,
      );

      // 확인
      // 자동 거절이 별도 트랜잭션이었다면 여기서 커밋되어 SUBMITTED로 남지 않는다.
      assert.equal((await prisma.application.findUnique({ where: { id: ids.rivalApplicationId } }))?.status, "SUBMITTED");
      assert.equal((await prisma.escrowDeposit.findUnique({ where: { id: deposit.id } }))?.status, "PENDING");
      assert.equal((await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } })), 0);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });
});
