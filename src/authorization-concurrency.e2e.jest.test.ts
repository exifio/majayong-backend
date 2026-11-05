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
  throw new Error("E2E-10 requires the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const tokenSecret = "e2e-10-token-secret-longer-than-32-chars";
const userIds: string[] = [];
const draftIds: string[] = [];
const projectIds: string[] = [];
const servers: any[] = [];

async function makeClient(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e10c-${id}@example.invalid`, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: id, businessName: "카페 블루", profileCompleted: true } });
  return id;
}
async function makeSupplier(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e10s-${id}@example.invalid`, role: Role.SUPPLIER } });
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

async function req(baseUrl: string, method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
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

// 사용자 간 접근과 중복 지원이 차단되는지 검증한다.
describe("E2E-10 권한과 동시성", () => {
  it("다른 사용자 접근과 중복 지원을 막는다", async () => {
    // 준비: 의뢰인과 공급자 두 명의 계정·토큰, 앱 기동
    const clientId = await makeClient();
    const clientToken = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const supplierA = await makeSupplier();
    const supplierB = await makeSupplier();
    const supplierAToken = issueAccessToken({ userId: supplierA, role: Role.SUPPLIER, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const supplierBToken = issueAccessToken({ userId: supplierB, role: Role.SUPPLIER, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const { baseUrl, close } = await startApp();

    // 실행: 기본 초안 생성
    const createDraft = await req(baseUrl, "POST", "/api/v1/drafts", clientToken, { entryType: "DEFAULT_DRAFT" });
    // 확인: 초안이 생성된다
    expect(createDraft.status).toBe(201);
    const draftId = createDraft.body.data.id;
    draftIds.push(draftId);

    // 실행: 초안 게시
    const publish = await req(baseUrl, "POST", `/api/v1/drafts/${draftId}/publish`, clientToken, {
      disclosureConsentVersion: "project-disclosure-v0.1-draft",
      disclosureConsent: true,
      disclosureScope: "FULL",
      deadline: "2026-11-10T09:00:00.000Z",
    });
    // 확인: 프로젝트가 생성된다
    expect(publish.status).toBe(201);
    const projectId = publish.body.data.projectId;
    projectIds.push(projectId);

    // 실행: 공급자 A가 지원을 제출한다
    const specItems = await db.specItem.findMany({ where: { projectId, versionNo: 1, status: "INCLUDED" } });
    await req(baseUrl, "GET", `/api/v1/projects/${projectId}`, supplierAToken);
    const first = await req(baseUrl, "POST", `/api/v1/projects/${projectId}/applications`, supplierAToken, {
      items: specItems.map(item => ({ specItemId: item.id, isAvailable: true })),
      totalAmount: 100000,
      durationDays: 3,
      message: "지원합니다",
      questions: [{ text: "질문1" }, { text: "질문2" }, { text: "질문3" }],
    });
    // 확인: 지원이 생성된다
    expect(first.status).toBe(201);
    const applicationId = first.body.data.id;

    // 실행 및 확인: 다른 공급자는 같은 지원 상세를 볼 수 없어야 한다.
    const cross = await req(baseUrl, "GET", `/api/v1/applications/${applicationId}`, supplierBToken);
    expect([403, 404]).toContain(cross.status);

    // 실행 및 확인: 같은 공급자의 중복 지원은 거부되어야 한다.
    const duplicate = await req(baseUrl, "POST", `/api/v1/projects/${projectId}/applications`, supplierAToken, {
      items: specItems.map(item => ({ specItemId: item.id, isAvailable: true })),
      totalAmount: 100000,
      durationDays: 3,
      message: "중복 지원",
      questions: [{ text: "질문1" }, { text: "질문2" }, { text: "질문3" }],
    });
    expect([409, 400]).toContain(duplicate.status);

    // 실행 및 확인: 의뢰인 전용 엔드포인트에 공급자가 접근하면 거부되어야 한다.
    const forbidden = await req(baseUrl, "GET", "/api/v1/me/projects", supplierAToken);
    expect(forbidden.status).toBe(403);

    close();
  });
});
