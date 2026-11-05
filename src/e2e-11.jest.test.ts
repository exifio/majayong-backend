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
  throw new Error("E2E-11 requires the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const tokenSecret = "e2e-11-token-secret-longer-than-32-chars";
const userIds: string[] = [];
const draftIds: string[] = [];
const servers: any[] = [];

async function makeClient(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e11-${id}@example.invalid`, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: id, businessName: "카페 블루", profileCompleted: true } });
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
    draft: { catalog: createDraftCatalogAdapter(db, {}) }, // AI 비활성
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

beforeAll(async () => {
  await seedReservationRestaurantCatalog(db);
});

afterAll(async () => {
  await db.draft.deleteMany({ where: { id: { in: draftIds } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  for (const server of servers) server.close();
  await db.$disconnect();
});

// AI 추출기를 쓸 수 없을 때 초안이 대기 상태로 유지되는지 검증한다.
describe("E2E-11 AI 실패 안전성", () => {
  it("AI 추출기를 쓸 수 없을 때 초안을 대기 상태로 유지한다", async () => {
    // 준비: 의뢰인 계정·토큰과 AI 없이 띄운 앱
    const clientId = await makeClient();
    const token = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const { baseUrl, close } = await startApp();

    // 실행: 문장 입력으로 초안 생성
    const createDraft = await fetch(`${baseUrl}/api/v1/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ entryType: "SENTENCE", text: "예약 달력과 방문 인원 선택 기능이 필요합니다." }),
    });
    const draftBody = await createDraft.json() as any;
    // 확인: 초안이 만들어지고 대기 기능이 남는다
    expect(createDraft.status).toBe(201);
    draftIds.push(draftBody.data.id);
    expect(Array.isArray(draftBody.data.pendingFeatures)).toBe(true);
    expect(draftBody.data.pendingFeatures.length).toBeGreaterThan(0);

    close();
  });
});
