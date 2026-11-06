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
  throw new Error("E2E-04 requires the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const tokenSecret = "e2e-04-token-secret-longer-than-32-chars";
const userIds: string[] = [];
const draftIds: string[] = [];
const projectIds: string[] = [];
const servers: any[] = [];

async function makeClient(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e04c-${id}@example.invalid`, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: id, businessName: "카페 블루", profileCompleted: true } });
  return id;
}
async function makeSupplier(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e04s-${id}@example.invalid`, role: Role.SUPPLIER } });
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
  await cleanupE2e(db, { userIds, projectIds, draftIds });
  for (const server of servers) server.close();
  await db.$disconnect();
});

// 합의 확정 후 양측 서명으로 계약이 활성화되는 흐름을 HTTP로 검증한다.
describe("E2E-04 서명", () => {
  it("양측이 서명하면 계약이 활성화된다", async () => {
    // 준비: 의뢰인·공급자 계정과 토큰, 앱 기동
    const clientId = await makeClient();
    const clientToken = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const supplierId = await makeSupplier();
    const supplierToken = issueAccessToken({ userId: supplierId, role: Role.SUPPLIER, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const outsiderId = await makeSupplier();
    const outsiderToken = issueAccessToken({ userId: outsiderId, role: Role.SUPPLIER, expiresAt: Date.now() + 60_000 }, tokenSecret);
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

    const specItems = await db.specItem.findMany({ where: { projectId, versionNo: 1, status: "INCLUDED" } });
    // 실행: 공급자의 프로젝트 상세 조회
    const detail = await req(baseUrl, "GET", `/api/v1/projects/${projectId}`, supplierToken);
    // 확인: 상세가 열린다
    expect(detail.status).toBe(200);
    // 실행: 명세 항목을 선택해 지원 제출
    const submit = await req(baseUrl, "POST", `/api/v1/projects/${projectId}/applications`, supplierToken, {
      items: specItems.map(item => ({ specItemId: item.id, isAvailable: true })),
      totalAmount: 100000,
      durationDays: 3,
      message: "지원합니다",
      questions: [{ text: "질문1" }, { text: "질문2" }, { text: "질문3" }],
    });
    // 확인: 지원이 생성된다
    expect(submit.status).toBe(201);
    const applicationId = submit.body.data.id;

    // 실행: 채팅을 열고 양측이 메시지를 주고받는다
    await req(baseUrl, "POST", `/api/v1/applications/${applicationId}/chat/open`, clientToken, {});
    await req(baseUrl, "POST", `/api/v1/applications/${applicationId}/messages`, clientToken, { body: "안녕하세요" });
    await req(baseUrl, "POST", `/api/v1/applications/${applicationId}/messages`, supplierToken, { body: "네 안녕하세요" });

    // 실행: 합의 미리보기 조회
    const preview = await req(baseUrl, "GET", `/api/v1/applications/${applicationId}/agreement-preview`, clientToken);
    // 확인: 미리보기가 반환된다
    expect(preview.status).toBe(200);
    // 준비: 미리보기 명세로 미합의 상태의 합의 초안을 만든다
    const agreementDraft = {
      items: preview.body.data.draft.items.map((item: any) => ({
        blockId: item.blockId,
        specItemId: null,
        title: item.title,
        stage: item.stage,
        conditions: item.conditions.map((condition: any) => ({
          key: condition.key,
          text: condition.text,
          state: "UNDECIDED",
          evidenceMessageIds: [],
        })),
      })),
      interimRatio: 50,
      ratioState: "UNDECIDED",
      cachedAt: new Date().toISOString(),
      lastMessageAt: null,
    };
    await db.application.update({ where: { id: applicationId }, data: { agreementDraft } });

    // 실행: 의뢰인이 합의를 확정한다
    const confirm = await req(baseUrl, "POST", `/api/v1/applications/${applicationId}/agreement/confirm`, clientToken, {});
    // 확인: 임시 계약이 만들어진다
    expect(confirm.status).toBe(201);
    const contractId = confirm.body.data.contract.id;

    // 확인: 계약 항목 ID가 상세·문서 응답에 노출된다(FE-10 납품/검수 연결)
    const contractDetail = await req(baseUrl, "GET", `/api/v1/contracts/${contractId}`, clientToken);
    const contractDocument = await req(baseUrl, "GET", `/api/v1/contracts/${contractId}/document`, clientToken);
    expect(contractDetail.status).toBe(200);
    expect(contractDocument.status).toBe(200);
    const itemIds = (contractDetail.body.data.items as Array<{ id: string }>).map((item) => item.id);
    expect(itemIds.length).toBeGreaterThan(0);
    expect(itemIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect((contractDocument.body.data.items as Array<{ id: string }>).map((item) => item.id)).toEqual(itemIds);

    // 준비: 계약 내용 해시
    const contractRow = await db.contract.findUnique({ where: { id: contractId }, select: { contentHash: true } });
    const hash = contractRow?.contentHash;
    expect(hash).toBeTruthy();

    // 실행: 의뢰인 서명
    const clientSign = await req(baseUrl, "POST", `/api/v1/contracts/${contractId}/sign`, clientToken, { expectedContentHash: hash });
    // 확인: 의뢰인 서명이 접수된다
    expect(clientSign.status).toBe(200);

    // 실행 및 확인: 계약 당사자가 아니면 서명할 수 없다
    const outsiderSign = await req(baseUrl, "POST", `/api/v1/contracts/${contractId}/sign`, outsiderToken, { expectedContentHash: hash });
    expect(outsiderSign.status).toBe(404);
    expect(outsiderSign.body.error.code).toBe("CONTRACT_NOT_FOUND");

    // 실행 및 확인: 내용 해시가 다르면 서명을 거부한다
    const staleHash = await req(baseUrl, "POST", `/api/v1/contracts/${contractId}/sign`, supplierToken, { expectedContentHash: "stale-hash" });
    expect(staleHash.status).toBe(409);
    expect(staleHash.body.error.code).toBe("CONTRACT_HASH_MISMATCH");

    // 실행 및 확인: 같은 당사자가 다시 서명할 수 없다
    const duplicateSign = await req(baseUrl, "POST", `/api/v1/contracts/${contractId}/sign`, clientToken, { expectedContentHash: hash });
    expect(duplicateSign.status).toBe(409);
    expect(duplicateSign.body.error.code).toBe("ALREADY_SIGNED");

    // 실행 및 확인: 의뢰인은 서명 거절 API를 쓸 수 없다
    const clientDecline = await req(baseUrl, "POST", `/api/v1/contracts/${contractId}/decline`, clientToken, {});
    expect(clientDecline.status).toBe(403);
    expect(clientDecline.body.error.code).toBe("FORBIDDEN");
    // 실행: 공급자 서명
    const supplierSign = await req(baseUrl, "POST", `/api/v1/contracts/${contractId}/sign`, supplierToken, { expectedContentHash: hash });
    // 확인: 공급자 서명이 접수된다
    expect(supplierSign.status).toBe(200);

    // 실행: 계약 상세 조회
    const contract = await req(baseUrl, "GET", `/api/v1/contracts/${contractId}`, clientToken);
    // 확인: 양측 서명으로 계약이 활성화된다
    expect(contract.status).toBe(200);
    expect(contract.body.data.status).toBe("ACTIVE");

    close();
  });
});
