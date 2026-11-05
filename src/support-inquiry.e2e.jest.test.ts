import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { PrismaClient, Role } from "@prisma/client";
import { createApp } from "./app.ts";
import { issueAccessToken } from "./modules/identity/auth.ts";
import { createAProjectDb, createProjectCandidateDb, createPrismaIntegrationDb } from "./integration/prisma-wiring.ts";
import { createDraftCatalogAdapter } from "./integration/draft-catalog-adapter.ts";
import { createAProjectSearchPort, createAProjectViewPort, createAProjectApplicationPort, createProjectCandidatePort } from "./integration/a-ports.ts";
import { createProjectSearchPort } from "./modules/market/project-search.ts";
import { createBRouters } from "./server.ts";
import { createIntegrationPorts } from "./integration/external-ports.ts";
import { createPrismaPorts } from "./integration/prisma-wiring.ts";
import { createPrismaApplicationReadPort } from "./modules/application/prisma-adapter.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("E2E-09 requires the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const tokenSecret = "e2e-09-token-secret-longer-than-32-chars";
const userIds: string[] = [];
const servers: any[] = [];

async function makeUser(role: Role): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e09-${role.toLowerCase()}-${id}@example.invalid`, role } });
  if (role === Role.CLIENT) await db.clientProfile.create({ data: { userId: id, businessName: "카페 블루", profileCompleted: true } });
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

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  for (const server of servers) server.close();
  await db.$disconnect();
});

// 의뢰인의 1:1 문의 생성과 운영자 답변 흐름을 검증한다.
describe("E2E-09 1:1 문의", () => {
  it("의뢰인이 문의를 만들고 운영자가 답변한다", async () => {
    // 준비: 의뢰인·운영자 계정과 토큰, 앱 기동
    const clientId = await makeUser(Role.CLIENT);
    const adminId = await makeUser(Role.ADMIN);
    const clientToken = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const adminToken = issueAccessToken({ userId: adminId, role: Role.ADMIN, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const { baseUrl, close } = await startApp();

    // 실행: 의뢰인이 문의를 만든다
    const create = await req(baseUrl, "POST", "/api/v1/support/inquiries", clientToken, {
      category: "OTHER",
      title: "문의 제목",
      body: "문의 내용",
    });
    // 확인: 문의가 접수된다
    expect(create.status).toBe(201);
    const inquiryId = create.body.data.id;

    // 실행: 운영자가 문의 목록을 조회한다
    const adminList = await req(baseUrl, "GET", "/api/v1/admin/support/inquiries", adminToken);
    // 확인: 목록이 반환된다
    expect(adminList.status).toBe(200);

    // 실행: 운영자가 답변을 등록한다
    const answer = await req(baseUrl, "POST", `/api/v1/admin/support/inquiries/${inquiryId}/answer`, adminToken, {
      answer: "답변 내용",
    });
    // 확인: 답변이 등록된다
    expect(answer.status).toBe(200);

    // 실행: 의뢰인이 문의 상세를 조회한다
    const detail = await req(baseUrl, "GET", `/api/v1/support/inquiries/${inquiryId}`, clientToken);
    // 확인: 답변이 담긴 상세가 반환된다
    expect(detail.status).toBe(200);
    expect(detail.body.data.status ?? detail.body.data.answer).toBeTruthy();

    close();
  });
});
