import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "../tests/test-db.ts";
import { createAppHandler } from "./composition.ts";
import { createCatalogAdminPort } from "./integration/catalog-admin-port.ts";
import { createPrismaPorts } from "./integration/prisma-wiring.ts";
import type { FileStorageAdapter } from "./modules/files/index.ts";
import { createNotificationBridge } from "./modules/notification/c-bridge.ts";
import { createPrismaNotificationTx } from "./modules/notification/prisma-adapter.ts";

// G2-05: 파일 presign 권한과 문의 첨부 소유자 검사를 실제 PostgreSQL/HTTP로 확인한다.
// 스토리지는 고정 URL fake를 쓴다(실제 서명 URL은 INT-D11에서 별도 검증).
const hasDatabase = Boolean(testDatabaseUrl());
const NOW = new Date("2026-11-04T05:20:00.000Z");
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type Ids = {
  clientId: string;
  supplierId: string;
  strangerId: string;
  draftId: string;
  projectId: string;
  applicationId: string;
  contractId: string;
  inquiryId: string;
};

async function seed(prisma: PrismaClient): Promise<Ids> {
  const ids: Ids = {
    clientId: randomUUID(),
    supplierId: randomUUID(),
    strangerId: randomUUID(),
    draftId: randomUUID(),
    projectId: randomUUID(),
    applicationId: randomUUID(),
    contractId: randomUUID(),
    inquiryId: randomUUID(),
  };
  await prisma.user.createMany({
    data: [
      { id: ids.clientId, email: `g205f-c-${ids.clientId}@test.local`, role: "CLIENT" },
      { id: ids.supplierId, email: `g205f-s-${ids.supplierId}@test.local`, role: "SUPPLIER" },
      { id: ids.strangerId, email: `g205f-x-${ids.strangerId}@test.local`, role: "CLIENT" },
    ],
  });
  await prisma.clientProfile.createMany({
    data: [
      { userId: ids.clientId, businessName: "카페", profileCompleted: true },
      { userId: ids.strangerId, businessName: "다른 가게", profileCompleted: true },
    ],
  });
  await prisma.supplierProfile.create({
    data: { userId: ids.supplierId, displayName: "공급자", industryCodes: [], skills: [] },
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
      status: "CONTRACTED",
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
      status: "ACCEPTED",
    },
  });
  await prisma.contract.create({
    data: {
      id: ids.contractId,
      applicationId: ids.applicationId,
      specVersionNo: 1,
      status: "ACTIVE",
      agreedAmount: 3_100_000,
      durationDays: 42,
      clientFee: 155_000,
      supplierFee: 155_000,
      consentDeadline: NOW,
      contentHash: "hash-g205f",
      interimRatio: 50,
    },
  });
  await prisma.supportInquiry.create({
    data: {
      id: ids.inquiryId,
      userId: ids.clientId,
      category: "OTHER",
      title: "문의",
      body: "문의 본문",
    },
  });
  return ids;
}

async function cleanup(prisma: PrismaClient, ids: Ids): Promise<void> {
  const userIds = [ids.clientId, ids.supplierId, ids.strangerId];
  await prisma.fileAttachment.deleteMany({ where: { contractId: ids.contractId } });
  await prisma.fileAttachment.deleteMany({ where: { inquiryId: ids.inquiryId } });
  await prisma.supportInquiry.deleteMany({ where: { id: ids.inquiryId } });
  await prisma.contract.deleteMany({ where: { id: ids.contractId } });
  await prisma.application.deleteMany({ where: { id: ids.applicationId } });
  await prisma.project.deleteMany({ where: { id: ids.projectId } });
  await prisma.draft.deleteMany({ where: { id: ids.draftId } });
  await prisma.clientProfile.deleteMany({ where: { userId: { in: [ids.clientId, ids.strangerId] } } });
  await prisma.supplierProfile.deleteMany({ where: { userId: ids.supplierId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function start(prisma: PrismaClient, ids: Ids): Promise<{ baseUrl: string }> {
  const prismaPorts = createPrismaPorts(prisma);
  const storage: FileStorageAdapter = {
    async createUploadUrl(bucket, objectKey, expiresInSec) {
      return { uploadUrl: `https://storage.test/${bucket}/${objectKey}`, expiresInSec };
    },
    async createDownloadUrl(bucket, objectKey) {
      return { downloadUrl: `https://storage.test/${bucket}/${objectKey}`, expiresInSec: 180 };
    },
  };
  const handler = createAppHandler(
    {
      prisma,
      webhookSecret: "unused",
      bucket: "test-bucket",
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
        storage,
        catalogAdmin: createCatalogAdminPort(prisma),
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
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function download(
  baseUrl: string,
  userId: string,
  role: string,
  fileId: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/uploads/${fileId}/download`, {
    headers: { "x-test-user": userId, "x-test-role": role },
  });
  const json = await response.json();
  return { status: response.status, body: (json && (json as { data?: unknown }).data !== undefined) ? (json as { data: unknown }).data : json };
}

async function presign(
  baseUrl: string,
  userId: string,
  role: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/uploads/presign`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-user": userId,
      "x-test-role": role,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, body: (json && (json as { data?: unknown }).data !== undefined) ? (json as { data: unknown }).data : json };
}

describe("INT-G2-05: 파일 presign 권한", { skip: hasDatabase ? false : "DATABASE_URL 없음" }, () => {
  it("계약 문서와 문의 첨부는 당사자·작성자만 presign 받는다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const { baseUrl } = await start(prisma, ids);

      // 실행
      const contractDocument = await presign(baseUrl, ids.supplierId, "SUPPLIER", {
        purpose: "CONTRACT_DOCUMENT",
        contractId: ids.contractId,
        fileName: "signed.pdf",
        fileSize: 1_000,
        mimeType: "application/pdf",
      });
      // 확인
      assert.equal(contractDocument.status, 201);
      const contractFileId = (contractDocument.body as { fileId: string }).fileId;
      assert.equal(
        (contractDocument.body as { objectKey: string }).objectKey.startsWith(
          `contract_document/${ids.contractId}/`,
        ),
        true,
      );

      // 실행 및 확인
      const ownDownload = await download(baseUrl, ids.supplierId, "SUPPLIER", contractFileId);
      assert.equal(ownDownload.status, 200);
      assert.equal(typeof (ownDownload.body as { downloadUrl?: string }).downloadUrl, "string");

      // 실행 및 확인
      const strangerDownload = await download(baseUrl, ids.strangerId, "CLIENT", contractFileId);
      assert.equal(strangerDownload.status, 403);

      // 실행 및 확인
      const strangerContract = await presign(baseUrl, ids.strangerId, "CLIENT", {
        purpose: "CONTRACT_DOCUMENT",
        contractId: ids.contractId,
        fileName: "signed.pdf",
        fileSize: 1_000,
        mimeType: "application/pdf",
      });
      assert.equal(strangerContract.status, 403);

      // 실행 및 확인
      const strangerDelivery = await presign(baseUrl, ids.clientId, "CLIENT", {
        purpose: "DELIVERY",
        contractId: ids.contractId,
        fileName: "result.pdf",
        fileSize: 1_000,
        mimeType: "application/pdf",
      });
      assert.equal(strangerDelivery.status, 403);

      // 실행
      const inquiryOwner = await presign(baseUrl, ids.clientId, "CLIENT", {
        purpose: "SUPPORT_INQUIRY",
        inquiryId: ids.inquiryId,
        fileName: "screen.png",
        fileSize: 1_000,
        mimeType: "image/png",
      });
      // 확인
      assert.equal(inquiryOwner.status, 201);
      const inquiryFileId = (inquiryOwner.body as { fileId: string }).fileId;
      assert.equal((await download(baseUrl, ids.clientId, "CLIENT", inquiryFileId)).status, 200);
      assert.equal((await download(baseUrl, ids.strangerId, "CLIENT", inquiryFileId)).status, 403);

      // 실행 및 확인
      const inquiryStranger = await presign(baseUrl, ids.strangerId, "CLIENT", {
        purpose: "SUPPORT_INQUIRY",
        inquiryId: ids.inquiryId,
        fileName: "screen.png",
        fileSize: 1_000,
        mimeType: "image/png",
      });
      assert.equal(inquiryStranger.status, 403);

      // 확인
      assert.equal(await prisma.fileAttachment.count({ where: { contractId: ids.contractId } }), 1);
      assert.equal(await prisma.fileAttachment.count({ where: { inquiryId: ids.inquiryId } }), 1);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });
});
