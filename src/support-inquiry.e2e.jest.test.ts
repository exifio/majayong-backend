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
const fixtureIds = {
  contracts: [] as string[],
  applications: [] as string[],
  projects: [] as string[],
  drafts: [] as string[],
};

async function makeUser(role: Role): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `e2e09-${role.toLowerCase()}-${id}@example.invalid`, role } });
  if (role === Role.CLIENT) await db.clientProfile.create({ data: { userId: id, businessName: "카페 블루", profileCompleted: true } });
  return id;
}

async function tokenFor(role: Role): Promise<string> {
  const userId = await makeUser(role);
  return issueAccessToken({ userId, role, expiresAt: Date.now() + 60_000 }, tokenSecret);
}

async function makeContract(clientId: string, supplierId: string): Promise<string> {
  const draftId = randomUUID();
  const projectId = randomUUID();
  const applicationId = randomUUID();
  const contractId = randomUUID();
  const now = new Date();
  await db.supplierProfile.create({
    data: { userId: supplierId, displayName: "공급자", industryCodes: [], skills: [] },
  });
  await db.draft.create({ data: { id: draftId, clientId, entryType: "SENTENCE" } });
  await db.project.create({
    data: {
      id: projectId,
      draftId,
      confirmedAt: now,
      disclosureConsentVersion: "v1",
      title: "문의 계약",
      summary: "요약",
      industryCode: "FOOD",
      requiredSkills: [],
    },
  });
  await db.application.create({
    data: {
      id: applicationId,
      projectId,
      supplierId,
      specVersionNo: 1,
      totalAmount: 1000,
      durationDays: 7,
      firstViewedAt: now,
      status: "ACCEPTED",
    },
  });
  await db.contract.create({
    data: {
      id: contractId,
      applicationId,
      specVersionNo: 1,
      status: "ACTIVE",
      agreedAmount: 1000,
      durationDays: 7,
      clientFee: 50,
      supplierFee: 30,
      consentDeadline: now,
      contentHash: `hash-${contractId}`,
      interimRatio: 50,
    },
  });
  fixtureIds.contracts.push(contractId);
  fixtureIds.applications.push(applicationId);
  fixtureIds.projects.push(projectId);
  fixtureIds.drafts.push(draftId);
  return contractId;
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

async function req(baseUrl: string, method: string, path: string, token: string | undefined, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

afterAll(async () => {
  // 문의·알림·이벤트가 사용자를 참조하므로 자식 행을 먼저 지운다.
  await db.supportInquiry
    .deleteMany({ where: { OR: [{ userId: { in: userIds } }, { answeredById: { in: userIds } }] } })
    .catch(() => undefined);
  await db.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await db.eventLog.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await db.contract.deleteMany({ where: { applicationId: { in: fixtureIds.applications } } }).catch(() => undefined);
  await db.application.deleteMany({ where: { id: { in: fixtureIds.applications } } }).catch(() => undefined);
  await db.project.deleteMany({ where: { id: { in: fixtureIds.projects } } }).catch(() => undefined);
  await db.draft.deleteMany({ where: { id: { in: fixtureIds.drafts } } }).catch(() => undefined);
  await db.clientProfile.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await db.supplierProfile.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
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

  it("비로그인 요청은 401, 타인 문의 상세는 404로 숨기고 운영자는 조회한다", async () => {
    const clientToken = await tokenFor(Role.CLIENT);
    const otherClientToken = await tokenFor(Role.CLIENT);
    const adminToken = await tokenFor(Role.ADMIN);
    const { baseUrl, close } = await startApp();

    try {
      // 실행: 토큰 없이 문의를 만들려 한다
      const anonymous = await req(baseUrl, "POST", "/api/v1/support/inquiries", undefined, {
        category: "OTHER",
        title: "익명 문의",
        body: "내용",
      });
      // 확인: 인증 전에 거부한다
      expect(anonymous.status).toBe(401);

      // 준비: 의뢰인이 문의를 만든다
      const create = await req(baseUrl, "POST", "/api/v1/support/inquiries", clientToken, {
        category: "OTHER",
        title: "소유자 문의",
        body: "내용",
      });
      expect(create.status).toBe(201);
      const inquiryId = create.body.data.id;

      // 실행: 다른 의뢰인이 상세를 조회한다
      const foreign = await req(baseUrl, "GET", `/api/v1/support/inquiries/${inquiryId}`, otherClientToken);
      // 확인: 존재 여부를 숨긴 404다
      expect(foreign.status).toBe(404);
      expect(foreign.body.error.code).toBe("INQUIRY_NOT_FOUND");

      // 실행: 운영자가 같은 상세를 조회한다
      const admin = await req(baseUrl, "GET", `/api/v1/support/inquiries/${inquiryId}`, adminToken);
      // 확인: 운영자는 조회할 수 있다
      expect(admin.status).toBe(200);
      expect(admin.body.data.id).toBe(inquiryId);
    } finally {
      close();
    }
  });

  it("역할별 문의 목록·작성·답변 권한을 403으로 거부한다", async () => {
    const clientToken = await tokenFor(Role.CLIENT);
    const supplierToken = await tokenFor(Role.SUPPLIER);
    const adminToken = await tokenFor(Role.ADMIN);
    const { baseUrl, close } = await startApp();

    try {
      // 준비: 의뢰인 문의 1건
      const create = await req(baseUrl, "POST", "/api/v1/support/inquiries", clientToken, {
        category: "ACCOUNT",
        title: "권한 확인",
        body: "내용",
      });
      const inquiryId = create.body.data.id;

      // 실행 및 확인: 사용자는 운영자 목록을 볼 수 없다
      const clientAdminList = await req(baseUrl, "GET", "/api/v1/admin/support/inquiries", clientToken);
      expect(clientAdminList.status).toBe(403);
      expect(clientAdminList.body.error.code).toBe("ADMIN_ONLY");

      // 실행 및 확인: 사용자는 답변할 수 없다
      const supplierAnswer = await req(baseUrl, "POST", `/api/v1/admin/support/inquiries/${inquiryId}/answer`, supplierToken, {
        answer: "임의 답변",
      });
      expect(supplierAnswer.status).toBe(403);
      expect(supplierAnswer.body.error.code).toBe("ADMIN_ONLY");

      // 실행 및 확인: 운영자는 사용자용 목록을 쓸 수 없다
      const adminMyList = await req(baseUrl, "GET", "/api/v1/support/inquiries", adminToken);
      expect(adminMyList.status).toBe(403);
      expect(adminMyList.body.error.code).toBe("USER_ONLY");

      // 실행 및 확인: 운영자는 문의를 작성할 수 없다
      const adminCreate = await req(baseUrl, "POST", "/api/v1/support/inquiries", adminToken, {
        category: "OTHER",
        title: "운영자 문의",
        body: "내용",
      });
      expect(adminCreate.status).toBe(403);
      expect(adminCreate.body.error.code).toBe("USER_ONLY");
    } finally {
      close();
    }
  });

  it("문의 입력·첨부·계약·상태 필터의 잘못된 값을 400/404로 거부한다", async () => {
    const clientToken = await tokenFor(Role.CLIENT);
    const adminToken = await tokenFor(Role.ADMIN);
    const { baseUrl, close } = await startApp();
    const valid = { category: "OTHER", title: "제목", body: "내용" };

    try {
      for (const [label, body] of [
        ["알 수 없는 분류", { ...valid, category: "UNKNOWN" }],
        ["빈 제목", { ...valid, title: "" }],
        ["빈 내용", { ...valid, body: "" }],
        ["허용되지 않은 필드", { ...valid, status: "ANSWERED" }],
      ] as const) {
        // 실행 및 확인: 잘못된 본문은 400이다
        const response = await req(baseUrl, "POST", "/api/v1/support/inquiries", clientToken, body);
        expect([label, response.status]).toEqual([label, 400]);
      }

      // 실행 및 확인: 첨부 4개는 400이다
      const tooMany = await req(baseUrl, "POST", "/api/v1/support/inquiries", clientToken, {
        ...valid,
        attachments: Array.from({ length: 4 }, (_, index) => ({ url: `/uploads/${index}.pdf`, name: `${index}.pdf`, size: 10 })),
      });
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.error.code).toBe("TOO_MANY_ATTACHMENTS");

      // 실행 및 확인: 외부/절대 URL 첨부는 400이다
      for (const url of ["https://evil.example/x.pdf", "//evil.example/x.pdf"]) {
        const response = await req(baseUrl, "POST", "/api/v1/support/inquiries", clientToken, {
          ...valid,
          attachments: [{ url, name: "x.pdf", size: 10 }],
        });
        expect([url, response.status]).toEqual([url, 400]);
      }

      // 실행 및 확인: 10MB 초과 첨부는 400이다
      const tooLarge = await req(baseUrl, "POST", "/api/v1/support/inquiries", clientToken, {
        ...valid,
        attachments: [{ url: "/uploads/big.pdf", name: "big.pdf", size: 10 * 1024 * 1024 + 1 }],
      });
      expect(tooLarge.status).toBe(400);

      // 실행 및 확인: 접근할 수 없는 계약이면 404다
      const foreignContract = await req(baseUrl, "POST", "/api/v1/support/inquiries", clientToken, {
        ...valid,
        contractId: "00000000-0000-4000-8000-000000000000",
      });
      expect(foreignContract.status).toBe(404);
      expect(foreignContract.body.error.code).toBe("CONTRACT_NOT_FOUND");

      // 실행 및 확인: 잘못된 운영자 상태 필터는 400이다
      const badStatus = await req(baseUrl, "GET", "/api/v1/admin/support/inquiries?status=PENDING", adminToken);
      expect(badStatus.status).toBe(400);
    } finally {
      close();
    }
  });

  it("답변 후 상태가 ANSWERED로 바뀌고 재답변은 409이며 첨부를 보존한다", async () => {
    const clientToken = await tokenFor(Role.CLIENT);
    const adminToken = await tokenFor(Role.ADMIN);
    const otherToken = await tokenFor(Role.SUPPLIER);
    const { baseUrl, close } = await startApp();

    try {
      // 준비: 허용된 상대 경로 첨부 1개로 문의를 만든다
      const create = await req(baseUrl, "POST", "/api/v1/support/inquiries", clientToken, {
        category: "PAYMENT",
        title: "첨부 문의",
        body: "내용",
        attachments: [{ url: "/uploads/receipt-1.pdf", name: "receipt.pdf", size: 1024 }],
      });
      expect(create.status).toBe(201);
      expect(create.body.data.status).toBe("WAITING");
      expect(create.body.data.attachments).toEqual([{ url: "/uploads/receipt-1.pdf", name: "receipt.pdf", size: 1024 }]);
      const inquiryId = create.body.data.id;

      // 실행: 운영자가 답변한다
      const answer = await req(baseUrl, "POST", `/api/v1/admin/support/inquiries/${inquiryId}/answer`, adminToken, {
        answer: "처리했습니다.",
      });
      // 확인: 상태가 ANSWERED로 바뀐다
      expect(answer.status).toBe(200);
      expect(answer.body.data).toMatchObject({ status: "ANSWERED", answer: "처리했습니다." });

      // 실행 및 확인: 같은 문의에 다시 답변하면 409다
      const again = await req(baseUrl, "POST", `/api/v1/admin/support/inquiries/${inquiryId}/answer`, adminToken, {
        answer: "두 번째 답변",
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("INQUIRY_ALREADY_ANSWERED");

      // 실행: 운영자가 상태별 목록을 조회한다
      const waiting = await req(baseUrl, "GET", "/api/v1/admin/support/inquiries?status=WAITING", adminToken);
      const answered = await req(baseUrl, "GET", "/api/v1/admin/support/inquiries?status=ANSWERED", adminToken);
      // 확인: 답변한 문의는 WAITING에서 빠지고 ANSWERED에만 있다
      expect(waiting.status).toBe(200);
      expect(answered.status).toBe(200);
      expect(waiting.body.data.some((row: { id: string }) => row.id === inquiryId)).toBe(false);
      expect(answered.body.data.some((row: { id: string }) => row.id === inquiryId)).toBe(true);

      // 실행 및 확인: 작성자는 자기 문의에서 답변을 확인한다
      const detail = await req(baseUrl, "GET", `/api/v1/support/inquiries/${inquiryId}`, clientToken);
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({ status: "ANSWERED", answer: "처리했습니다." });

      // 실행: 작성자의 알림 목록을 조회한다
      const notifications = await req(baseUrl, "GET", "/api/v1/me/notifications", clientToken);
      // 확인: 문의 답변 알림은 새 문의 화면으로 연결되고 본문은 담지 않는다
      const answerNotifications = notifications.body.data.filter(
        (row: { type: string; targetId: string }) => row.type === "INQUIRY_ANSWERED" && row.targetId === inquiryId,
      );
      expect(notifications.status).toBe(200);
      expect(answerNotifications).toHaveLength(1);
      expect(answerNotifications[0].targetUrl).toBe(`/help/inquiry?tab=my&id=${inquiryId}`);
      expect(answerNotifications[0].payload).toBeNull();

      // 실행 및 확인: 답변 이벤트는 문의 ID와 함께 1회만 기록된다
      const events = await db.eventLog.findMany({
        where: {
          type: "SUPPORT_INQUIRY_ANSWERED",
          payload: { path: ["inquiryId"], equals: inquiryId },
        },
      });
      expect(events).toHaveLength(1);

      // 실행 및 확인: 다른 사용자에게는 같은 알림이 가지 않는다
      const others = await req(baseUrl, "GET", "/api/v1/me/notifications", otherToken);
      expect(others.body.data.some((row: { targetId: string }) => row.targetId === inquiryId)).toBe(false);

      // 실행: 작성자가 알림을 읽음 처리하고 미읽음 목록을 다시 조회한다
      const read = await req(baseUrl, "PATCH", `/api/v1/me/notifications/${answerNotifications[0].id}/read`, clientToken, {});
      const unread = await req(baseUrl, "GET", "/api/v1/me/notifications?unreadOnly=true", clientToken);
      // 확인: 읽음 처리 후 미읽음 목록에서 빠진다
      expect(read.status).toBe(200);
      expect(unread.body.data.some((row: { targetId: string }) => row.targetId === inquiryId)).toBe(false);
    } finally {
      close();
    }
  });

  it("계약 당사자만 계약을 연결한 문의를 만들 수 있다", async () => {
    // 준비: 의뢰인·공급자·제3자 계정과 계약 1건
    const clientId = await makeUser(Role.CLIENT);
    const supplierId = await makeUser(Role.SUPPLIER);
    const strangerId = await makeUser(Role.CLIENT);
    const tokenForUser = (userId: string, role: Role) =>
      issueAccessToken({ userId, role, expiresAt: Date.now() + 60_000 }, tokenSecret);
    const contractId = await makeContract(clientId, supplierId);
    const { baseUrl, close } = await startApp();

    try {
      // 실행: 의뢰인이 계약을 연결해 문의한다
      const byClient = await req(baseUrl, "POST", "/api/v1/support/inquiries", tokenForUser(clientId, Role.CLIENT), {
        category: "INSPECTION",
        contractId,
        title: "의뢰인 문의",
        body: "내용",
      });
      // 확인: 계약 ID가 보존된 문의가 만들어진다
      expect(byClient.status).toBe(201);
      expect(byClient.body.data.contractId).toBe(contractId);

      // 실행 및 확인: 같은 계약의 공급자도 문의할 수 있다
      const bySupplier = await req(baseUrl, "POST", "/api/v1/support/inquiries", tokenForUser(supplierId, Role.SUPPLIER), {
        category: "INSPECTION",
        contractId,
        title: "공급자 문의",
        body: "내용",
      });
      expect(bySupplier.status).toBe(201);

      // 실행: 계약과 무관한 제3자가 같은 계약 ID로 문의한다
      const byStranger = await req(baseUrl, "POST", "/api/v1/support/inquiries", tokenForUser(strangerId, Role.CLIENT), {
        category: "INSPECTION",
        contractId,
        title: "제3자 문의",
        body: "내용",
      });
      // 확인: 존재를 숨긴 404로 거부한다
      expect(byStranger.status).toBe(404);
      expect(byStranger.body.error.code).toBe("CONTRACT_NOT_FOUND");
    } finally {
      close();
    }
  });
});
