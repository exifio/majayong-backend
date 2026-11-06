import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
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
import { cleanupE2e } from "../tests/e2e-cleanup.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("E2E-01 requires the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const now = new Date("2026-11-03T09:00:00.000Z");
const tokenSecret = "e2e-01-token-secret-longer-than-32-chars";
const userIds: string[] = [];
const draftIds: string[] = [];
const projectIds: string[] = [];
const servers: Server[] = [];

async function makeClient(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e01-${id}@example.invalid`, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: id, businessName: "카페 블루", profileCompleted: true } });
  return id;
}

function startApp(): Promise<{ server: Server; baseUrl: string }> {
  const aProjectDb = createAProjectDb(db);
  const candidateDb = createProjectCandidateDb(db);
  const projectPorts = {
    search: createAProjectSearchPort(createProjectSearchPort(createProjectCandidatePort(candidateDb))),
    view: createAProjectViewPort(aProjectDb),
    application: createAProjectApplicationPort(aProjectDb) as never,
  };
  const externalPorts = createIntegrationPorts(createPrismaIntegrationDb(db), {
    now: () => now,
  });
  const prismaPorts = createPrismaPorts(db);
  const applicationRead = createPrismaApplicationReadPort(prismaPorts.applicationRead);
  const bRouters = createBRouters(prismaPorts, externalPorts, applicationRead).map(mounted => mounted.router);
  const app = createApp({
    db,
    tokenSecret,
    google: { clientId: "", clientSecret: "", redirectUri: "" },
    projectDisclosureConsentVersion: () => "project-disclosure-v0.1-draft",
    project: projectPorts,
    draft: { catalog: createDraftCatalogAdapter(db, {}) },
    profile: { encryptionKey: process.env.PROFILE_DATA_KEY ?? "0123456789abcdef0123456789abcdef", supplierNdaVersion: "nda-v1" },
    routers: bRouters,
    fallback: undefined,
  });
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
    servers.push(server);
  });
}

async function requestJson(baseUrl: string, method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

afterAll(async () => {
  await cleanupE2e(db, { userIds, projectIds, draftIds });
  for (const server of servers) server.close();
  await db.$disconnect();
});

beforeAll(async () => {
  await seedReservationRestaurantCatalog(db);
});

// 기본 초안 생성부터 프로젝트 게시까지의 흐름을 HTTP로 검증한다.
describe("E2E-01 초안에서 명세까지", () => {
  it("기본 초안을 만들고 프로젝트를 게시한다", async () => {
    // 준비: 의뢰인 계정·토큰과 앱 기동
    const clientId = await makeClient();
    const token = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const { baseUrl } = await startApp();

    // 실행: 기본 초안 생성
    const createResponse = await requestJson(baseUrl, "POST", "/api/v1/drafts", token, { entryType: "DEFAULT_DRAFT" });
    // 확인: 초안이 생성된다
    expect(createResponse.status).toBe(201);
    const draftId = createResponse.body.data.id;
    draftIds.push(draftId);

    // 실행: 초안 가격 리포트 조회
    const priceReport = await requestJson(baseUrl, "GET", `/api/v1/drafts/${draftId}/price-report`, token);
    // 확인: 가격 리포트가 반환된다
    expect(priceReport.status).toBe(200);

    // 실행: 초안 게시
    const publish = await requestJson(baseUrl, "POST", `/api/v1/drafts/${draftId}/publish`, token, { disclosureConsentVersion: "project-disclosure-v0.1-draft", disclosureConsent: true, disclosureScope: "FULL", deadline: "2026-11-10T09:00:00.000Z" });
    // 확인: 프로젝트가 생성된다
    expect(publish.status).toBe(201);
    projectIds.push(publish.body.data.id);
  });
});
