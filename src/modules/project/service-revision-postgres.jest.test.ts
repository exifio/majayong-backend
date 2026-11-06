import { afterAll, describe, expect, it, jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import {
  BlockOrigin, DraftEntryType, EventType, PrismaClient, ProjectStatus, Role, SpecItemStatus,
} from "@prisma/client";
import {
  extendDeadline, getPublicProjectDetail, listMyProjects, listPublicProjects, reviseSpec,
  runProjectDeadlineBatch, softDeleteProject, type SpecRevisionItem,
} from "./service.ts";
import { createProjectOutputPorts, type ProjectPorts } from "./ports.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("A-06 tests require the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const now = new Date("2026-11-03T09:00:00.000Z");
const futureDeadline = new Date("2026-11-10T09:00:00.000Z");
const pastDeadline = new Date("2026-11-02T09:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const userIds: string[] = [];
const draftIds: string[] = [];
const projectIds: string[] = [];
const blockIds: string[] = [];

async function makeClient(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `a06-${id}@example.invalid`, name: "김의뢰", role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: id, businessName: "카페 블루", industryField: "카페", storeAddress: "서울 마포구 월드컵로 12", profileCompleted: true } });
  return id;
}

async function makeSupplier(ndaVersion: string | null = "nda-v1"): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `a06-sup-${id}@example.invalid`, role: Role.SUPPLIER } });
  await db.supplierProfile.create({ data: { userId: id, displayName: "공급자", ndaAgreedAt: ndaVersion ? now : null, ndaVersion } });
  return id;
}

async function makeProject(clientId: string, overrides: {
  status?: ProjectStatus; deadline?: Date | null; selectionEndsAt?: Date | null; recruitStartAt?: Date | null;
} = {}): Promise<string> {
  const draftId = randomUUID();
  const projectId = randomUUID();
  draftIds.push(draftId);
  projectIds.push(projectId);
  await db.draft.create({ data: { id: draftId, clientId, entryType: DraftEntryType.SENTENCE } });
  await db.project.create({
    data: {
      id: projectId, draftId, confirmedAt: now, disclosureConsentVersion: "v1", title: "예약 달력 외 2개 기능",
      summary: "예약 관련 기능", industryCode: "RESTAURANT", requiredSkills: ["react"], hopeBudget: 4_000_000,
      deadline: overrides.deadline === undefined ? futureDeadline : overrides.deadline,
      recruitStartAt: overrides.recruitStartAt ?? null,
      selectionEndsAt: overrides.selectionEndsAt ?? null,
      status: overrides.status ?? ProjectStatus.RECRUITING,
    },
  });
  return projectId;
}

async function addSpecItems(projectId: string, versionNo: number, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const blockId = randomUUID();
    blockIds.push(blockId);
    await db.blockCatalog.create({
      data: {
        id: blockId, code: `a06-${blockId}`, name: `기능 ${index}`, functionSummary: `기능 ${index}`,
        description: `기능 ${index} 설명`, industryCode: "RESTAURANT", unitPrice: 100_000, priceBasis: "범위\n가정\n추정",
        conditions: [{ key: "k", text: "조건" }], wireframe: { parts: [{ type: "TEXT" }] },
      },
    });
    await db.specItem.create({
      data: {
        projectId, versionNo, blockId, title: `기능 ${index}`, description: `기능 ${index} 설명`,
        origin: BlockOrigin.FIRST_SENTENCE, status: SpecItemStatus.INCLUDED, unitPrice: 100_000,
        conditions: [{ key: "k", text: "조건" }], wireframe: { parts: [{ type: "TEXT" }] }, sortOrder: index,
      },
    });
  }
}

async function currentItems(projectId: string): Promise<SpecRevisionItem[]> {
  const rows = await db.specItem.findMany({ where: { projectId, versionNo: 1 }, orderBy: { sortOrder: "asc" } });
  return rows.map(row => ({ blockId: row.blockId, title: row.title, description: row.description, conditions: row.conditions ?? undefined, sortOrder: row.sortOrder }));
}

function applicationPort(overrides: Partial<{ countPending: number; markSpecStale: number; rejectPendingOnDelete: number }> = {}) {
  return {
    countPending: jest.fn(async (_tx: import("@prisma/client").Prisma.TransactionClient, _projectId: string) => overrides.countPending ?? 0),
    markSpecStale: jest.fn(async (_tx: import("@prisma/client").Prisma.TransactionClient, _input: { projectId: string; newVersionNo: number; at: Date }) => overrides.markSpecStale ?? 0),
    rejectPendingOnDelete: jest.fn(async (_tx: import("@prisma/client").Prisma.TransactionClient, _input: { projectId: string; at: Date }) => overrides.rejectPendingOnDelete ?? 0),
  };
}

function notificationPort() {
  return { enqueue: jest.fn(async (_tx: import("@prisma/client").Prisma.TransactionClient, _input: { userId: string; type: "PROJECT_CLOSED"; projectId: string; at: Date }) => undefined) };
}

afterAll(async () => {
  if (projectIds.length) await db.eventLog.deleteMany({ where: { projectId: { in: projectIds } } });
  if (userIds.length) await db.eventLog.deleteMany({ where: { userId: { in: userIds } } });
  if (projectIds.length) await db.specItem.deleteMany({ where: { projectId: { in: projectIds } } });
  if (projectIds.length) await db.application.deleteMany({ where: { projectId: { in: projectIds } } });
  if (projectIds.length) await db.project.deleteMany({ where: { id: { in: projectIds } } });
  if (draftIds.length) await db.draft.deleteMany({ where: { id: { in: draftIds } } });
  if (blockIds.length) await db.blockCatalog.deleteMany({ where: { id: { in: blockIds } } });
  if (userIds.length) await db.clientProfile.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length) await db.supplierProfile.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

// 프로젝트 명세 수정·마감 배치·조회 표면·출력 포트를 전용 PostgreSQL에서 검증한다.
describe("A-06 명세 수정", () => {
  it("A-06-T01 현재 명세 항목을 새 버전으로 복사하고 지원자를 만료 처리한다", async () => {
    // 준비: 의뢰인·프로젝트·버전 1 명세와 지원 포트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId);
    await addSpecItems(projectId, 1, 3);
    const port = applicationPort({ markSpecStale: 2 });
    const ports: ProjectPorts = { application: port };

    // 실행: 현재 명세로 명세 수정
    const result = await reviseSpec(db, ports, projectId, clientId, { items: await currentItems(projectId) }, now);

    // 확인: 버전 2 명세와 지원자 만료·이벤트 기록
    expect(result).toEqual({ projectId, currentVersion: 2, itemCount: 3 });
    expect(await db.specItem.count({ where: { projectId, versionNo: 2 } })).toBe(3);
    expect((await db.specItem.findMany({ where: { projectId, versionNo: 2 } })).every(item => item.unitPrice === 100_000)).toBe(true);
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ currentVersion: 2, status: ProjectStatus.RECRUITING });
    expect(port.markSpecStale).toHaveBeenCalledTimes(1);
    expect(port.markSpecStale.mock.calls[0]?.[1]).toMatchObject({ projectId, newVersionNo: 2 });
    expect(await db.eventLog.count({ where: { projectId, type: EventType.SPEC_REVISED } })).toBe(1);
  });

  it("A-06-T01 프로젝트가 수락·계약되면 명세 수정을 거부한다", async () => {
    // 준비: 수락 상태 프로젝트와 버전 1 명세
    const clientId = await makeClient();
    const accepted = await makeProject(clientId, { status: ProjectStatus.ACCEPTED });
    await addSpecItems(accepted, 1, 1);
    const ports: ProjectPorts = { application: applicationPort() };
    // 실행 및 확인: 수락된 프로젝트의 명세 수정은 거부된다
    await expect(reviseSpec(db, ports, accepted, clientId, { items: await currentItems(accepted) }, now))
      .rejects.toMatchObject({ code: "PROJECT_SPEC_LOCKED", status: 409 });
    // 확인: 버전 2 명세가 만들어지지 않는다
    expect(await db.specItem.count({ where: { projectId: accepted, versionNo: 2 } })).toBe(0);
  });

  it("소유자가 아니면 명세를 수정하지 못한다", async () => {
    // 준비: 다른 의뢰인의 프로젝트와 명세
    const clientId = await makeClient();
    const stranger = await makeClient();
    const projectId = await makeProject(clientId);
    await addSpecItems(projectId, 1, 1);
    // 실행 및 확인: 소유자가 아닌 의뢰인의 명세 수정은 찾을 수 없음으로 거부된다
    await expect(reviseSpec(db, { application: applicationPort() }, projectId, stranger, { items: await currentItems(projectId) }, now))
      .rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
  });
});

// 마감 배치가 프로젝트 상태와 알림을 어떻게 바꾸는지 검증한다.
describe("A-06 마감 배치", () => {
  it("A-06-T04 지원자가 있으면 7일 창으로 SELECTING 처리한다", async () => {
    // 준비: 마감이 지난 프로젝트와 대기 지원 수
    const clientId = await makeClient();
    const projectId = await makeProject(clientId, { deadline: pastDeadline });
    const port = applicationPort({ countPending: 3 });

    // 실행: 마감 배치 실행
    const result = await runProjectDeadlineBatch(db, { application: port, notification: notificationPort() }, now);

    // 확인: 선택 중 상태와 7일 뒤 선택 종료 시각
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe(ProjectStatus.SELECTING);
    expect(project.selectionEndsAt?.getTime()).toBe(now.getTime() + 7 * day);
    expect(result.selecting).toBeGreaterThanOrEqual(1);
  });

  it("A-06-T04 대기 지원자가 없으면 EXPIRED 처리한다", async () => {
    // 준비: 마감이 지난 프로젝트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId, { deadline: pastDeadline });
    // 실행: 대기 지원자가 0인 마감 배치
    await runProjectDeadlineBatch(db, { application: applicationPort({ countPending: 0 }), notification: notificationPort() }, now);
    // 확인: 만료 상태가 되고 선택 종료 시각이 없다
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ status: ProjectStatus.EXPIRED, selectionEndsAt: null });
  });

  it("A-06-T05 SELECTING 프로젝트를 EXPIRED로 옮기고 대기 지원자를 거절한다", async () => {
    // 준비: 선택 기간이 지난 프로젝트와 지원 포트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId, { status: ProjectStatus.SELECTING, selectionEndsAt: pastDeadline });
    const port = applicationPort({ rejectPendingOnDelete: 2 });
    // 실행: 마감 배치 실행
    await runProjectDeadlineBatch(db, { application: port, notification: notificationPort() }, now);
    // 확인: 만료 처리와 대기 지원 거절 호출
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ status: ProjectStatus.EXPIRED });
    expect(port.rejectPendingOnDelete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ projectId }));
  });

  it("A-06-T06 수락·계약된 프로젝트는 건드리지 않는다", async () => {
    // 준비: 수락·계약 상태이면서 마감이 지난 프로젝트
    const clientId = await makeClient();
    const accepted = await makeProject(clientId, { deadline: pastDeadline, status: ProjectStatus.ACCEPTED });
    const contracted = await makeProject(clientId, { deadline: pastDeadline, status: ProjectStatus.CONTRACTED });
    const port = applicationPort({ countPending: 5 });
    // 실행: 마감 배치 실행
    await runProjectDeadlineBatch(db, { application: port, notification: notificationPort() }, now);
    // 확인: 두 프로젝트 상태가 그대로 유지된다
    expect(await db.project.findUniqueOrThrow({ where: { id: accepted } })).toMatchObject({ status: ProjectStatus.ACCEPTED });
    expect(await db.project.findUniqueOrThrow({ where: { id: contracted } })).toMatchObject({ status: ProjectStatus.CONTRACTED });
  });

  it("A-06-T07 반복 실행에도 멱등하며 알림을 중복하지 않는다", async () => {
    // 준비: 마감이 지난 프로젝트와 알림 포트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId, { deadline: pastDeadline });
    const port = applicationPort({ countPending: 0 });
    const enqueue = notificationPort().enqueue;
    // 실행: 같은 시각으로 마감 배치를 두 번 실행
    const first = await runProjectDeadlineBatch(db, { application: port, notification: { enqueue } }, now);
    const second = await runProjectDeadlineBatch(db, { application: port, notification: { enqueue } }, now);
    // 확인: 두 번째 실행은 아무것도 바꾸지 않는다
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ status: ProjectStatus.EXPIRED });
    expect(second.recruiting).toBe(0);
    expect(second.selecting).toBe(0);
    expect(second.expired).toBe(0);
    expect(first.expired).toBeGreaterThanOrEqual(1);
  });

  it("A-06-T03 예약 프로젝트는 시작 시간 이후에만 모집 중으로 승격한다", async () => {
    // 준비: 시작 시간이 남은 예약 프로젝트와 이미 지난 예약 프로젝트
    const clientId = await makeClient();
    const future = await makeProject(clientId, { status: ProjectStatus.SCHEDULED, recruitStartAt: new Date(now.getTime() + day) });
    const due = await makeProject(clientId, { status: ProjectStatus.SCHEDULED, recruitStartAt: new Date(now.getTime() - day) });
    // 실행: 마감 배치 실행
    await runProjectDeadlineBatch(db, { application: applicationPort(), notification: notificationPort() }, now);
    // 확인: 시작 시간이 지난 프로젝트만 모집 중이 된다
    expect(await db.project.findUniqueOrThrow({ where: { id: future } })).toMatchObject({ status: ProjectStatus.SCHEDULED });
    expect(await db.project.findUniqueOrThrow({ where: { id: due } })).toMatchObject({ status: ProjectStatus.RECRUITING });
  });
});

// 목록·상세·삭제처럼 조회 표면에서 노출되는 값을 검증한다.
describe("A-06 조회 표면", () => {
  it("소유자의 프로젝트를 지원·상세 조회 수와 함께 나열한다", async () => {
    // 준비: 명세·지원·상세 조회 기록이 있는 프로젝트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId);
    await addSpecItems(projectId, 1, 2);
    const supplierId = await makeSupplier();
    await db.application.create({ data: { projectId, supplierId, specVersionNo: 1, totalAmount: 100, durationDays: 1, firstViewedAt: now } });
    await db.eventLog.create({ data: { userId: supplierId, projectId, type: EventType.SPEC_DETAIL_VIEWED, occurredAt: now } });

    // 실행: 내 프로젝트 목록 조회
    const rows = await listMyProjects(db, clientId);

    // 확인: 지원·조회 수와 현재 버전이 카드에 담긴다
    const card = rows.find(row => row.projectId === projectId);
    expect(card).toMatchObject({ projectId, status: ProjectStatus.RECRUITING, applicationCount: 1, detailViewCount: 1, currentVersion: 1 });
  });

  it("A-06-T03/T05 검색 포트로 공개 프로젝트를 나열하고 정확한 예산은 노출하지 않는다", async () => {
    // 준비: 명세가 있는 프로젝트와 검색 포트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId);
    await addSpecItems(projectId, 1, 2);
    const searchPublicProjects = jest.fn(async () => ({ projectIds: [projectId], total: 1 }));

    // 실행: 공개 목록 조회
    const page = await listPublicProjects(db, { searchPublicProjects }, { filters: {}, page: 1, pageSize: 10 });

    // 확인: 검색 포트를 한 번 쓰고 예산은 구간만 노출한다
    expect(searchPublicProjects).toHaveBeenCalledTimes(1);
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ projectId, itemCount: 2, hopeBudgetBand: "400~500만원" });
    expect(page.items[0]).not.toHaveProperty("hopeBudget");
    expect(JSON.stringify(page.items)).not.toContain("4000000");
  });

  it("A-06-T05 최초 조회를 정확히 한 번 기록하고 NDA 후 공개 상세를 반환한다", async () => {
    // 준비: NDA 동의 공급자와 상세 조회 포트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId);
    await addSpecItems(projectId, 1, 2);
    const supplierId = await makeSupplier("nda-v1");
    const recordFirstView = jest.fn(async () => undefined);

    // 실행: 공개 상세 조회
    const detail = await getPublicProjectDetail(db, { supplierNdaVersion: "nda-v1", view: { recordFirstView } }, projectId, supplierId, now);

    // 확인: 최초 조회 1회 기록과 공개 필드만 담긴 상세
    expect(recordFirstView).toHaveBeenCalledTimes(1);
    expect(detail).toMatchObject({ projectId, itemCount: 2, hopeBudget: 4_000_000 });
    expect(detail.client).toMatchObject({ businessName: "카페 블루", name: "김의뢰" });
    expect(detail.items[0]).toMatchObject({ title: "기능 0" });
    for (const forbidden of ["unitPrice", "estimatedTotal", "clientFee", "email"]) expect(detail).not.toHaveProperty(forbidden);
  });

  it("프로필 미완성 의뢰인의 상세는 프로필 정보를 숨기고 제공한다", async () => {
    // 준비: 상호 프로필이 없는 프로젝트와 NDA 동의 공급자
    const clientId = await makeClient();
    await db.clientProfile.delete({ where: { userId: clientId } });
    const projectId = await makeProject(clientId);
    await addSpecItems(projectId, 1, 2);
    const supplierId = await makeSupplier("nda-v1");
    const recordFirstView = jest.fn(async () => undefined);

    // 실행: 공급자가 공개 프로젝트 상세 조회
    const detail = await getPublicProjectDetail(db, { supplierNdaVersion: "nda-v1", view: { recordFirstView } }, projectId, supplierId, now);

    // 확인: 프로젝트는 열리고 미완성 프로필 정보는 비공개다
    expect(recordFirstView).toHaveBeenCalledTimes(1);
    expect(detail.client).toEqual({
      name: null,
      businessName: null,
      industryField: null,
      storeAddress: null,
      bio: null,
      websiteUrl: null,
      ratingAvg: null,
      reviewCount: 0,
    });
  });

  it("현재 공급자 NDA 없이는 공개 상세를 막는다", async () => {
    // 준비: NDA를 동의하지 않은 공급자
    const clientId = await makeClient();
    const projectId = await makeProject(clientId);
    const supplierId = await makeSupplier(null);
    const recordFirstView = jest.fn(async () => undefined);
    // 실행 및 확인: NDA 없으면 상세가 거부된다
    await expect(getPublicProjectDetail(db, { supplierNdaVersion: "nda-v1", view: { recordFirstView } }, projectId, supplierId, now))
      .rejects.toMatchObject({ code: "SUPPLIER_NDA_REQUIRED", status: 403 });
    // 확인: 조회 기록도 남지 않는다
    expect(recordFirstView).not.toHaveBeenCalled();
  });

  it("소유자의 프로젝트를 소프트 삭제하고 대기 지원을 거절한다", async () => {
    // 준비: 프로젝트와 지원 포트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId);
    const port = applicationPort({ rejectPendingOnDelete: 1 });
    // 실행: 소프트 삭제
    await softDeleteProject(db, { application: port }, projectId, clientId, now);
    // 확인: 삭제 시각이 남고 목록에서 사라지며 대기 지원이 거절된다
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ deletedAt: now });
    expect(port.rejectPendingOnDelete).toHaveBeenCalledTimes(1);
    expect((await listMyProjects(db, clientId)).some(row => row.projectId === projectId)).toBe(false);
  });
});

// 다른 모듈이 쓰는 프로젝트 출력 포트의 전이 동작을 검증한다.
describe("A-06 B/C용 출력 포트", () => {
  it("프로젝트를 계약 상태로 전이하고 잘못된 점프를 거부한다", async () => {
    // 준비: 프로젝트와 출력 포트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId);
    const ports = createProjectOutputPorts(db);

    // 실행 및 확인: 모집 중에서 계약으로 바로 건너뛰면 거부된다
    await expect(ports.transitionProject(db, { projectId, to: ProjectStatus.CONTRACTED, at: now }))
      .rejects.toMatchObject({ code: "INVALID_PROJECT_TRANSITION", status: 409 });

    // 실행: 수락 전이
    await db.$transaction(tx => ports.transitionProject(tx, { projectId, to: ProjectStatus.ACCEPTED, at: now }));
    // 확인: 수락 상태
    expect(await ports.readSpecVersion(projectId)).toMatchObject({ currentVersion: 1, status: ProjectStatus.ACCEPTED });

    // 실행: 계약 전이
    await db.$transaction(tx => ports.transitionProject(tx, { projectId, to: ProjectStatus.CONTRACTED, at: now }));
    // 확인: 계약 상태
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ status: ProjectStatus.CONTRACTED });

    // 실행: 선택 중 전이
    await db.$transaction(tx => ports.transitionProject(tx, { projectId, to: ProjectStatus.SELECTING, at: now }));
    // 확인: 선택 중 상태와 7일 뒤 선택 종료 시각
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe(ProjectStatus.SELECTING);
    expect(project.selectionEndsAt?.getTime()).toBe(now.getTime() + 7 * day);
  });
});

// 마감 연장의 상한과 상태 조건을 검증한다.
describe("A-06 마감 연장", () => {
  it("A-06-T05 연장을 14일로 제한하고 모집을 다시 연다", async () => {
    // 준비: 선택 기간이 지난 프로젝트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId, { status: ProjectStatus.SELECTING, selectionEndsAt: pastDeadline });

    // 실행 및 확인: 상한을 1ms 넘긴 연장은 거부된다
    await expect(extendDeadline(db, projectId, clientId, new Date(futureDeadline.getTime() + 14 * day + 1), now))
      .rejects.toMatchObject({ code: "INVALID_DEADLINE_EXTENSION", status: 422 });

    // 실행: 정확히 14일 연장
    const exactly = new Date(futureDeadline.getTime() + 14 * day);
    const result = await extendDeadline(db, projectId, clientId, exactly, now);
    // 확인: 모집 중으로 돌아가고 연장 이벤트가 한 번 남는다
    expect(result).toMatchObject({ projectId, status: ProjectStatus.RECRUITING });
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ status: ProjectStatus.RECRUITING, selectionEndsAt: null });
    expect(await db.eventLog.count({ where: { projectId, type: EventType.DEADLINE_EXTENDED } })).toBe(1);
  });

  it("이미 계약 중인 프로젝트의 연장을 거부한다", async () => {
    // 준비: 계약 상태 프로젝트
    const clientId = await makeClient();
    const projectId = await makeProject(clientId, { status: ProjectStatus.CONTRACTED });
    // 실행 및 확인: 계약 중 프로젝트의 연장은 거부된다
    await expect(extendDeadline(db, projectId, clientId, new Date(futureDeadline.getTime() + day), now))
      .rejects.toMatchObject({ code: "PROJECT_DEADLINE_NOT_EXTENDABLE", status: 409 });
  });
});
