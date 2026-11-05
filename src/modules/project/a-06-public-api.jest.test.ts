import { afterAll, describe, expect, it, jest } from "@jest/globals";
import { BlockOrigin, DraftEntryType, PrismaClient, ProjectStatus, Role, SpecItemStatus } from "@prisma/client";
import express, { type NextFunction, type Request, type Response as ExpressResponse } from "express";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createApp } from "../../app.ts";
import type { AuthenticatedDraftRoute } from "../draft/api.ts";
import { issueAccessToken } from "../identity/auth.ts";
import type { Actor } from "../identity/session.ts";
import { mountProjectApi } from "./api.ts";
import type { ProjectPorts } from "./ports.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("A-06 tests require the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const now = new Date("2026-11-03T09:00:00.000Z");
const futureDeadline = new Date("2026-11-10T09:00:00.000Z");
const servers: Server[] = [];
const userIds: string[] = [];
const draftIds: string[] = [];
const projectIds: string[] = [];
const blockIds: string[] = [];

const nda = "nda-v1";
const tokenSecret = "a-06-http-test-token-secret-longer-than-32-bytes";

const authenticated: AuthenticatedDraftRoute = handler => (req, res, next) => {
  const userId = req.header("x-actor-id") ?? "";
  const role = (req.header("x-actor-role") as Role | undefined) ?? Role.CLIENT;
  Promise.resolve(handler(req, res, { userId, role })).catch(next);
};

async function startServer(ports: ProjectPorts): Promise<string> {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountProjectApi(router, db, () => now, () => "project-disclosure-v0.1-draft", authenticated, ports);
  app.use("/api/v1", router);
  app.use((error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "INTERNAL_ERROR" });
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind");
  servers.push(server);
  return `http://127.0.0.1:${address.port}/api/v1`;
}

function request(baseUrl: string, method: string, path: string, actor: Actor, body?: unknown): Promise<globalThis.Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "x-actor-id": actor.userId,
      "x-actor-role": actor.role,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function makeClient(): Promise<Actor> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `a06h-${id}@example.invalid`, name: "김의뢰", role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: id, businessName: "카페 블루", profileCompleted: true } });
  return { userId: id, role: Role.CLIENT };
}

async function makeSupplier(): Promise<Actor> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `a06h-sup-${id}@example.invalid`, role: Role.SUPPLIER } });
  await db.supplierProfile.create({ data: { userId: id, displayName: "공급자", ndaAgreedAt: now, ndaVersion: nda } });
  return { userId: id, role: Role.SUPPLIER };
}

async function makeProject(clientId: string, status: ProjectStatus = ProjectStatus.RECRUITING): Promise<string> {
  const draftId = randomUUID();
  const projectId = randomUUID();
  draftIds.push(draftId);
  projectIds.push(projectId);
  await db.draft.create({ data: { id: draftId, clientId, entryType: DraftEntryType.SENTENCE } });
  await db.project.create({
    data: {
      id: projectId, draftId, confirmedAt: now, disclosureConsentVersion: "v1", title: "예약 달력 외 1개 기능",
      summary: "예약 관련 기능", industryCode: "RESTAURANT", requiredSkills: ["react"], hopeBudget: 4_000_000,
      deadline: futureDeadline, status,
    },
  });
  return projectId;
}

async function addSpecItem(projectId: string, versionNo: number): Promise<void> {
  const blockId = randomUUID();
  blockIds.push(blockId);
  await db.blockCatalog.create({
    data: {
      id: blockId, code: `a06h-${blockId}`, name: "예약 달력", functionSummary: "예약 달력", description: "예약 달력 설명",
      industryCode: "RESTAURANT", unitPrice: 100_000, priceBasis: "범위\n가정\n추정", conditions: [{ key: "k", text: "조건" }],
      wireframe: { parts: [{ type: "TEXT" }] },
    },
  });
  await db.specItem.create({
    data: {
      projectId, versionNo, blockId, title: "예약 달력", description: "예약 달력 설명", origin: BlockOrigin.FIRST_SENTENCE,
      status: SpecItemStatus.INCLUDED, unitPrice: 100_000, conditions: [{ key: "k", text: "조건" }], sortOrder: 0,
    },
  });
}

afterAll(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  if (projectIds.length) await db.eventLog.deleteMany({ where: { projectId: { in: projectIds } } });
  if (projectIds.length) await db.specItem.deleteMany({ where: { projectId: { in: projectIds } } });
  if (projectIds.length) await db.project.deleteMany({ where: { id: { in: projectIds } } });
  if (draftIds.length) await db.draft.deleteMany({ where: { id: { in: draftIds } } });
  if (blockIds.length) await db.blockCatalog.deleteMany({ where: { id: { in: blockIds } } });
  if (userIds.length) await db.clientProfile.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length) await db.supplierProfile.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

// 프로젝트 HTTP API의 응답과 권한 차단을 전용 PostgreSQL에서 검증한다.
describe("A-06 프로젝트 HTTP API", () => {
  it("의뢰인 본인의 프로젝트 목록을 제공한다", async () => {
    // 준비: 명세가 있는 의뢰인 프로젝트와 서버
    const client = await makeClient();
    const projectId = await makeProject(client.userId);
    await addSpecItem(projectId, 1);
    const baseUrl = await startServer({});
    // 실행: 내 프로젝트 목록 조회
    const response = await request(baseUrl, "GET", "/me/projects", client);
    // 확인: 현재 버전이 담긴 카드가 반환된다
    expect(response.status).toBe(200);
    const data = (await response.json() as { data: Array<{ projectId: string; currentVersion: number }> }).data;
    expect(data.find(row => row.projectId === projectId)).toMatchObject({ projectId, currentVersion: 1 });
  });

  it("검색 포트로 공개 목록을 정확히 한 번 제공하고 의뢰인을 차단한다", async () => {
    // 준비: 의뢰인·공급자·프로젝트와 검색 포트
    const client = await makeClient();
    const supplier = await makeSupplier();
    const projectId = await makeProject(client.userId);
    await addSpecItem(projectId, 1);
    const searchPublicProjects = jest.fn(async () => ({ projectIds: [projectId], total: 1 }));
    const baseUrl = await startServer({ search: { searchPublicProjects } });

    // 실행 및 확인: 의뢰인의 공개 목록 접근은 거부된다
    const forbidden = await request(baseUrl, "GET", "/projects", client);
    expect(forbidden.status).toBe(403);

    // 실행: 공급자의 공개 목록 조회
    const response = await request(baseUrl, "GET", "/projects?industryCode=RESTAURANT&page=1", supplier);
    // 확인: 페이지 메타와 공개 필드만 담긴다
    expect(response.status).toBe(200);
    const body = (await response.json() as { data: Array<Record<string, unknown>>; meta: { page: number; pageSize: number; total: number } });
    expect(searchPublicProjects).toHaveBeenCalledTimes(1);
    expect(body.meta).toEqual({ page: 1, pageSize: 10, total: 1 });
    expect(body.data[0]).toMatchObject({ projectId, itemCount: 1, hopeBudgetBand: "400~500만원" });
    expect(JSON.stringify(body.data)).not.toContain("4000000");
    expect(body.data[0]).not.toHaveProperty("hopeBudget");
  });

  it("검색 포트가 연결되지 않으면 공개 목록은 닫힌 상태로 실패한다", async () => {
    // 준비: 검색 포트 없이 띄운 서버
    const supplier = await makeSupplier();
    const baseUrl = await startServer({});
    // 실행 및 확인: 공개 목록은 사용 불가로 응답한다
    const response = await request(baseUrl, "GET", "/projects", supplier);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("PROJECT_SEARCH_UNAVAILABLE");
  });

  it("NDA 후 공개 상세를 제공하고 최초 조회를 정확히 한 번 기록한다", async () => {
    // 준비: NDA 공급자와 상세 조회 포트
    const client = await makeClient();
    const supplier = await makeSupplier();
    const projectId = await makeProject(client.userId);
    await addSpecItem(projectId, 1);
    const recordFirstView = jest.fn(async () => undefined);
    const baseUrl = await startServer({ supplierNdaVersion: nda, view: { recordFirstView } });

    // 실행: 공급자의 공개 상세 조회
    const response = await request(baseUrl, "GET", `/projects/${projectId}`, supplier);
    // 확인: 최초 조회 1회 기록과 공개 필드만 담긴 상세
    expect(response.status).toBe(200);
    expect(recordFirstView).toHaveBeenCalledTimes(1);
    const data = (await response.json() as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ projectId, hopeBudget: 4_000_000 });
    expect(data).not.toHaveProperty("unitPrice");
    expect(JSON.stringify(data)).not.toContain("clientFee");
  });

  it("HTTP로 명세를 수정하고 공급자를 차단한다", async () => {
    // 준비: 버전 1 명세와 수정 입력·지원 포트
    const client = await makeClient();
    const supplier = await makeSupplier();
    const projectId = await makeProject(client.userId);
    await addSpecItem(projectId, 1);
    const items = (await db.specItem.findMany({ where: { projectId, versionNo: 1 } })).map(item => ({
      blockId: item.blockId, title: item.title, description: "고친 설명", conditions: [{ key: "k", text: "조건" }], sortOrder: 0,
    }));
    const markSpecStale = jest.fn(async () => 0);
    const baseUrl = await startServer({ application: { countPending: jest.fn(async () => 0), markSpecStale, rejectPendingOnDelete: jest.fn(async () => 0) } });

    // 실행 및 확인: 공급자의 명세 수정은 거부된다
    const denied = await request(baseUrl, "PATCH", `/projects/${projectId}/spec`, supplier, { items });
    expect(denied.status).toBe(403);

    // 실행: 의뢰인의 명세 수정
    const response = await request(baseUrl, "PATCH", `/projects/${projectId}/spec`, client, { items });
    // 확인: 버전 2가 만들어지고 지원자 만료가 한 번 호출된다
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { currentVersion: number } }).data).toEqual({ projectId, currentVersion: 2, itemCount: 1 });
    expect(markSpecStale).toHaveBeenCalledTimes(1);
  });

  it("마감을 연장하고 상한 초과 값을 거부한다", async () => {
    // 준비: 프로젝트와 알림 포트가 연결된 서버
    const client = await makeClient();
    const projectId = await makeProject(client.userId);
    const baseUrl = await startServer({ notification: { enqueue: jest.fn(async () => undefined) } });

    // 실행 및 확인: 15일 연장은 상한 초과로 거부된다
    const overCap = await request(baseUrl, "POST", `/projects/${projectId}/extend-deadline`, client, {
      deadline: new Date(futureDeadline.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(overCap.status).toBe(422);

    // 실행: 3일 연장
    const ok = await request(baseUrl, "POST", `/projects/${projectId}/extend-deadline`, client, {
      deadline: new Date(futureDeadline.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    // 확인: 모집 중 상태로 응답한다
    expect(ok.status).toBe(200);
    expect((await ok.json() as { data: { status: ProjectStatus } }).data.status).toBe(ProjectStatus.RECRUITING);
  });

  it("HTTP로 소유자의 프로젝트를 소프트 삭제한다", async () => {
    // 준비: 프로젝트와 지원 포트가 연결된 서버
    const client = await makeClient();
    const projectId = await makeProject(client.userId);
    const rejectPendingOnDelete = jest.fn(async () => 0);
    const baseUrl = await startServer({ application: { countPending: jest.fn(async () => 0), markSpecStale: jest.fn(async () => 0), rejectPendingOnDelete } });
    // 실행: 소프트 삭제 요청
    const response = await request(baseUrl, "DELETE", `/projects/${projectId}`, client);
    // 확인: 삭제 시각이 기록되고 대기 지원 거절이 호출된다
    expect(response.status).toBe(200);
    expect(rejectPendingOnDelete).toHaveBeenCalledTimes(1);
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ deletedAt: now });
  });
});

// 공통 앱이 프로젝트 라우터를 어떤 포트로 연결하는지 검증한다.
describe("A-06 공통 앱 연결", () => {
  it("createApp으로 #044~#049를 노출하고 포트가 없으면 닫힌 상태로 실패한다", async () => {
    // 준비: 포트 없이 만든 공통 앱과 의뢰인·공급자 토큰
    const client = await makeClient();
    const supplier = await makeSupplier();
    const projectId = await makeProject(client.userId);

    const server = createServer(createApp({ db, tokenSecret, now: () => now }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    const clientToken = issueAccessToken({ userId: client.userId, role: Role.CLIENT, expiresAt: now.getTime() + 60_000 }, tokenSecret);
    const supplierToken = issueAccessToken({ userId: supplier.userId, role: Role.SUPPLIER, expiresAt: now.getTime() + 60_000 }, tokenSecret);

    const mine = await fetch(`${baseUrl}/me/projects`, { headers: { authorization: `Bearer ${clientToken}` } });
    expect(mine.status).toBe(200);

    // 실행 및 확인: 검색 포트가 없으면 공개 목록은 503
    const list = await fetch(`${baseUrl}/projects`, { headers: { authorization: `Bearer ${supplierToken}` } });
    expect(list.status).toBe(503);

    // 실행 및 확인: NDA 조회 포트가 없으면 상세는 503
    const detail = await fetch(`${baseUrl}/projects/${projectId}`, { headers: { authorization: `Bearer ${supplierToken}` } });
    expect(detail.status).toBe(503);

    // 실행 및 확인: 지원 포트가 없으면 삭제는 503
    const softDelete = await fetch(`${baseUrl}/projects/${projectId}`, { method: "DELETE", headers: { authorization: `Bearer ${clientToken}` } });
    expect(softDelete.status).toBe(503);
  });

  it("A-06-T05/T06 제공되면 createApp에서 조회·지원 포트를 주입한다", async () => {
    // 준비: 조회·지원 포트를 주입한 공통 앱과 공급자 토큰
    const client = await makeClient();
    const supplier = await makeSupplier();
    const projectId = await makeProject(client.userId);
    await addSpecItem(projectId, 1);
    const recordFirstView = jest.fn(async () => undefined);
    const rejectPendingOnDelete = jest.fn(async () => 0);

    const server = createServer(createApp({
      db, tokenSecret, now: () => now,
      project: {
        supplierNdaVersion: nda,
        view: { recordFirstView },
        application: { countPending: jest.fn(async () => 0), markSpecStale: jest.fn(async () => 0), rejectPendingOnDelete },
      },
    }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    const supplierToken = issueAccessToken({ userId: supplier.userId, role: Role.SUPPLIER, expiresAt: now.getTime() + 60_000 }, tokenSecret);
    // 실행: 주입된 NDA 조회 포트로 상세 조회
    const detail = await fetch(`${baseUrl}/projects/${projectId}`, { headers: { authorization: `Bearer ${supplierToken}` } });
    // 확인: 상세가 열리고 최초 조회가 한 번 기록된다
    expect(detail.status).toBe(200);
    expect(recordFirstView).toHaveBeenCalledTimes(1);

    const clientToken = issueAccessToken({ userId: client.userId, role: Role.CLIENT, expiresAt: now.getTime() + 60_000 }, tokenSecret);
    // 실행: 주입된 지원 포트로 소프트 삭제
    const softDelete = await fetch(`${baseUrl}/projects/${projectId}`, { method: "DELETE", headers: { authorization: `Bearer ${clientToken}` } });
    // 확인: 삭제가 처리되고 대기 지원 거절이 호출된다
    expect(softDelete.status).toBe(200);
    expect(rejectPendingOnDelete).toHaveBeenCalledTimes(1);
  });
});
