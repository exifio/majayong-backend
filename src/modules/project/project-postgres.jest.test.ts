import { afterAll, describe, expect, it } from "@jest/globals";
import { BlockOrigin, DraftEntryType, DraftStatus, Prisma, PrismaClient, Role } from "@prisma/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createApp } from "../../app.ts";
import type { Actor } from "../identity/session.ts";
import { issueAccessToken } from "../identity/auth.ts";
import type { AuthenticatedDraftRoute } from "../draft/api.ts";
import { mountProjectApi } from "./api.ts";
import { publishDraft, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION } from "./service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test") {
  throw new Error("A-05 tests require the dedicated majayong_a00_test database");
}
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const userIds: string[] = [];
const draftIds: string[] = [];
const blockIds: string[] = [];
const servers: Server[] = [];
const now = new Date("2026-11-03T09:00:00.000Z");
const tokenSecret = "a-05-project-test-token-secret-longer-than-32-bytes";

async function makeDraft(pendingFeatures: Prisma.InputJsonValue = []): Promise<{ clientId: string; draftId: string; blockIds: string[] }> {
  const clientId = randomUUID();
  const draftId = randomUUID();
  const ids: string[] = [];
  await db.user.create({ data: { id: clientId, email: `a05-project-${clientId}@example.invalid`, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: clientId, businessName: "테스트 상호" } });
  await db.draft.create({
    data: { id: draftId, clientId, entryType: DraftEntryType.SENTENCE, hopeBudget: 500_000, pendingFeatures },
  });

  const definitions = [
    { name: "예약 달력", snapshotPrice: 1000, catalogPrice: 9000, techTags: ["react"], status: "ADDED", sortOrder: 0 },
    { name: "예약금 결제", snapshotPrice: 2000, catalogPrice: 18_000, techTags: ["payments"], status: "ADDED", sortOrder: 1 },
    { name: "제외된 기능", snapshotPrice: 3000, catalogPrice: 27_000, techTags: ["legacy"], status: "REMOVED", sortOrder: 2 },
  ] as const;
  for (const [index, definition] of definitions.entries()) {
    const blockId = randomUUID();
    await db.blockCatalog.create({
      data: {
        id: blockId,
        code: `a05-project-${blockId}`,
        name: definition.name,
        functionSummary: `${definition.name} 기능 요약`,
        description: `${definition.name} 상세 설명`,
        industryCode: "RESTAURANT",
        techTags: [...definition.techTags],
        unitPrice: definition.catalogPrice,
        priceBasis: `${definition.name} 산정 근거`,
        conditions: index === 0 ? [{ key: "refund", text: "환불 기준" }] : [],
        wireframe: { parts: [{ type: "CALENDAR", label: definition.name }] },
      },
    });
    await db.draftBlock.create({
      data: {
        draftId,
        blockId,
        origin: BlockOrigin.FIRST_SENTENCE,
        status: definition.status,
        unitPrice: definition.snapshotPrice,
        conditionNotes: index === 0 ? [{ key: "refund", note: "전날 취소", at: now.toISOString() }] : [],
        sortOrder: definition.sortOrder,
      },
    });
    ids.push(blockId);
  }
  userIds.push(clientId);
  draftIds.push(draftId);
  blockIds.push(...ids);
  return { clientId, draftId, blockIds: ids };
}

async function startProjectServer(actor: Actor): Promise<string> {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const authenticated: AuthenticatedDraftRoute = handler => (req, res, next) => {
    Promise.resolve(handler(req, res, actor)).catch(next);
  };
  mountProjectApi(router, db, () => now, () => PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, authenticated);
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

async function startCommonAppServer(projectDisclosureConsentVersion?: () => string | null): Promise<string> {
  const appOptions = { db, tokenSecret, now: () => now };
  const options = projectDisclosureConsentVersion
    ? Object.assign(appOptions, { projectDisclosureConsentVersion })
    : appOptions;
  const server = createServer(createApp(options));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind");
  servers.push(server);
  return `http://127.0.0.1:${address.port}/api/v1`;
}

const publishInput = {
  recruitStartAt: new Date("2026-11-03T09:00:00.000Z"),
  deadline: new Date("2026-11-10T09:00:00.000Z"),
  disclosureConsentVersion: PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION,
  disclosureScope: "DETAIL" as const,
  disclosureConsent: true as const,
};

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
    await db.eventLog.deleteMany({ where: { OR: [
      { draftId: { in: draftIds } },
      ...(userIds.length ? [{ userId: { in: userIds } }] : []),
    ] } });
    await db.project.deleteMany({ where: { draftId: { in: draftIds } } });
    await db.draftBlock.deleteMany({ where: { draftId: { in: draftIds } } });
    await db.clientUtterance.deleteMany({ where: { draftId: { in: draftIds } } });
    await db.draft.deleteMany({ where: { id: { in: draftIds } } });
  }
  if (blockIds.length > 0) await db.blockCatalog.deleteMany({ where: { id: { in: blockIds } } });
  if (userIds.length > 0) await db.clientProfile.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length > 0) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$executeRaw`DROP TRIGGER IF EXISTS a05_test_reject_spec_item ON spec_items`;
  await db.$executeRaw`DROP FUNCTION IF EXISTS a05_test_reject_spec_item()`;
  await db.$disconnect();
});

// 게시 API와 게시 서비스를 전용 PostgreSQL에서 검증한다.
describe("A-05 프로젝트 게시 PostgreSQL 통합", () => {
  it("공통 앱을 거쳐 프로젝트 게시를 라우팅한다", async () => {
    // 준비: 의뢰인 계정·토큰과 공통 앱 서버
    const clientId = randomUUID();
    await db.user.create({ data: { id: clientId, email: `a05-app-${clientId}@example.invalid`, role: Role.CLIENT } });
    userIds.push(clientId);
    const token = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: now.getTime() + 60_000 }, tokenSecret);
    const baseUrl = await startCommonAppServer();

    // 실행: 존재하지 않는 초안으로 게시 요청
    const response = await fetch(`${baseUrl}/drafts/${randomUUID()}/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        recruitStartAt: publishInput.recruitStartAt.toISOString(),
        deadline: publishInput.deadline.toISOString(),
        disclosureConsentVersion: PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION,
        disclosureScope: "DETAIL",
        disclosureConsent: true,
      }),
    });
    const body = await response.json() as { error?: { code?: string } };

    // 확인: 찾을 수 없음 오류로 응답한다
    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("DRAFT_NOT_FOUND");
  });

  it("인증된 HTTP로 공통 앱을 거쳐 초안을 게시한다", async () => {
    // 준비: 초안과 의뢰인 토큰
    const { clientId, draftId } = await makeDraft();
    const token = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: now.getTime() + 60_000 }, tokenSecret);
    const baseUrl = await startCommonAppServer(() => PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION);
    // 실행: 인증된 게시 요청
    const response = await fetch(`${baseUrl}/drafts/${draftId}/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        recruitStartAt: publishInput.recruitStartAt.toISOString(),
        deadline: publishInput.deadline.toISOString(),
        disclosureConsentVersion: PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION,
        disclosureScope: "DETAIL",
        disclosureConsent: true,
      }),
    });
    const body = await response.json() as { data?: { itemCount?: number } };

    // 확인: 게시 응답과 저장된 프로젝트·명세 상태
    expect(response.status).toBe(201);
    expect(body.data?.itemCount).toBe(2);
    const project = await db.project.findUniqueOrThrow({ where: { draftId } });
    expect(await db.eventLog.count({ where: { projectId: project.id, type: "SPEC_CONFIRMED" } })).toBe(1);
    expect(project.disclosureConsentVersion).toBe("project-disclosure-v0.1-draft");
    expect(await db.draft.findUniqueOrThrow({ where: { id: draftId }, select: { status: true } })).toEqual({ status: DraftStatus.CONFIRMED });
    expect(await db.specItem.count({ where: { projectId: project.id, versionNo: 1 } })).toBe(2);
  });

  it("A-05-T04 중복 게시를 직렬화하고 선택된 모든 행을 버전 1로 복사한다", async () => {
    // 준비: 게시 대상 초안
    const { clientId, draftId } = await makeDraft();
    // 실행: 같은 초안에 동시 게시 두 번
    const outcomes = await Promise.allSettled([
      publishDraft(db, draftId, clientId, publishInput, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, now),
      publishDraft(db, draftId, clientId, publishInput, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, now),
    ]);
    // 확인: 하나만 성공하고 프로젝트·명세·이벤트가 한 번만 남는다
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);

    const project = await db.project.findUniqueOrThrow({ where: { draftId } });
    expect(await db.eventLog.count({ where: { projectId: project.id, type: "SPEC_CONFIRMED" } })).toBe(1);
    const items = await db.specItem.findMany({ where: { projectId: project.id }, orderBy: { sortOrder: "asc" } });
    expect(project).toMatchObject({
      currentVersion: 1,
      status: "RECRUITING",
      title: "예약 달력, 예약금 결제",
      disclosureConsentVersion: PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION,
    });
    expect(project.requiredSkills).toEqual(["react", "payments"]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      versionNo: 1,
      blockId: (await db.draftBlock.findFirstOrThrow({ where: { draftId, sortOrder: 0 }, select: { blockId: true } })).blockId,
      title: "예약 달력",
      description: "예약 달력 상세 설명",
      origin: "FIRST_SENTENCE",
      unitPrice: 1000,
      status: "INCLUDED",
      conditions: [{ key: "refund", text: "환불 기준", note: "전날 취소" }],
      wireframe: { parts: [{ type: "CALENDAR", label: "예약 달력" }] },
    });
    expect(items.map(item => item.unitPrice)).toEqual([1000, 2000]);
    expect(await db.eventLog.count({ where: { projectId: project.id, type: "PROJECT_PUBLISHED" } })).toBe(1);
  });

  it("A-05-T04 SpecItem 삽입이 실패하면 Project·Draft 변경을 롤백한다", async () => {
    // 준비: 초안과 명세 삽입을 강제로 실패시키는 트리거
    const { clientId, draftId } = await makeDraft();
    await db.$executeRaw`DROP TRIGGER IF EXISTS a05_test_reject_spec_item ON spec_items`;
    await db.$executeRaw`DROP FUNCTION IF EXISTS a05_test_reject_spec_item()`;
    await db.$executeRaw`CREATE FUNCTION a05_test_reject_spec_item() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'A05_TEST_SPECITEM_FAILURE'; END;
    $$ LANGUAGE plpgsql`;
    await db.$executeRaw`CREATE TRIGGER a05_test_reject_spec_item BEFORE INSERT ON spec_items
      FOR EACH ROW EXECUTE FUNCTION a05_test_reject_spec_item()`;
    // 실행 및 확인: 게시가 실패해야 한다
    try {
      await expect(publishDraft(db, draftId, clientId, publishInput, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, now)).rejects.toThrow();
    } finally {
      await db.$executeRaw`DROP TRIGGER IF EXISTS a05_test_reject_spec_item ON spec_items`;
      await db.$executeRaw`DROP FUNCTION IF EXISTS a05_test_reject_spec_item()`;
    }
    // 확인: 프로젝트·초안 변경이 롤백된다
    expect(await db.project.findUnique({ where: { draftId } })).toBeNull();
    expect(await db.draft.findUniqueOrThrow({ where: { id: draftId }, select: { status: true } })).toEqual({ status: DraftStatus.IN_PROGRESS });
  });

  it("A-05-T05 모집 시작이 마감 전이 아니면 거부한다", async () => {
    // 준비: 게시 대상 초안
    const { clientId, draftId } = await makeDraft();
    // 실행 및 확인: 모집 시작과 마감을 같은 시각으로 둔 게시 요청
    await expect(publishDraft(db, draftId, clientId, {
      ...publishInput,
      recruitStartAt: publishInput.deadline,
    }, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, now)).rejects.toMatchObject({ code: "INVALID_RECRUITMENT_PERIOD", status: 422 });
    // 확인: 프로젝트가 만들어지지 않는다
    expect(await db.project.findUnique({ where: { draftId } })).toBeNull();
  });

  it("A-05-T06 게시 전에 활성 공개 동의 버전을 요구한다", async () => {
    // 준비: 게시 대상 초안
    const { clientId, draftId } = await makeDraft();
    // 실행 및 확인: 동의 버전을 비운 게시 요청
    await expect(publishDraft(db, draftId, clientId, {
      ...publishInput,
      disclosureConsentVersion: "",
    }, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, now)).rejects.toMatchObject({ code: "DISCLOSURE_CONSENT_REQUIRED", status: 422 });
    // 확인: 프로젝트가 만들어지지 않는다
    expect(await db.project.findUnique({ where: { draftId } })).toBeNull();
  });

  it("초안 동의 버전이 설정되지 않으면 닫힌 상태로 실패한다", async () => {
    // 준비: 게시 대상 초안
    const { clientId, draftId } = await makeDraft();
    // 실행 및 확인: 동의 버전이 없거나 다른 값이면 실패한다
    await expect(publishDraft(db, draftId, clientId, publishInput, null, now))
      .rejects.toMatchObject({ code: "DISCLOSURE_CONSENT_UNAVAILABLE", status: 503 });
    await expect(publishDraft(db, draftId, clientId, publishInput, "v2.0", now))
      .rejects.toMatchObject({ code: "DISCLOSURE_CONSENT_VERSION_MISMATCH", status: 409 });
    // 확인: 프로젝트가 없고 초안은 진행 중으로 남는다
    expect(await db.project.findUnique({ where: { draftId } })).toBeNull();
    expect(await db.draft.findUniqueOrThrow({ where: { id: draftId }, select: { status: true } })).toEqual({ status: "IN_PROGRESS" });
  });

  it("POST /publish에서 공개에 안전한 프로젝트 요약만 반환한다", async () => {
    // 준비: 초안과 전용 라우터 서버
    const { clientId, draftId } = await makeDraft();
    const baseUrl = await startProjectServer({ userId: clientId, role: Role.CLIENT });
    // 실행: 게시 요청
    const response = await fetch(`${baseUrl}/drafts/${draftId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recruitStartAt: publishInput.recruitStartAt.toISOString(),
        deadline: publishInput.deadline.toISOString(),
        disclosureConsentVersion: PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION,
        disclosureScope: "DETAIL",
        disclosureConsent: true,
      }),
    });
    const body = await response.text();

    // 확인: 제목만 담기고 단가·합계·수수료는 응답에 없다
    expect(response.status).toBe(201);
    expect(body).toContain('"title":"예약 달력, 예약금 결제"');
    expect(body).not.toContain("unitPrice");
    expect(body).not.toContain("estimatedTotal");
    expect(body).not.toContain("clientFee");
  });

  it("초과 기능 개수를 포함해 프로젝트 제목을 조립한다", async () => {
    // 준비: 제외 기능까지 포함해 초안을 구성한다
    const { clientId, draftId } = await makeDraft();
    // 실행: 모든 기능을 포함 상태로 바꾸고 게시
    await db.draftBlock.updateMany({ where: { draftId }, data: { status: "ADDED" } });
    const project = await publishDraft(db, draftId, clientId, publishInput, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, now);
    // 확인: 두 기능만 나열하고 나머지는 개수로 요약한다
    expect(project.title).toBe("예약 달력, 예약금 결제 외 1개 기능");
    expect(project.itemCount).toBe(3);
  });

  it("생성 기능이 대기 중이면 초안을 게시하지 않는다", async () => {
    // 준비: 대기 중인 생성 기능이 있는 초안
    const { clientId, draftId } = await makeDraft([{ key: "pending", summary: "회원 알림", attempts: 1, lastTriedAt: null }]);
    // 실행 및 확인: 게시 요청이 대기 기능 오류로 거부된다
    await expect(publishDraft(db, draftId, clientId, publishInput, PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION, now))
      .rejects.toMatchObject({ code: "DRAFT_FEATURES_PENDING", status: 409 });
    // 확인: 프로젝트가 만들어지지 않는다
    expect(await db.project.findUnique({ where: { draftId } })).toBeNull();
  });
});
