import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { PrismaClient, Role } from "@prisma/client";
import { createApp } from "./app.ts";
import { issueAccessToken } from "./modules/identity/auth.ts";
import { createDraftCatalogAdapter } from "./integration/draft-catalog-adapter.ts";
import { seedReservationRestaurantCatalog } from "./modules/catalog/seed.ts";
import { createAProjectDb, createProjectCandidateDb, createPrismaIntegrationDb } from "./integration/prisma-wiring.ts";
import { createAProjectSearchPort, createAProjectViewPort, createAProjectApplicationPort, createProjectCandidatePort } from "./integration/a-ports.ts";
import { createProjectSearchPort } from "./modules/market/project-search.ts";
import { createBRouters } from "./server.ts";
import { createIntegrationPorts } from "./integration/external-ports.ts";
import { createPrismaPorts } from "./integration/prisma-wiring.ts";
import { createPrismaApplicationReadPort } from "./modules/application/prisma-adapter.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("E2E-12 requires the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const tokenSecret = "e2e-12-token-secret-longer-than-32-chars";
const userIds: string[] = [];
const draftIds: string[] = [];
const projectIds: string[] = [];
const servers: any[] = [];

async function makeClient(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `e2e12c-${id}@example.invalid`;
  userIds.push(id);
  await db.user.create({ data: { id, email, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: id, businessName: "카페 블루", profileCompleted: true } });
  return { id, email };
}
async function makeSupplier(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e12s-${id}@example.invalid`, role: Role.SUPPLIER } });
  await db.supplierProfile.create({ data: { userId: id, displayName: "공급자", ndaAgreedAt: new Date(), ndaVersion: "nda-v1" } });
  return id;
}

function startApp(): Promise<{ baseUrl: string; close: () => void }> {
  const aProjectDb = createAProjectDb(db);
  const candidateDb = createProjectCandidateDb(db);
  const projectPorts = {
    supplierNdaVersion: "nda-v1",
    search: createAProjectSearchPort(createProjectSearchPort(createProjectCandidatePort(candidateDb))),
    view: createAProjectViewPort(aProjectDb),
    application: createAProjectApplicationPort(aProjectDb) as never,
  };
  const integrationDb = createPrismaIntegrationDb(db);
  const externalPorts = createIntegrationPorts(integrationDb, { now: () => new Date() });
  const prismaPorts = createPrismaPorts(db);
  const applicationRead = createPrismaApplicationReadPort(prismaPorts.applicationRead);
  const bRouters = createBRouters(prismaPorts, externalPorts, applicationRead).map((m: any) => m.router);
  const app = createApp({
    db,
    tokenSecret,
    google: { clientId: "", clientSecret: "", redirectUri: "" },
    projectDisclosureConsentVersion: () => "project-disclosure-v0.1-draft",
    project: projectPorts,
    draft: { catalog: createDraftCatalogAdapter(db, {}) },
    profile: { encryptionKey: process.env.PROFILE_DATA_KEY ?? "0123456789abcdef0123456789abcdef", supplierNdaVersion: "nda-v1" },
    routers: bRouters,
  });
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
    servers.push(server);
  });
}

async function req(baseUrl: string, method: string, path: string, token: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  return { status: response.status, text };
}

beforeAll(async () => {
  await seedReservationRestaurantCatalog(db);
});

afterAll(async () => {
  await db.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => undefined);
  await db.draft.deleteMany({ where: { id: { in: draftIds } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  for (const server of servers) server.close();
  await db.$disconnect();
});

// 공개 상세 응답에 개인정보와 AI 단가가 섞이지 않는지 검증한다.
describe("E2E-12 개인정보와 보안", () => {
  it("공개 프로젝트 상세에 의뢰인 이메일·계좌나 AI 단가를 노출하지 않는다", async () => {
    // 준비: 의뢰인·공급자 계정과 토큰, 앱 기동
    const client = await makeClient();
    const clientToken = issueAccessToken({ userId: client.id, role: Role.CLIENT, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const supplierId = await makeSupplier();
    const supplierToken = issueAccessToken({ userId: supplierId, role: Role.SUPPLIER, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const { baseUrl, close } = await startApp();

    // req 헬퍼는 GET에는 본문을 보내지 않으므로 POST는 fetch로 직접 호출한다
    // 실행: 기본 초안 생성
    const draftRes = await fetch(`${baseUrl}/api/v1/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
      body: JSON.stringify({ entryType: "DEFAULT_DRAFT" }),
    });
    const draftBody = await draftRes.json() as any;
    // 확인: 초안이 생성된다
    expect(draftRes.status).toBe(201);
    const draftId = draftBody.data.id;
    draftIds.push(draftId);

    // 실행: 초안 게시
    const publishRes = await fetch(`${baseUrl}/api/v1/drafts/${draftId}/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        disclosureConsentVersion: "project-disclosure-v0.1-draft",
        disclosureConsent: true,
        disclosureScope: "FULL",
        deadline: "2026-11-10T09:00:00.000Z",
      }),
    });
    const publishBody = await publishRes.json() as any;
    // 확인: 프로젝트가 생성된다
    expect(publishRes.status).toBe(201);
    const projectId = publishBody.data.projectId;
    projectIds.push(projectId);

    // 실행: 공급자가 공개 상세를 조회한다
    const detailRes = await fetch(`${baseUrl}/api/v1/projects/${projectId}`, {
      headers: { authorization: `Bearer ${supplierToken}` },
    });
    const detailText = await detailRes.text();
    // 확인: 상세가 열리되 이메일·계좌·AI 단가가 없다
    expect(detailRes.status).toBe(200);
    expect(detailText).not.toContain(client.email);
    expect(detailText).not.toContain("payoutAccount");
    expect(detailText).not.toContain("unitPrice");

    close();
  });
});
