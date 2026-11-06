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
import { cleanupE2e } from "../tests/e2e-cleanup.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("E2E-02 requires the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const tokenSecret = "e2e-02-token-secret-longer-than-32-chars";
const userIds: string[] = [];
const draftIds: string[] = [];
const projectIds: string[] = [];
const servers: any[] = [];

async function makeClient(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e02c-${id}@example.invalid`, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: id, businessName: "카페 블루", profileCompleted: true } });
  return id;
}

async function makeSupplier(nda: "valid" | "none" | "stale" = "valid"): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e02s-${id}@example.invalid`, role: Role.SUPPLIER } });
  await db.supplierProfile.create({
    data: {
      userId: id,
      displayName: "공급자",
      ndaAgreedAt: nda === "none" ? null : new Date(),
      ndaVersion: nda === "none" ? null : nda === "stale" ? "nda-old" : "nda-v1",
    },
  });
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
  const externalPorts = createIntegrationPorts(createPrismaIntegrationDb(db), { now: () => new Date() });
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
  await cleanupE2e(db, { userIds, projectIds, draftIds });
  for (const server of servers) server.close();
  await db.$disconnect();
});

// 공급자가 게시된 프로젝트를 읽고 지원하는 흐름을 HTTP로 검증한다.
describe("E2E-02 공급자 지원", () => {
  it("공급자가 게시된 프로젝트를 읽고 지원할 수 있다", async () => {
    // 준비: 의뢰인 계정·토큰과 앱 기동
    const clientId = await makeClient();
    const clientToken = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: Date.now() + 60_000 }, tokenSecret);
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

    // 준비: NDA에 동의한 공급자와 토큰
    const supplierId = await makeSupplier();
    const supplierToken = issueAccessToken({ userId: supplierId, role: Role.SUPPLIER, expiresAt: Date.now() + 60_000 }, tokenSecret);

    // 실행: 공급자의 프로젝트 상세 조회
    const detail = await req(baseUrl, "GET", `/api/v1/projects/${projectId}`, supplierToken);
    // 확인: 상세가 열린다
    expect(detail.status).toBe(200);
    const specItems = await db.specItem.findMany({ where: { projectId, versionNo: 1, status: "INCLUDED" }, orderBy: { sortOrder: "asc" } });
    const specItemIds = specItems.map(item => item.id);
    // 확인: 상세의 specItemId가 지원 요청에 쓸 현재 명세 ID와 같다
    expect(detail.body.data.items.map((item: { specItemId: string }) => item.specItemId)).toEqual(specItemIds);
    // 확인: 공급자 상세에 의뢰인 이메일·AI 단가가 노출되지 않는다
    expect(JSON.stringify(detail.body)).not.toContain("@example.invalid");
    expect(detail.body.data).not.toHaveProperty("unitPrice");
    expect(detail.body.data.client).not.toHaveProperty("email");

    // 실행: 명세 항목을 선택해 지원 제출
    const submit = await req(baseUrl, "POST", `/api/v1/projects/${projectId}/applications`, supplierToken, {
      items: [{ specItemId: specItemIds[0], isAvailable: true }],
      totalAmount: 100000,
      durationDays: 3,
      message: "지원합니다",
      questions: [{ text: "질문1" }, { text: "질문2" }, { text: "질문3" }],
    });
    // 확인: 지원이 생성된다
    expect(submit.status).toBe(201);

    close();
  });

  it("NDA·역할·명세 항목이 맞지 않으면 상세와 지원을 거부한다", async () => {
    // 준비: 의뢰인 계정과 게시된 프로젝트
    const clientId = await makeClient();
    const clientToken = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const { baseUrl, close } = await startApp();
    const createDraft = await req(baseUrl, "POST", "/api/v1/drafts", clientToken, { entryType: "DEFAULT_DRAFT" });
    const draftId = createDraft.body.data.id;
    draftIds.push(draftId);
    const publish = await req(baseUrl, "POST", `/api/v1/drafts/${draftId}/publish`, clientToken, {
      disclosureConsentVersion: "project-disclosure-v0.1-draft",
      disclosureConsent: true,
      disclosureScope: "FULL",
      deadline: "2026-11-10T09:00:00.000Z",
    });
    const projectId = publish.body.data.projectId;
    projectIds.push(projectId);

    // 실행 및 확인: NDA 미동의 공급자는 상세를 볼 수 없다
    const noNdaId = await makeSupplier("none");
    const noNdaToken = issueAccessToken({ userId: noNdaId, role: Role.SUPPLIER, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const noNda = await req(baseUrl, "GET", `/api/v1/projects/${projectId}`, noNdaToken);
    expect(noNda.status).toBe(403);
    expect(noNda.body.error.code).toBe("SUPPLIER_NDA_REQUIRED");

    // 실행 및 확인: 구버전 NDA 동의도 거부한다
    const staleId = await makeSupplier("stale");
    const staleToken = issueAccessToken({ userId: staleId, role: Role.SUPPLIER, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const stale = await req(baseUrl, "GET", `/api/v1/projects/${projectId}`, staleToken);
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("SUPPLIER_NDA_REQUIRED");

    // 실행 및 확인: 의뢰인 역할은 공급자 상세를 볼 수 없다
    const clientDetail = await req(baseUrl, "GET", `/api/v1/projects/${projectId}`, clientToken);
    expect(clientDetail.status).toBe(403);
    expect(clientDetail.body.error.code).toBe("ROLE_MISMATCH");

    // 실행 및 확인: 현재 명세에 없는 specItemId는 지원으로 만들 수 없다
    const supplierId = await makeSupplier();
    const supplierToken = issueAccessToken({ userId: supplierId, role: Role.SUPPLIER, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const invalidItem = await req(baseUrl, "POST", `/api/v1/projects/${projectId}/applications`, supplierToken, {
      items: [{ specItemId: randomUUID(), isAvailable: true }],
      totalAmount: 100000,
      durationDays: 3,
      message: "지원합니다",
    });
    expect(invalidItem.status).toBe(400);
    expect(invalidItem.body.error.code).toBe("INVALID_SPEC_ITEM");

    // 실행 및 확인: 의뢰인 역할은 지원을 제출할 수 없다
    const clientApply = await req(baseUrl, "POST", `/api/v1/projects/${projectId}/applications`, clientToken, {});
    expect(clientApply.status).toBe(403);
    expect(clientApply.body.error.code).toBe("FORBIDDEN");

    close();
  });
});
