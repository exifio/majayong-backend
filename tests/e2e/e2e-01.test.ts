import { afterAll, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { PrismaClient, Role } from "@prisma/client";
import { createApp } from "../../src/app.ts";
import { issueAccessToken } from "../../src/modules/identity/auth.ts";
import { createDraftCatalogAdapter } from "../../src/integration/draft-catalog-adapter.ts";
import { createAProjectDb, createProjectCandidateDb, createPrismaIntegrationDb } from "../../src/integration/prisma-wiring.ts";
import { createAProjectSearchPort, createAProjectViewPort, createAProjectApplicationPort, createProjectCandidatePort } from "../../src/integration/a-ports.ts";
import { createProjectSearchPort } from "../../src/modules/market/project-search.ts";
import { createBRouters } from "../../src/server.ts";
import { createIntegrationPorts } from "../../src/integration/external-ports.ts";
import { createPrismaPorts } from "../../src/integration/prisma-wiring.ts";
import { createPrismaApplicationReadPort } from "../../src/modules/application/prisma-adapter.ts";

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
    projectDisclosureConsentVersion: () => "v1",
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
  // 정리: 생성한 프로젝트·초안·사용자 삭제와 서버 종료
  await db.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => undefined);
  await db.draft.deleteMany({ where: { id: { in: draftIds } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  for (const server of servers) server.close();
  await db.$disconnect();
});

describe("E2E-01 초안에서 명세까지", () => {
  it("기본 초안을 만들고 프로젝트를 게시한다", async () => {
    // 준비: 의뢰인 계정·토큰과 앱 서버 기동
    const clientId = await makeClient();
    const token = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const { baseUrl } = await startApp();

    // 실행: 기본 초안 생성
    const createResponse = await requestJson(baseUrl, "POST", "/api/v1/drafts", token, { entryType: "DEFAULT_DRAFT" });
    // 확인
    expect(createResponse.status).toBe(201);
    const draftId = createResponse.body.data.id;
    draftIds.push(draftId);

    // 실행: 초안 가격 리포트 조회
    const priceReport = await requestJson(baseUrl, "GET", `/api/v1/drafts/${draftId}/price-report`, token);
    // 확인
    expect(priceReport.status).toBe(200);

    // 실행: 초안 발행
    const publish = await requestJson(baseUrl, "POST", `/api/v1/drafts/${draftId}/publish`, token, { disclosureConsentVersion: "v1" });
    // 확인
    expect(publish.status).toBe(201);
    projectIds.push(publish.body.data.id);
  });
});
