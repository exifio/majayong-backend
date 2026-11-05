import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "../tests/test-db.ts";
import { createAppHandler } from "./composition.ts";
import { createPrismaRepositories } from "./infrastructure/prisma-store.ts";
import { createCatalogAdminPort } from "./integration/catalog-admin-port.ts";
import { AdminOpsService } from "./modules/admin-ops/index.ts";
import type { FileStorageAdapter } from "./modules/files/index.ts";
import { createNotificationBridge } from "./modules/notification/c-bridge.ts";
import { createPrismaNotificationTx } from "./modules/notification/prisma-adapter.ts";
import { createPrismaPorts } from "./integration/prisma-wiring.ts";

// G2-05: C 관리자 블록 action이 A 카탈로그 변경과 C 감사 로그를 같은 tx로 남기는지 확인한다.
// DATABASE_URL이 없으면 skip한다(전용 테스트 DB에서만 실행, 실제/공유 DB 금지).
const hasDatabase = Boolean(testDatabaseUrl());
const NOW = new Date("2026-11-04T05:20:00.000Z");
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type Ids = { adminId: string; blockId: string };

async function seed(prisma: PrismaClient): Promise<Ids> {
  const ids = { adminId: randomUUID(), blockId: randomUUID() };
  await prisma.user.create({
    data: { id: ids.adminId, email: `g205-admin-${ids.adminId}@test.local`, role: "ADMIN" },
  });
  await prisma.blockCatalog.create({
    data: {
      id: ids.blockId,
      code: `g205-${ids.blockId}`,
      name: "예약",
      functionSummary: "예약",
      description: "예약",
      industryCode: "FOOD",
      techTags: [],
      unitPrice: 1_000,
      priceBasis: "test",
    },
  });
  return ids;
}

async function cleanup(prisma: PrismaClient, ids: Ids): Promise<void> {
  await prisma.eventLog.deleteMany({ where: { userId: ids.adminId } });
  await prisma.blockCatalog.deleteMany({ where: { id: ids.blockId } });
  await prisma.user.deleteMany({ where: { id: ids.adminId } });
}

function ports(prisma: PrismaClient) {
  const prismaPorts = createPrismaPorts(prisma);
  return {
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
    catalogAdmin: createCatalogAdminPort(prisma),
  };
}

describe("INT-G2-05: 관리자 블록 action 경계", { skip: hasDatabase ? false : "DATABASE_URL 없음" }, () => {
  it("C HTTP 블록 action은 A 카탈로그 변경과 C 감사 로그를 함께 남긴다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const handler = createAppHandler(
        {
          prisma,
          webhookSecret: "unused",
          clock: { now: () => NOW },
          ports: ports(prisma),
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

      // 실행
      const response = await fetch(`http://127.0.0.1:${port}/admin/blocks/${ids.blockId}/actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": ids.adminId,
          "x-test-role": "ADMIN",
        },
        body: JSON.stringify({ action: "UPDATE_PRICE", reason: "단가 인상", unitPrice: 2_500 }),
      });
      // 확인
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { data?: { success?: boolean } }).data?.success, true);

      const block = await prisma.blockCatalog.findUniqueOrThrow({ where: { id: ids.blockId } });
      assert.equal(block.unitPrice, 2_500);

      const logs = await prisma.eventLog.findMany({
        where: { type: "BLOCK_PRICE_UPDATED" },
        orderBy: { occurredAt: "asc" },
      });
      assert.equal(logs.length, 2);
      const payloads = logs.map((log) => log.payload as Record<string, unknown>);
      assert.ok(payloads.some((payload) => payload.before === 1_000 && payload.after === 2_500));
      assert.ok(payloads.some((payload) => payload.actionType === "BLOCK_UPDATE_PRICE"));
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("감사 로그가 실패하면 카탈로그 변경도 롤백된다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const repos = createPrismaRepositories(prisma);
      const adminRepo = {
        ...repos.adminRepository,
        async recordEvent() {
          throw new Error("AUDIT_FAILED");
        },
      };
      const service = new AdminOpsService({
        repo: adminRepo,
        catalogPort: createCatalogAdminPort(prisma),
        clock: { now: () => NOW },
        transactionRunner: {
          run: (work) => prisma.$transaction((tx) => work(tx)),
        },
      });

      // 실행 및 확인
      await assert.rejects(
        () => service.executeBlockAction(
          { userId: ids.adminId, role: "ADMIN" },
          ids.blockId,
          { action: "UPDATE_PRICE", reason: "단가 인상", unitPrice: 3_000 },
        ),
        /AUDIT_FAILED/,
      );

      // 확인
      const block = await prisma.blockCatalog.findUniqueOrThrow({ where: { id: ids.blockId } });
      assert.equal(block.unitPrice, 1_000);
      assert.equal(await prisma.eventLog.count({ where: { type: "BLOCK_PRICE_UPDATED" } }), 0);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });
});
