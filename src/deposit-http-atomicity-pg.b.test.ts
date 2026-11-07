import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "../tests/test-db.ts";
import { createAppHandler } from "./composition.ts";
import { createPrismaRepositories } from "./infrastructure/prisma-store.ts";
import { createIntegrationPorts } from "./integration/external-ports.ts";
import { createPrismaContractUnitOfWork } from "./modules/contract/prisma-adapter.ts";
import { signContract } from "./modules/contract/lifecycle.ts";
import { DepositCompletionService } from "./modules/deposit/index.ts";
import { createPrismaIntegrationDb, createPrismaPorts } from "./integration/prisma-wiring.ts";
import {
  createApplicationTx,
  createPrismaApplicationUnitOfWork,
  type ApplicationDbClient,
} from "./modules/application/prisma-adapter.ts";
import { createMarketplaceAutoRejectPort } from "./modules/application/marketplace-port.ts";
import type { FileStorageAdapter } from "./modules/files/index.ts";
import { createNotificationBridge } from "./modules/notification/c-bridge.ts";
import { createPrismaNotificationTx } from "./modules/notification/prisma-adapter.ts";

// G2-03: C HTTP 웹훅 → 예치 확정 → B 자동 거절·알림이 한 PostgreSQL 트랜잭션인지 확인한다.
// DATABASE_URL이 없으면 skip한다(전용 테스트 DB에서만 실행, 실제/공유 DB 금지).
const hasDatabase = Boolean(testDatabaseUrl());
const WEBHOOK_SECRET = "0123456789abcdef".repeat(4);
const NOW = new Date("2026-11-04T05:20:00.000Z");
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type Ids = {
  clientId: string;
  supplierAId: string;
  supplierBId: string;
  draftId: string;
  projectId: string;
  acceptedApplicationId: string;
  rivalApplicationId: string;
  contractId: string;
};

async function seed(prisma: PrismaClient): Promise<Ids> {
  const ids: Ids = {
    clientId: randomUUID(),
    supplierAId: randomUUID(),
    supplierBId: randomUUID(),
    draftId: randomUUID(),
    projectId: randomUUID(),
    acceptedApplicationId: randomUUID(),
    rivalApplicationId: randomUUID(),
    contractId: randomUUID(),
  };
  await prisma.user.createMany({
    data: [
      { id: ids.clientId, email: `g203-c-${ids.clientId}@test.local`, role: "CLIENT" },
      { id: ids.supplierAId, email: `g203-a-${ids.supplierAId}@test.local`, role: "SUPPLIER" },
      { id: ids.supplierBId, email: `g203-b-${ids.supplierBId}@test.local`, role: "SUPPLIER" },
    ],
  });
  await prisma.supplierProfile.createMany({
    data: [
      { userId: ids.supplierAId, displayName: "수락 공급자", industryCodes: [], skills: [] },
      { userId: ids.supplierBId, displayName: "경쟁 공급자", industryCodes: [], skills: [] },
    ],
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
      status: "RECRUITING",
    },
  });
  await prisma.application.createMany({
    data: [
      {
        id: ids.acceptedApplicationId,
        projectId: ids.projectId,
        supplierId: ids.supplierAId,
        specVersionNo: 1,
        totalAmount: 3_100_000,
        durationDays: 42,
        firstViewedAt: NOW,
        status: "ACCEPTED",
      },
      {
        id: ids.rivalApplicationId,
        projectId: ids.projectId,
        supplierId: ids.supplierBId,
        specVersionNo: 1,
        totalAmount: 3_000_000,
        durationDays: 40,
        firstViewedAt: NOW,
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
      consentDeadline: NOW,
      contentHash: "hash-g203",
      depositDeadline: new Date("2026-11-07T14:59:59.000Z"),
      interimRatio: 50,
    },
  });
  return ids;
}

async function cleanup(prisma: PrismaClient, ids: Ids): Promise<void> {
  const applicationIds = [ids.acceptedApplicationId, ids.rivalApplicationId];
  const userIds = [ids.clientId, ids.supplierAId, ids.supplierBId];
  await prisma.notification.deleteMany({
    where: { OR: [{ userId: { in: userIds } }, { targetId: { in: applicationIds } }] },
  });
  await prisma.paymentEvent.deleteMany({ where: { deposit: { contractId: ids.contractId } } });
  await prisma.paymentInstallment.deleteMany({ where: { contractId: ids.contractId } });
  await prisma.escrowDeposit.deleteMany({ where: { contractId: ids.contractId } });
  await prisma.contract.deleteMany({ where: { id: ids.contractId } });
  await prisma.application.deleteMany({ where: { id: { in: applicationIds } } });
  await prisma.project.deleteMany({ where: { id: ids.projectId } });
  await prisma.draft.deleteMany({ where: { id: ids.draftId } });
  await prisma.supplierProfile.deleteMany({ where: { userId: { in: [ids.supplierAId, ids.supplierBId] } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

type VerifyResult = (input: { orderId: string; paymentKey: string; amount: number }) => unknown;

async function start(
  prisma: PrismaClient,
  ids: Ids,
  options: { verify?: VerifyResult; now?: Date } = {},
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const prismaPorts = createPrismaPorts(prisma);
  const handler = createAppHandler(
    {
      prisma,
      webhookSecret: WEBHOOK_SECRET,
      clock: { now: () => options.now ?? NOW },
      ports: {
        marketplace: createMarketplaceAutoRejectPort(
          createPrismaApplicationUnitOfWork(prismaPorts.application),
          (tx) => createApplicationTx(tx as ApplicationDbClient),
        ),
        notifications: createNotificationBridge(
          createPrismaNotificationTx(prismaPorts.notification),
          { now: () => options.now ?? NOW },
        ),
        profileReview: {
          async updateProfileReviewStats() {
            return { success: true };
          },
        },
        storage: {
          async createUploadUrl() {
            throw new Error("STORAGE_UNUSED");
          },
          async createDownloadUrl() {
            throw new Error("STORAGE_UNUSED");
          },
        } as unknown as FileStorageAdapter,
        catalogAdmin: {
          async executeBlockAction(input) {
            return { success: true, blockId: input.blockId, action: input.action };
          },
        },
        tossVerifier: {
          async verifyPayment(orderId, paymentKey, amount) {
            if (options.verify === undefined) return { verified: true, orderId, paymentKey, amount, status: "DONE" };
            const result = options.verify({ orderId, paymentKey, amount });
            return result === undefined
              ? { verified: true, orderId, paymentKey, amount, status: "DONE" }
              : result;
          },
          async confirmPayment(orderId, paymentKey, amount) {
            if (options.verify === undefined) return { verified: true, orderId, paymentKey, amount, status: "DONE" };
            const result = options.verify({ orderId, paymentKey, amount });
            return result === undefined
              ? { verified: true, orderId, paymentKey, amount, status: "DONE" }
              : result;
          },
        },
      },
    },
    (req) => {
      const userId = req.headers["x-test-user"];
      const role = req.headers["x-test-role"];
      if (typeof userId !== "string" || typeof role !== "string") return null;
      return { userId, role: role as "CLIENT" | "SUPPLIER" | "ADMIN" };
    },
  );

  const server = createServer((req, res) => {
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function postRaw(
  url: string,
  rawBody: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
}

function tossWebhookHeaders(rawBody: string): Record<string, string> {
  const transmissionTime = NOW.toISOString();
  const signature = createHmac("sha256", Buffer.from(WEBHOOK_SECRET, "hex"))
    .update(rawBody)
    .update(":")
    .update(transmissionTime)
    .digest("base64");
  return {
    "tosspayments-webhook-signature": `v1:${signature}`,
    "tosspayments-webhook-transmission-time": transmissionTime,
  };
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const rawBody = JSON.stringify(body) ?? "null";
  return postRaw(url, rawBody, headers);
}

async function openDeposit(
  baseUrl: string,
  ids: Ids,
  amount = 3_255_000,
  idempotencyKey = `idem-${randomUUID()}`,
): Promise<{ depositId: string; status: number }> {
  const created = await post(
    `${baseUrl}/contracts/${ids.contractId}/deposits`,
    { idempotencyKey, method: "CARD", amount },
    { "x-test-user": ids.clientId, "x-test-role": "CLIENT" },
  );
  const depositId = (created.body as { data?: { deposit?: { id?: string } } } | null)?.data?.deposit?.id;
  assert.equal(created.status, 201);
  assert.equal(typeof depositId, "string");
  return { depositId: depositId as string, status: created.status };
}

function confirmDeposit(
  baseUrl: string,
  contractId: string,
  depositId: string,
  overrides: Partial<{ paymentKey: string; amount: number }> = {},
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return post(
    `${baseUrl}/contracts/${contractId}/deposits/${depositId}/confirm`,
    {
      paymentKey: overrides.paymentKey ?? "pk-confirm-http",
      amount: overrides.amount ?? 3_255_000,
    },
    headers,
  );
}

function webhook(
  baseUrl: string,
  depositId: string,
  overrides: Partial<{ paymentKey: string; amount: number; status: string; transactionKey: string }> = {},
): Promise<{ status: number; body: unknown }> {
  const payload = {
    orderId: depositId,
    paymentKey: overrides.paymentKey ?? "pk-g203",
    amount: overrides.amount ?? 3_255_000,
    status: overrides.status ?? "DONE",
    transactionKey: overrides.transactionKey ?? `tx-${randomUUID()}`,
  };
  const rawBody = JSON.stringify(payload) ?? "null";
  return postRaw(
    `${baseUrl}/integrations/toss/payment-events`,
    rawBody,
    tossWebhookHeaders(rawBody),
  );
}

describe("INT-G2-03: C HTTP 예치 확정 원자성", { skip: hasDatabase ? false : "DATABASE_URL 없음" }, () => {
  it("검증된 웹훅은 예치·계약·2구간·자동 거절·알림을 한 트랜잭션으로 저장한다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    const running = await start(prisma, ids);
    try {
      // 실행
      const { depositId } = await openDeposit(running.baseUrl, ids);
      const result = await webhook(running.baseUrl, depositId, { transactionKey: "tx-success" });
      // 확인
      assert.equal(result.status, 200);
      assert.equal((result.body as { status?: string }).status, "COMPLETED");

      const deposit = await prisma.escrowDeposit.findUniqueOrThrow({ where: { id: depositId } });
      assert.equal(deposit.status, "COMPLETED");
      assert.equal(deposit.pgKey, "pk-g203");

      const contract = await prisma.contract.findUniqueOrThrow({ where: { id: ids.contractId } });
      assert.equal(contract.paymentStatus, "DEPOSITED");
      assert.equal(contract.totalDeposited, 3_255_000);
      assert.ok(contract.workDueAt !== null);

      const installments = await prisma.paymentInstallment.findMany({
        where: { contractId: ids.contractId },
        orderBy: { stage: "asc" },
      });
      assert.deepEqual(
        installments.map((row) => row.stage),
        ["INTERIM", "FINAL"],
      );
      assert.equal(installments.reduce((sum, row) => sum + row.amount, 0), 3_100_000);
      assert.equal(installments.every((row) => row.ratio === 50), true);

      assert.equal(
        (await prisma.application.findUniqueOrThrow({ where: { id: ids.rivalApplicationId } })).status,
        "AUTO_REJECTED",
      );
      assert.equal(
        await prisma.notification.count({
          where: {
            userId: ids.supplierBId,
            type: "APPLICATION_AUTO_REJECTED",
            targetId: ids.rivalApplicationId,
          },
        }),
        1,
      );
      assert.equal(
        await prisma.paymentEvent.count({ where: { depositId, eventType: "VERIFIED" } }),
        1,
      );
    } finally {
      await running.close();
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("중복 콜백은 추가 구간·이벤트 없이 멱등 반환한다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    const running = await start(prisma, ids);
    try {
      const { depositId } = await openDeposit(running.baseUrl, ids);
      // 실행 및 확인
      assert.equal((await webhook(running.baseUrl, depositId, { transactionKey: "tx-duplicate" })).status, 200);
      // 실행
      const again = await webhook(running.baseUrl, depositId, { transactionKey: "tx-duplicate" });
      // 확인
      assert.equal(again.status, 200);
      assert.equal((again.body as { isDuplicate?: boolean }).isDuplicate, true);
      assert.equal(await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } }), 2);
      assert.equal(await prisma.paymentEvent.count({ where: { depositId, eventType: "VERIFIED" } }), 1);
    } finally {
      await running.close();
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("Toss 원형 PAYMENT_STATUS_CHANGED도 같은 예치 확정을 만든다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    const running = await start(prisma, ids);
    try {
      const { depositId } = await openDeposit(running.baseUrl, ids);

      // 실행: 내부 평면 형식이 아닌 Toss 원형 eventType/data 본문
      const event = {
        eventType: "PAYMENT_STATUS_CHANGED",
        createdAt: new Date().toISOString(),
        data: {
          orderId: depositId,
          paymentKey: "pk-raw-http",
          totalAmount: 3_255_000,
          status: "DONE",
        },
      };
      const rawBody = JSON.stringify(event) ?? "null";
      const result = await postRaw(
        `${running.baseUrl}/integrations/toss/payment-events`,
        rawBody,
        tossWebhookHeaders(rawBody),
      );

      // 확인: 예치·계약만 완료되고 구간은 2개다
      assert.equal(result.status, 200);
      assert.equal((result.body as { status?: string }).status, "COMPLETED");
      const deposit = await prisma.escrowDeposit.findUniqueOrThrow({ where: { id: depositId } });
      assert.equal(deposit.status, "COMPLETED");
      assert.equal(deposit.pgKey, "pk-raw-http");
      assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: ids.contractId } })).paymentStatus, "DEPOSITED");
      assert.equal(await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } }), 2);
    } finally {
      await running.close();
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("사용자 confirm은 소유자·금액을 검사하고 PG 승인 후 한 번만 완료한다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    const running = await start(prisma, ids);
    const clientHeaders = { "x-test-user": ids.clientId, "x-test-role": "CLIENT" };
    try {
      const { depositId } = await openDeposit(running.baseUrl, ids);

      // 실행 및 확인: 계약 소유자가 아니면 403
      const forbidden = await confirmDeposit(
        running.baseUrl,
        ids.contractId,
        depositId,
        {},
        { "x-test-user": ids.supplierBId, "x-test-role": "CLIENT" },
      );
      assert.equal(forbidden.status, 403);

      // 실행 및 확인: 저장된 금액과 다르면 400
      const mismatch = await confirmDeposit(
        running.baseUrl,
        ids.contractId,
        depositId,
        { amount: 1 },
        clientHeaders,
      );
      assert.equal(mismatch.status, 400);

      // 실행 및 확인: 다른 예치 건은 404
      const missing = await confirmDeposit(
        running.baseUrl,
        ids.contractId,
        randomUUID(),
        {},
        clientHeaders,
      );
      assert.equal(missing.status, 404);

      // 실행: 의뢰인이 Toss 승인 확인
      const confirmed = await confirmDeposit(running.baseUrl, ids.contractId, depositId, {}, clientHeaders);

      // 확인: 예치·계약·2구간이 확정된다
      assert.equal(confirmed.status, 200);
      assert.equal(
        (confirmed.body as { data?: { deposit?: { status?: string } } }).data?.deposit?.status,
        "COMPLETED",
      );
      const deposit = await prisma.escrowDeposit.findUniqueOrThrow({ where: { id: depositId } });
      assert.equal(deposit.status, "COMPLETED");
      assert.equal(deposit.pgKey, "pk-confirm-http");
      assert.equal(
        (await prisma.contract.findUniqueOrThrow({ where: { id: ids.contractId } })).paymentStatus,
        "DEPOSITED",
      );
      assert.equal(await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } }), 2);

      // 실행 및 확인: 같은 승인 재요청은 멱등이다
      const again = await confirmDeposit(running.baseUrl, ids.contractId, depositId, {}, clientHeaders);
      assert.equal(again.status, 200);
      assert.equal(await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } }), 2);
    } finally {
      await running.close();
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("동시 콜백은 구간·VERIFIED 이벤트를 한 번만 만든다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    const running = await start(prisma, ids);
    try {
      const { depositId } = await openDeposit(running.baseUrl, ids);
      // 실행
      const [first, second] = await Promise.all([
        webhook(running.baseUrl, depositId, { transactionKey: "tx-concurrent" }),
        webhook(running.baseUrl, depositId, { transactionKey: "tx-concurrent" }),
      ]);
      // 확인
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } }), 2);
      assert.equal(await prisma.paymentEvent.count({ where: { depositId, eventType: "VERIFIED" } }), 1);
      assert.equal(
        await prisma.notification.count({
          where: { userId: ids.supplierBId, type: "APPLICATION_AUTO_REJECTED", targetId: ids.rivalApplicationId },
        }),
        1,
      );
    } finally {
      await running.close();
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("예치 완료와 기한 만료가 겹쳐도 완료된 계약을 취소하지 않는다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const repos = createPrismaRepositories(prisma);
      const stale = await repos.contractsPort.getContract(ids.contractId);
      assert.ok(stale !== null);

      await prisma.escrowDeposit.create({
        data: {
          contractId: ids.contractId,
          principal: 3_100_000,
          clientFee: 155_000,
          amount: 3_255_000,
          method: "CARD",
          status: "COMPLETED",
          idempotencyKey: `idem-race-${randomUUID()}`,
          pgKey: "pk-race",
          depositedAt: NOW,
        },
      });
      await prisma.contract.update({
        where: { id: ids.contractId },
        data: { paymentStatus: "DEPOSITED", totalDeposited: 3_255_000 },
      });

      const service = new DepositCompletionService({
        repo: repos.depositRepository,
        // 예치 완료 직전에 읽은 PENDING 스냅샷을 그대로 들고 있는 경합 상황을 재현한다.
        contractsPort: {
          async getContract() {
            return stale;
          },
          async updateContract(id, patch) {
            return repos.contractsPort.updateContract(id, patch);
          },
          async cancelIfUnpaid(id) {
            return repos.contractsPort.cancelIfUnpaid(id);
          },
        },
        marketplacePort: {
          async autoRejectCompetingApplications() {
            return { rejectedCount: 0 };
          },
        },
        clock: { now: () => new Date("2026-11-08T00:00:00.000Z") },
      });

      // 실행
      const result = await service.expireDepositIfDue(ids.contractId, new Date("2026-11-08T00:00:00.000Z"));
      // 확인
      assert.equal(result.expired, false);
      const contract = await prisma.contract.findUniqueOrThrow({ where: { id: ids.contractId } });
      assert.equal(contract.status, "ACTIVE");
      assert.equal(contract.paymentStatus, "DEPOSITED");
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("계약 서명은 타 지원을 자동 거절하지 않는다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      await prisma.contract.update({
        where: { id: ids.contractId },
        data: {
          status: "PENDING_CONSENT",
          consentDeadline: new Date("2026-11-11T00:00:00.000Z"),
          paymentStatus: "PENDING",
        },
      });
      await prisma.project.update({ where: { id: ids.projectId }, data: { status: "ACCEPTED" } });

      const prismaPorts = createPrismaPorts(prisma);
      const uow = createPrismaContractUnitOfWork(
        prismaPorts.contract,
        createIntegrationPorts(createPrismaIntegrationDb(prisma), { now: () => NOW }).depositAttempts,
      );
      // 실행
      await signContract(uow, {
        contractId: ids.contractId,
        actor: { userId: ids.clientId, role: "CLIENT" },
        expectedContentHash: "hash-g203",
        now: NOW,
      });
      const signed = await signContract(uow, {
        contractId: ids.contractId,
        actor: { userId: ids.supplierAId, role: "SUPPLIER" },
        expectedContentHash: "hash-g203",
        now: NOW,
      });

      // 확인
      assert.equal(signed.activated, true);
      assert.equal(
        (await prisma.project.findUniqueOrThrow({ where: { id: ids.projectId } })).status,
        "CONTRACTED",
      );
      assert.equal(
        (await prisma.application.findUniqueOrThrow({ where: { id: ids.rivalApplicationId } })).status,
        "SUBMITTED",
      );
      assert.equal(
        await prisma.notification.count({
          where: { type: "APPLICATION_AUTO_REJECTED", targetId: ids.rivalApplicationId },
        }),
        0,
      );
      assert.equal(await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } }), 0);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("서명 누락은 PG 재조회 후 완료하고 금액 불일치·기한 경과는 격리한다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    const unsignedIds = await seed(prisma);
    try {
      // 실행
      const forged = await start(prisma, unsignedIds);
      try {
        const { depositId } = await openDeposit(forged.baseUrl, unsignedIds);
        const unsigned = await post(
          `${forged.baseUrl}/integrations/toss/payment-events`,
          { orderId: depositId, paymentKey: "pk", amount: 3_255_000, status: "DONE" },
        );
        // 확인
        assert.equal(unsigned.status, 200);
        assert.equal(
          (await prisma.escrowDeposit.findUniqueOrThrow({ where: { id: depositId } })).status,
          "COMPLETED",
        );
      } finally {
        await forged.close();
        await cleanup(prisma, unsignedIds);
      }

      // 실행
      const mismatch = await start(prisma, ids, { now: new Date("2026-11-05T00:00:00.000Z") });
      try {
        const { depositId } = await openDeposit(mismatch.baseUrl, ids);
        const result = await webhook(mismatch.baseUrl, depositId, { amount: 1_000 });
        // 확인
        assert.equal(result.status, 200);
        assert.equal((result.body as { status?: string }).status, "HELD");
        assert.equal(
          (await prisma.escrowDeposit.findUniqueOrThrow({ where: { id: depositId } })).status,
          "HELD",
        );
        assert.equal(await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } }), 0);
        assert.equal(
          await prisma.paymentEvent.count({ where: { depositId, eventType: "AMOUNT_MISMATCH" } }),
          1,
        );
      } finally {
        await mismatch.close();
      }
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("PG 재조회가 거부하면 완료하지 않는다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    const rejected = await start(prisma, ids, {
      verify: ({ orderId, paymentKey, amount }) => ({
        verified: false,
        orderId,
        paymentKey,
        amount,
        status: "DONE",
      }),
    });
    try {
      const { depositId } = await openDeposit(rejected.baseUrl, ids);
      // 실행
      const result = await webhook(rejected.baseUrl, depositId);
      // 확인
      assert.equal((result.body as { status?: string }).status, "HELD");
      assert.equal(
        await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } }),
        0,
      );
    } finally {
      await rejected.close();
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("PG 재조회가 일시 실패하면 503과 PENDING을 유지해 Toss 재전송을 기다린다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    const unavailable = await start(prisma, ids, {
      verify() {
        throw new Error("PG_NETWORK_TIMEOUT");
      },
    });
    try {
      const { depositId } = await openDeposit(unavailable.baseUrl, ids);

      // 실행 및 확인: PG 오류를 성공이나 HELD로 삼키지 않아 webhook 재전송이 가능하다
      const result = await webhook(unavailable.baseUrl, depositId);
      assert.equal(result.status, 503);
      assert.equal(
        (await prisma.escrowDeposit.findUniqueOrThrow({ where: { id: depositId } })).status,
        "PENDING",
      );
      assert.equal(await prisma.paymentEvent.count({ where: { depositId } }), 0);
      assert.equal(await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } }), 0);
    } finally {
      await unavailable.close();
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("예치 기한이 지난 콜백은 HELD로 격리하고 완료하지 않는다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    const late = await start(prisma, ids, { now: new Date("2026-11-08T00:00:00.000Z") });
    try {
      const pending = await prisma.escrowDeposit.create({
        data: {
          contractId: ids.contractId,
          principal: 3_100_000,
          clientFee: 155_000,
          amount: 3_255_000,
          method: "CARD",
          status: "PENDING",
          idempotencyKey: `idem-late-${randomUUID()}`,
        },
      });
      const result = await webhook(late.baseUrl, pending.id);
      // 확인
      assert.equal((result.body as { status?: string }).status, "HELD");
      assert.equal(
        (await prisma.escrowDeposit.findUniqueOrThrow({ where: { id: pending.id } })).status,
        "HELD",
      );
      assert.equal(await prisma.paymentInstallment.count({ where: { contractId: ids.contractId } }), 0);
    } finally {
      await late.close();
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });
});
