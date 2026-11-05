import { afterAll, describe, expect, it } from "@jest/globals";
import { BlockOrigin, DraftEntryType, PrismaClient, Role } from "@prisma/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Actor } from "../identity/session.ts";
import type { AuthenticatedDraftRoute } from "../draft/api.ts";
import { mountProjectApi } from "./api.ts";
import { publishDraft, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION } from "./service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test") {
  throw new Error("A-05 publish tests require the dedicated majayong_a00_test database");
}
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const userIds: string[] = [];
const draftIds: string[] = [];
const blockIds: string[] = [];
const servers: Server[] = [];
const now = new Date("2026-11-03T12:00:00.000Z");
const validInput = {
  recruitStartAt: "2026-11-04T00:00:00.000Z",
  deadline: "2026-11-10T00:00:00.000Z",
  disclosureConsentVersion: PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION,
  disclosureScope: "DETAIL",
  disclosureConsent: true,
};

async function makeDraft(): Promise<{ clientId: string; draftId: string; blockId: string }> {
  const clientId = randomUUID();
  const draftId = randomUUID();
  const blockId = randomUUID();
  const suggestedBlockId = randomUUID();
  await db.user.create({ data: { id: clientId, email: `a05-publish-${clientId}@example.invalid`, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: clientId, businessName: "테스트 가게" } });
  await db.draft.create({ data: { id: draftId, clientId, entryType: DraftEntryType.SENTENCE, hopeBudget: 5_000_000, pendingFeatures: [] } });
  await db.blockCatalog.create({
    data: {
      id: blockId,
      code: `a05-publish-${blockId}`,
      name: "예약 달력",
      functionSummary: "예약 가능한 날짜와 시간을 표시한다",
      description: "고객이 예약 가능 시간을 확인합니다.",
      industryCode: "RESERVATION_RESTAURANT",
      techTags: ["WEB", "POSTGRESQL"],
      unitPrice: 900_000,
      priceBasis: "화면 및 기본 동작\n일반 작업량\n운영 정책에 따라 변동",
      conditions: [{ key: "capacity", text: "수용 인원" }],
      wireframe: { parts: [{ type: "CALENDAR", label: "예약 가능 시간" }] },
    },
  });
  await db.blockCatalog.create({
    data: {
      id: suggestedBlockId,
      code: `a05-suggested-${suggestedBlockId}`,
      name: "미선택 추천 기능",
      functionSummary: "아직 추가하지 않은 추천 기능",
      description: "초안에 선택되지 않은 기능입니다.",
      industryCode: "RESERVATION_RESTAURANT",
      techTags: ["MOBILE"],
      unitPrice: 700_000,
      priceBasis: "미선택",
    },
  });
  await db.draftBlock.create({
    data: {
      draftId,
      blockId,
      origin: BlockOrigin.FIRST_SENTENCE,
      status: "ADDED",
      unitPrice: 812_345,
      conditionNotes: [{ key: "capacity", note: "최대 20명", at: now.toISOString() }],
      sortOrder: 0,
    },
  });
  await db.draftBlock.create({
    data: { draftId, blockId: suggestedBlockId, origin: BlockOrigin.RECOMMENDATION, status: "SUGGESTED", unitPrice: 700_000 },
  });
  userIds.push(clientId);
  draftIds.push(draftId);
  blockIds.push(blockId, suggestedBlockId);
  return { clientId, draftId, blockId };
}

async function startServer(actor: Actor): Promise<string> {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const authenticated: AuthenticatedDraftRoute = handler => (req, res, next) => {
    Promise.resolve(handler(req, res, actor)).catch(next);
  };
  mountProjectApi(router, db, () => new Date(now), () => PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, authenticated);
  app.use("/api/v1", router);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "INTERNAL_ERROR" });
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind");
  servers.push(server);
  return `http://127.0.0.1:${address.port}/api/v1`;
}

async function publish(baseUrl: string, draftId: string, input: unknown = validInput): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/drafts/${draftId}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

afterAll(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
  if (draftIds.length > 0) {
    const projects = await db.project.findMany({ where: { draftId: { in: draftIds } }, select: { id: true } });
    const projectIds = projects.map(project => project.id);
    if (projectIds.length > 0) {
      await db.eventLog.deleteMany({ where: { projectId: { in: projectIds } } });
      await db.specItem.deleteMany({ where: { projectId: { in: projectIds } } });
    }
    await db.project.deleteMany({ where: { draftId: { in: draftIds } } });
    await db.draftBlock.deleteMany({ where: { draftId: { in: draftIds } } });
    await db.draft.deleteMany({ where: { id: { in: draftIds } } });
  }
  if (blockIds.length > 0) await db.blockCatalog.deleteMany({ where: { id: { in: blockIds } } });
  if (userIds.length > 0) await db.clientProfile.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length > 0) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

// 가격 스냅샷 게시와 게시 거부 조건을 전용 PostgreSQL에서 검증한다.
describe("A-05 프로젝트 게시", () => {
  it("A-05-T04 가격 스냅샷으로 프로젝트와 완전한 버전 1 명세를 정확히 한 번 만든다", async () => {
    // 확인: 사용 중인 공개 동의 초안 버전
    expect(PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION).toBe("project-disclosure-v0.1-draft");
    // 준비: 초안과 게시 서버
    const { clientId, draftId, blockId } = await makeDraft();
    const baseUrl = await startServer({ userId: clientId, role: Role.CLIENT });
    // 실행: 게시 요청
    const response = await publish(baseUrl, draftId);
    const body = await response.json() as { data: Record<string, unknown> };

    // 확인: 응답과 저장된 프로젝트·명세 스냅샷
    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({ title: "예약 달력", status: "SCHEDULED", currentVersion: 1 });
    expect(JSON.stringify(body)).not.toMatch(/unitPrice|priceBasis|estimatedTotal|clientFee/);
    const project = await db.project.findUniqueOrThrow({ where: { draftId } });
    const items = await db.specItem.findMany({ where: { projectId: project.id } });
    expect(project).toMatchObject({
      industryCode: "RESERVATION_RESTAURANT",
      requiredSkills: ["WEB", "POSTGRESQL"],
      hopeBudget: 5_000_000,
      disclosureConsentVersion: PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION,
      recruitStartAt: new Date(validInput.recruitStartAt),
      deadline: new Date(validInput.deadline),
    });
    expect(project.summary).toBe("고객이 예약 가능 시간을 확인합니다.");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      versionNo: 1,
      blockId,
      title: "예약 달력",
      description: "고객이 예약 가능 시간을 확인합니다.",
      unitPrice: 812_345,
      status: "INCLUDED",
      conditions: [{ key: "capacity", text: "수용 인원", note: "최대 20명" }],
      wireframe: { parts: [{ type: "CALENDAR", label: "예약 가능 시간" }] },
    });
    expect(await db.draft.findUniqueOrThrow({ where: { id: draftId }, select: { status: true } })).toEqual({ status: "CONFIRMED" });
    const publishedEvent = await db.eventLog.findFirstOrThrow({ where: { projectId: project.id, type: "PROJECT_PUBLISHED" } });
    expect(publishedEvent.payload).toMatchObject({ disclosureScope: "DETAIL", disclosureConsentVersion: PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION });

    // 실행: 같은 초안을 다시 게시
    const duplicate = await publish(baseUrl, draftId);
    // 확인: 중복 게시는 거부되고 데이터는 한 건으로 남는다
    expect(duplicate.status).toBe(409);
    expect(await db.project.count({ where: { draftId } })).toBe(1);
    expect(await db.specItem.count({ where: { projectId: project.id } })).toBe(1);
  });

  it("A-05-T04 동시 게시 요청을 직렬화하고 부분·중복 프로젝트를 만들지 않는다", async () => {
    // 준비: 게시 대상 초안과 게시 입력
    const { clientId, draftId } = await makeDraft();
    const input = {
      recruitStartAt: new Date(validInput.recruitStartAt),
      deadline: new Date(validInput.deadline),
      disclosureConsentVersion: validInput.disclosureConsentVersion,
      disclosureScope: "DETAIL" as const,
      disclosureConsent: true as const,
    };
    // 실행: 같은 초안에 동시 게시 두 번
    const results = await Promise.allSettled([
      publishDraft(db, draftId, clientId, input, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, now),
      publishDraft(db, draftId, clientId, input, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, now),
    ]);
    // 확인: 하나만 성공하고 명세·게시 이벤트도 한 번만 남는다
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const project = await db.project.findUniqueOrThrow({ where: { draftId } });
    expect(await db.specItem.count({ where: { projectId: project.id } })).toBe(1);
    expect(await db.eventLog.count({ where: { projectId: project.id, type: "PROJECT_PUBLISHED" } })).toBe(1);
  });

  it("A-05-T05 잘못된 모집 기간은 프로젝트 데이터 없이 거부한다", async () => {
    // 준비: 초안과 게시 서버
    const { clientId, draftId } = await makeDraft();
    const baseUrl = await startServer({ userId: clientId, role: Role.CLIENT });
    // 실행 및 확인: 모집 시작과 마감을 같은 시각으로 둔 게시 요청
    const response = await publish(baseUrl, draftId, { ...validInput, recruitStartAt: validInput.deadline });
    expect(response.status).toBe(422);
    // 확인: 프로젝트가 만들어지지 않는다
    expect(await db.project.count({ where: { draftId } })).toBe(0);
  });

  it("A-05-T06 공개 동의와 의뢰인 사업자명을 요구한다", async () => {
    // 준비: 동의를 거부한 경우, 동의 필드가 빠진 경우, 사업자명이 없는 경우의 초안과 서버
    const withoutConsent = await makeDraft();
    const baseUrl = await startServer({ userId: withoutConsent.clientId, role: Role.CLIENT });
    // 실행 및 확인: 공개 동의를 거부한 게시 요청
    expect((await publish(baseUrl, withoutConsent.draftId, { ...validInput, disclosureConsent: false })).status).toBe(422);
    expect(await db.project.count({ where: { draftId: withoutConsent.draftId } })).toBe(0);
    expect(await db.draft.findUniqueOrThrow({ where: { id: withoutConsent.draftId }, select: { status: true } })).toEqual({ status: "IN_PROGRESS" });
    expect(await db.specItem.count({ where: { project: { draftId: withoutConsent.draftId } } })).toBe(0);
    expect(await db.eventLog.count({ where: { userId: withoutConsent.clientId, type: "PROJECT_PUBLISHED" } })).toBe(0);

    // 준비: 동의 필드가 빠진 게시 입력
    const missingConsent = await makeDraft();
    const missingConsentUrl = await startServer({ userId: missingConsent.clientId, role: Role.CLIENT });
    // 실행 및 확인: 동의 필드 없이 게시 요청
    const missingConsentResponse = await publish(missingConsentUrl, missingConsent.draftId, {
      recruitStartAt: validInput.recruitStartAt,
      deadline: validInput.deadline,
      disclosureConsentVersion: validInput.disclosureConsentVersion,
      disclosureScope: validInput.disclosureScope,
    });
    expect(missingConsentResponse.status).toBe(422);
    expect(await db.project.count({ where: { draftId: missingConsent.draftId } })).toBe(0);
    expect(await db.draft.findUniqueOrThrow({ where: { id: missingConsent.draftId }, select: { status: true } })).toEqual({ status: "IN_PROGRESS" });
    expect(await db.specItem.count({ where: { project: { draftId: missingConsent.draftId } } })).toBe(0);
    expect(await db.eventLog.count({ where: { userId: missingConsent.clientId, type: "PROJECT_PUBLISHED" } })).toBe(0);

    // 준비: 사업자 프로필을 지운 의뢰인과 서버
    const withoutProfile = await makeDraft();
    await db.clientProfile.delete({ where: { userId: withoutProfile.clientId } });
    const noProfileUrl = await startServer({ userId: withoutProfile.clientId, role: Role.CLIENT });
    // 실행 및 확인: 사업자명이 없는 게시 요청
    expect((await publish(noProfileUrl, withoutProfile.draftId)).status).toBe(422);
    expect(await db.project.count({ where: { draftId: withoutProfile.draftId } })).toBe(0);
  });

  it("연결된 초안을 식별하지 못하는 동의 버전을 거부한다", async () => {
    // 준비: 초안과 게시 서버
    const { clientId, draftId } = await makeDraft();
    const baseUrl = await startServer({ userId: clientId, role: Role.CLIENT });
    // 실행: 다른 동의 버전으로 게시 요청
    const response = await publish(baseUrl, draftId, { ...validInput, disclosureConsentVersion: "v2.0" });

    // 확인: 버전 불일치로 거부되고 데이터가 남지 않는다
    expect(response.status).toBe(409);
    expect(await db.project.count({ where: { draftId } })).toBe(0);
    expect(await db.draft.findUniqueOrThrow({ where: { id: draftId }, select: { status: true } })).toEqual({ status: "IN_PROGRESS" });
    expect(await db.specItem.count({ where: { project: { draftId } } })).toBe(0);
    expect(await db.eventLog.count({ where: { userId: clientId, type: "PROJECT_PUBLISHED" } })).toBe(0);
  });

  it("모집이 이미 시작됐으면 즉시 게시한다", async () => {
    // 준비: 초안과 게시 서버
    const { clientId, draftId } = await makeDraft();
    const baseUrl = await startServer({ userId: clientId, role: Role.CLIENT });
    // 실행: 이미 지난 모집 시작 시각으로 게시 요청
    const response = await publish(baseUrl, draftId, {
      ...validInput,
      recruitStartAt: "2026-11-03T11:59:59.000Z",
    });
    // 확인: 즉시 모집 중 상태로 게시된다
    expect(response.status).toBe(201);
    expect(await db.project.findUniqueOrThrow({ where: { draftId }, select: { status: true } })).toEqual({ status: "RECRUITING" });
  });

  it("공급자 역할을 거부하고 다른 의뢰인의 초안을 숨긴다", async () => {
    // 준비: 공급자·다른 의뢰인 계정과 각 서버
    const { draftId } = await makeDraft();
    const supplierId = randomUUID();
    const otherClientId = randomUUID();
    await db.user.createMany({ data: [
      { id: supplierId, email: `a05-supplier-${supplierId}@example.invalid`, role: Role.SUPPLIER },
      { id: otherClientId, email: `a05-other-${otherClientId}@example.invalid`, role: Role.CLIENT },
    ] });
    userIds.push(supplierId, otherClientId);
    const supplierUrl = await startServer({ userId: supplierId, role: Role.SUPPLIER });
    const otherUrl = await startServer({ userId: otherClientId, role: Role.CLIENT });
    // 실행 및 확인: 공급자는 거부되고 다른 의뢰인에게는 감춘다
    expect((await publish(supplierUrl, draftId)).status).toBe(403);
    expect((await publish(otherUrl, draftId)).status).toBe(404);
  });
});
