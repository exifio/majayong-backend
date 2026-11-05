import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "../tests/test-db.ts";
import { createApp } from "./http/create-app.ts";
import { createDevAuthVerifier } from "./http/auth.ts";
import {
  createAgreementPreviewPort,
  createChatEventPort,
  createIntegrationPorts,
  createProjectStatePort,
  createPublicProjectPorts,
  createReportAccountActionPort,
} from "./integration/external-ports.ts";
import { createProjectCandidatePort } from "./integration/a-ports.ts";
import {
  createPrismaIntegrationDb,
  createPrismaPorts,
  createProjectCandidateDb,
} from "./integration/prisma-wiring.ts";
import { createPrismaApplicationReadPort } from "./modules/application/prisma-adapter.ts";
import { createPrismaContractUnitOfWork } from "./modules/contract/prisma-adapter.ts";
import { breakContract, signContract } from "./modules/contract/lifecycle.ts";
import { createProjectOutputPorts } from "./modules/project/ports.ts";
import { createBRouters } from "./server.ts";
import { withServer } from "../tests/b/http-helpers.ts";

// G2-02: B→A 읽기·합의·상태 경계를 실제 PostgreSQL과 HTTP로 확인한다.
// DATABASE_URL이 없으면 skip한다(전용 테스트 DB에서만 실행, 실제/공유 DB 금지).
const hasDatabase = Boolean(testDatabaseUrl());
const NOW = new Date("2026-11-04T00:00:00.000Z");

type Ids = {
  clientId: string;
  otherClientId: string;
  supplierAId: string;
  supplierBId: string;
  withdrawnSupplierId: string;
  draftId: string;
  projectId: string;
  secondDraftId: string;
  secondProjectId: string;
  blockId: string;
  oldSpecItemId: string;
  currentSpecItemId: string;
  secondSpecItemId: string;
  thirdSpecItemId: string;
  excludedSpecItemId: string;
  applicationAId: string;
  applicationBId: string;
  applicationCId: string;
  contractId: string;
  contractCId: string;
};

async function seed(prisma: PrismaClient): Promise<Ids> {
  const ids: Ids = {
    clientId: randomUUID(),
    otherClientId: randomUUID(),
    supplierAId: randomUUID(),
    supplierBId: randomUUID(),
    withdrawnSupplierId: randomUUID(),
    draftId: randomUUID(),
    projectId: randomUUID(),
    secondDraftId: randomUUID(),
    secondProjectId: randomUUID(),
    blockId: randomUUID(),
    oldSpecItemId: randomUUID(),
    currentSpecItemId: randomUUID(),
    secondSpecItemId: randomUUID(),
    thirdSpecItemId: randomUUID(),
    excludedSpecItemId: randomUUID(),
    applicationAId: randomUUID(),
    applicationBId: randomUUID(),
    applicationCId: randomUUID(),
    contractId: randomUUID(),
    contractCId: randomUUID(),
  };

  await prisma.user.createMany({
    data: [
      { id: ids.clientId, email: `g202-c-${ids.clientId}@test.local`, role: "CLIENT" },
      { id: ids.otherClientId, email: `g202-oc-${ids.otherClientId}@test.local`, role: "CLIENT" },
      { id: ids.supplierAId, email: `g202-a-${ids.supplierAId}@test.local`, role: "SUPPLIER" },
      { id: ids.supplierBId, email: `g202-b-${ids.supplierBId}@test.local`, role: "SUPPLIER" },
      {
        id: ids.withdrawnSupplierId,
        email: `g202-w-${ids.withdrawnSupplierId}@test.local`,
        role: "SUPPLIER",
        withdrawnAt: NOW,
      },
    ],
  });
  await prisma.clientProfile.createMany({
    data: [
      { userId: ids.clientId, businessName: "카페 블루", profileCompleted: true },
      { userId: ids.otherClientId, businessName: "다른 가게", profileCompleted: true },
    ],
  });
  await prisma.supplierProfile.createMany({
    data: [
      {
        userId: ids.supplierAId,
        displayName: "공급자 A",
        industryCodes: [],
        skills: [],
        businessType: "BUSINESS",
        careerYears: 7,
        ratingAvg: 4.5,
        reviewCount: 3,
        portfolioSummary: "연락처 owner@example.invalid 포함",
        portfolioSummaryStatus: "PUBLISHED",
        portfolioConsentAt: NOW,
        payoutVerifiedAt: NOW,
      },
      {
        userId: ids.supplierBId,
        displayName: "공급자 B",
        industryCodes: [],
        skills: [],
        businessType: "BUSINESS",
        portfolioSummary: "동의 없는 요약",
        portfolioSummaryStatus: "PUBLISHED",
        portfolioConsentAt: null,
        payoutVerifiedAt: NOW,
      },
      {
        userId: ids.withdrawnSupplierId,
        displayName: "탈퇴 공급자",
        industryCodes: [],
        skills: [],
        businessType: "BUSINESS",
        portfolioSummary: "탈퇴자 요약",
        portfolioSummaryStatus: "PUBLISHED",
        portfolioConsentAt: NOW,
      },
    ],
  });
  await prisma.blockCatalog.create({
    data: {
      id: ids.blockId,
      code: `g202-${ids.blockId}`,
      name: "예약",
      functionSummary: "예약",
      description: "예약",
      industryCode: "FOOD",
      techTags: [],
      unitPrice: 1_000,
      priceBasis: "test",
    },
  });
  await prisma.draft.createMany({
    data: [
      { id: ids.draftId, clientId: ids.clientId, entryType: "SENTENCE" },
      { id: ids.secondDraftId, clientId: ids.clientId, entryType: "SENTENCE" },
    ],
  });
  await prisma.project.createMany({
    data: [
      {
        id: ids.projectId,
        draftId: ids.draftId,
        confirmedAt: NOW,
        disclosureConsentVersion: "v1",
        title: "예약 사이트",
        summary: "예약",
        industryCode: "FOOD",
        requiredSkills: [],
        status: "RECRUITING",
        currentVersion: 2,
        deadline: new Date("2026-11-20T00:00:00.000Z"),
        publishedAt: NOW,
      },
      {
        id: ids.secondProjectId,
        draftId: ids.secondDraftId,
        confirmedAt: NOW,
        disclosureConsentVersion: "v1",
        title: "두 번째 프로젝트",
        summary: "예약",
        industryCode: "FOOD",
        requiredSkills: [],
        status: "ACCEPTED",
        currentVersion: 1,
      },
    ],
  });
  await prisma.specItem.createMany({
    data: [
      {
        id: ids.oldSpecItemId,
        projectId: ids.projectId,
        versionNo: 1,
        blockId: ids.blockId,
        title: "이전 명세",
        description: "이전",
        origin: "FIRST_SENTENCE",
        unitPrice: 1_000,
        status: "INCLUDED",
        sortOrder: 0,
      },
      {
        id: ids.currentSpecItemId,
        projectId: ids.projectId,
        versionNo: 2,
        blockId: ids.blockId,
        title: "현재 명세",
        description: "현재",
        origin: "FIRST_SENTENCE",
        unitPrice: 1_000,
        status: "INCLUDED",
        sortOrder: 0,
      },
      {
        id: ids.secondSpecItemId,
        projectId: ids.projectId,
        versionNo: 2,
        blockId: ids.blockId,
        title: "두 번째 명세",
        description: "둘째",
        origin: "FIRST_SENTENCE",
        unitPrice: 1_000,
        status: "INCLUDED",
        sortOrder: 1,
      },
      {
        id: ids.thirdSpecItemId,
        projectId: ids.projectId,
        versionNo: 2,
        blockId: ids.blockId,
        title: "세 번째 명세",
        description: "셋째",
        origin: "FIRST_SENTENCE",
        unitPrice: 1_000,
        status: "INCLUDED",
        sortOrder: 2,
      },
      {
        id: ids.excludedSpecItemId,
        projectId: ids.projectId,
        versionNo: 2,
        blockId: ids.blockId,
        title: "제외 명세",
        description: "제외",
        origin: "FIRST_SENTENCE",
        unitPrice: 1_000,
        status: "EXCLUDED",
        sortOrder: 3,
      },
    ],
  });
  await prisma.application.createMany({
    data: [
      {
        id: ids.applicationAId,
        projectId: ids.projectId,
        supplierId: ids.supplierAId,
        specVersionNo: 2,
        totalAmount: 3_100_000,
        durationDays: 42,
        firstViewedAt: NOW,
        status: "ACCEPTED",
        submittedAt: new Date("2026-11-03T00:00:00.000Z"),
      },
      {
        id: ids.applicationBId,
        projectId: ids.projectId,
        supplierId: ids.supplierBId,
        specVersionNo: 2,
        totalAmount: 3_000_000,
        durationDays: 40,
        firstViewedAt: NOW,
        status: "SUBMITTED",
        submittedAt: new Date("2026-11-03T01:00:00.000Z"),
      },
      {
        id: ids.applicationCId,
        projectId: ids.secondProjectId,
        supplierId: ids.supplierBId,
        specVersionNo: 1,
        totalAmount: 3_000_000,
        durationDays: 40,
        firstViewedAt: NOW,
        status: "ACCEPTED",
      },
    ],
  });
  await prisma.applicationMessage.create({
    data: {
      applicationId: ids.applicationAId,
      senderId: ids.supplierAId,
      kind: "TEXT",
      body: "연락처 owner@example.invalid 로 주세요",
      isMasked: true,
    },
  });
  await prisma.contract.create({
    data: {
      id: ids.contractId,
      applicationId: ids.applicationAId,
      specVersionNo: 2,
      status: "COMPLETED",
      agreedAmount: 3_100_000,
      durationDays: 42,
      clientFee: 155_000,
      supplierFee: 155_000,
      consentDeadline: NOW,
      contentHash: "hash",
      interimRatio: 50,
    },
  });
  await prisma.contract.create({
    data: {
      id: ids.contractCId,
      applicationId: ids.applicationCId,
      specVersionNo: 1,
      status: "PENDING_CONSENT",
      agreedAmount: 3_000_000,
      durationDays: 40,
      clientFee: 150_000,
      supplierFee: 150_000,
      consentDeadline: new Date("2026-11-11T00:00:00.000Z"),
      contentHash: "hash-c",
      interimRatio: 50,
    },
  });
  return ids;
}

async function cleanup(prisma: PrismaClient, ids: Ids): Promise<void> {
  const userIds = [
    ids.clientId,
    ids.otherClientId,
    ids.supplierAId,
    ids.supplierBId,
    ids.withdrawnSupplierId,
  ];
  const applicationIds = [ids.applicationAId, ids.applicationBId, ids.applicationCId];
  await prisma.notification.deleteMany({
    where: {
      OR: [
        { userId: { in: userIds } },
        { targetId: { in: [ids.contractId, ids.contractCId, ...applicationIds] } },
      ],
    },
  });
  await prisma.applicationMessage.deleteMany({ where: { applicationId: { in: applicationIds } } });
  await prisma.eventLog.deleteMany({
    where: {
      OR: [
        { projectId: { in: [ids.projectId, ids.secondProjectId] } },
        { userId: { in: userIds } },
      ],
    },
  });
  await prisma.contract.deleteMany({ where: { id: { in: [ids.contractId, ids.contractCId] } } });
  await prisma.applicationItem.deleteMany({ where: { applicationId: { in: applicationIds } } });
  await prisma.application.deleteMany({ where: { projectId: { in: [ids.projectId, ids.secondProjectId] } } });
  await prisma.specItem.deleteMany({ where: { projectId: { in: [ids.projectId, ids.secondProjectId] } } });
  await prisma.project.deleteMany({ where: { id: { in: [ids.projectId, ids.secondProjectId] } } });
  await prisma.draft.deleteMany({ where: { id: { in: [ids.draftId, ids.secondDraftId] } } });
  await prisma.blockCatalog.deleteMany({ where: { id: ids.blockId } });
  await prisma.supplierProfile.deleteMany({
    where: { userId: { in: [ids.supplierAId, ids.supplierBId, ids.withdrawnSupplierId] } },
  });
  await prisma.clientProfile.deleteMany({ where: { userId: { in: [ids.clientId, ids.otherClientId] } } });
  await prisma.user.deleteMany({
    where: {
      id: {
        in: [
          ids.clientId,
          ids.otherClientId,
          ids.supplierAId,
          ids.supplierBId,
          ids.withdrawnSupplierId,
        ],
      },
    },
  });
}

describe("INT-G2-02: B→A 읽기·상태 경계", { skip: hasDatabase ? false : "DATABASE_URL 없음" }, () => {
  it("공개 프로필 비교 카드는 공개·동의·미탈퇴만 요약을 노출하고 연락처를 가린다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const read = createPrismaApplicationReadPort(createPrismaPorts(prisma).applicationRead);
      // 실행
      const summaries = await read.listSupplierProfileSummaries([
        ids.supplierAId,
        ids.supplierBId,
        ids.withdrawnSupplierId,
      ]);

      // 확인
      assert.equal(summaries.length, 2);
      const a = summaries.find((summary) => summary.supplierId === ids.supplierAId);
      assert.equal(a?.portfolioSummary, "연락처 [연락처 비공개] 포함");
      assert.equal(a?.completedContractCount, 1);
      assert.equal(a?.ratingAvg, 4.5);
      assert.equal(summaries.some((summary) => summary.supplierId === ids.withdrawnSupplierId), false);
      assert.equal(summaries.find((summary) => summary.supplierId === ids.supplierBId)?.portfolioSummary, null);
      assert.equal(JSON.stringify(summaries).includes("owner@example.invalid"), false);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("HTTP 비교 카드는 의뢰인만 200, 공급자 403, 비당사자 의뢰인 404", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const app = createApp({
        auth: createDevAuthVerifier([
          { token: "client-token", actor: { userId: ids.clientId, role: "CLIENT" } },
          { token: "supplier-token", actor: { userId: ids.supplierAId, role: "SUPPLIER" } },
          { token: "other-client-token", actor: { userId: ids.otherClientId, role: "CLIENT" } },
        ]),
        routers: (() => {
          const integrationDb = createPrismaIntegrationDb(prisma);
          return createBRouters(
            createPrismaPorts(prisma),
            createIntegrationPorts(integrationDb, {
              ...createPublicProjectPorts(
                integrationDb,
                createProjectCandidatePort(createProjectCandidateDb(prisma)),
              ),
              reportAccounts: createReportAccountActionPort(integrationDb),
              now: () => NOW,
            }),
          );
        })(),
      });

      await withServer(app, async (call) => {
        const path = `/api/v1/projects/${ids.projectId}/applications`;
        // 실행
        const ok = await call({ method: "GET", path, token: "client-token" });
        // 확인
        assert.equal(ok.status, 200);
        const cards = (ok.body as { data: Array<Record<string, unknown>> }).data;
        assert.equal(cards.length, 2);
        const cardA = cards.find((card) => card.supplierId === ids.supplierAId);
        assert.equal(cardA?.portfolioSummary, "연락처 [연락처 비공개] 포함");
        assert.equal(cardA?.completedContractCount, 1);
        assert.equal(JSON.stringify(ok.body).includes("owner@example.invalid"), false);

        // 실행 및 확인
        const supplier = await call({ method: "GET", path, token: "supplier-token" });
        assert.equal(supplier.status, 403);
        const other = await call({ method: "GET", path, token: "other-client-token" });
        assert.equal(other.status, 404);
        const anonymous = await call({ method: "GET", path });
        assert.equal(anonymous.status, 401);

        const recommended = await call({
          method: "GET",
          path: "/api/v1/me/recommended-projects",
          token: "supplier-token",
        });
        assert.equal(recommended.status, 200);
        assert.ok(Array.isArray((recommended.body as { data: unknown[] }).data));
      });
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("프로젝트 상태 전이는 동시 요청에서 한 결과만 남기고 결렬 복귀를 허용한다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const ports = createProjectOutputPorts(prisma);
      // 실행
      const results = await Promise.allSettled([
        prisma.$transaction((tx) =>
          ports.transitionProject(tx, { projectId: ids.secondProjectId, to: "CONTRACTED", at: NOW }),
        ),
        prisma.$transaction((tx) =>
          ports.transitionProject(tx, { projectId: ids.secondProjectId, to: "CONTRACTED", at: NOW }),
        ),
      ]);

      // 확인
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(
        (await prisma.project.findUniqueOrThrow({ where: { id: ids.secondProjectId } })).status,
        "CONTRACTED",
      );

      // 실행
      // 결렬 복귀: CONTRACTED → RECRUITING
      await prisma.$transaction((tx) =>
        ports.transitionProject(tx, { projectId: ids.secondProjectId, to: "RECRUITING", at: NOW }),
      );
      // 확인
      const returned = await prisma.project.findUniqueOrThrow({ where: { id: ids.secondProjectId } });
      assert.equal(returned.status, "RECRUITING");
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("최초 문의 이벤트는 동시 요청에도 1건이고 최신 명세 snapshot이 A/B에서 일치한다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const integrationDb = createPrismaIntegrationDb(prisma);
      const events = createChatEventPort(integrationDb);
      // 실행
      const opened = await Promise.all([
        events.recordInquiryOpenedOnce({ projectId: ids.projectId, clientUserId: ids.clientId, openedAt: NOW }),
        events.recordInquiryOpenedOnce({ projectId: ids.projectId, clientUserId: ids.clientId, openedAt: NOW }),
      ]);

      // 확인
      assert.equal(opened.filter(Boolean).length, 1);
      assert.equal(
        await prisma.eventLog.count({ where: { projectId: ids.projectId, type: "INQUIRY_OPENED" } }),
        1,
      );

      // 실행
      const spec = await createProjectOutputPorts(prisma).readSpecVersion(ids.projectId);
      const snapshot = await createProjectStatePort(integrationDb).getForApplication(ids.projectId);
      // 확인
      assert.equal(spec?.currentVersion, 2);
      const expectedItems = [ids.currentSpecItemId, ids.secondSpecItemId, ids.thirdSpecItemId];
      assert.deepEqual(spec?.specItemIds, expectedItems);
      assert.deepEqual(snapshot?.specItemIds, expectedItems);
      assert.equal(snapshot?.currentVersion, spec?.currentVersion);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("합의 미리보기는 최신 지원 회차 명세를 floor(n/2) INTERIM으로 만들고 연락처를 가린다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const preview = createAgreementPreviewPort(createPrismaIntegrationDb(prisma));
      // 실행
      const spec = await preview.getSpec(ids.applicationAId);
      // 확인
      assert.equal(spec?.defaultInterimRatio, 50);
      assert.deepEqual(
        spec?.items.map((item) => item.stage),
        ["INTERIM", "FINAL", "FINAL"],
      );
      assert.deepEqual(
        spec?.items.map((item) => item.specItemId),
        [ids.currentSpecItemId, ids.secondSpecItemId, ids.thirdSpecItemId],
      );

      // 실행
      const messages = await preview.getMessages(ids.applicationAId);
      // 확인
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.body.includes("owner@example.invalid"), false);
      assert.equal(messages[0]?.body.includes("[연락처 비공개]"), true);
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("신고 계정 조치는 실DB에 반영되고 제재 연장만 갱신한다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const accounts = createReportAccountActionPort(createPrismaIntegrationDb(prisma));
      const firstUntil = new Date("2026-11-08T00:00:00.000Z");
      const laterUntil = new Date("2026-11-12T00:00:00.000Z");

      // 실행
      await accounts.applyAccountAction({
        userId: ids.supplierBId,
        action: "CHAT_RESTRICT_7D",
        at: NOW,
        until: firstUntil,
      });
      // 확인
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: ids.supplierBId } })).chatRestrictedUntil?.getTime(),
        firstUntil.getTime(),
      );

      // 실행
      await accounts.applyAccountAction({
        userId: ids.supplierBId,
        action: "CHAT_RESTRICT_7D",
        at: NOW,
        until: new Date("2026-11-05T00:00:00.000Z"),
      });
      // 확인
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: ids.supplierBId } })).chatRestrictedUntil?.getTime(),
        firstUntil.getTime(),
      );

      // 실행
      await accounts.applyAccountAction({
        userId: ids.supplierBId,
        action: "CHAT_RESTRICT_7D",
        at: NOW,
        until: laterUntil,
      });
      // 확인
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: ids.supplierBId } })).chatRestrictedUntil?.getTime(),
        laterUntil.getTime(),
      );

      // 실행
      await accounts.applyAccountAction({
        userId: ids.supplierBId,
        action: "SUSPEND",
        at: NOW,
        until: null,
      });
      // 확인
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: ids.supplierBId } })).suspendedAt?.getTime(),
        NOW.getTime(),
      );
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });

  it("계약 서명과 예치 기한 결렬이 프로젝트 상태를 같은 트랜잭션으로 바꾼다", async () => {
    // 준비
    const prisma = new PrismaClient();
    const ids = await seed(prisma);
    try {
      const integration = createIntegrationPorts(createPrismaIntegrationDb(prisma), { now: () => NOW });
      const uow = createPrismaContractUnitOfWork(
        createPrismaPorts(prisma).contract,
        integration.depositAttempts,
      );

      // 실행
      const clientSign = await signContract(uow, {
        contractId: ids.contractCId,
        actor: { userId: ids.clientId, role: "CLIENT" },
        expectedContentHash: "hash-c",
        now: NOW,
      });
      // 확인
      assert.equal(clientSign.activated, false);
      assert.equal(
        (await prisma.project.findUniqueOrThrow({ where: { id: ids.secondProjectId } })).status,
        "ACCEPTED",
      );

      // 실행
      const supplierSign = await signContract(uow, {
        contractId: ids.contractCId,
        actor: { userId: ids.supplierBId, role: "SUPPLIER" },
        expectedContentHash: "hash-c",
        now: NOW,
      });
      // 확인
      assert.equal(supplierSign.activated, true);
      assert.equal(
        (await prisma.project.findUniqueOrThrow({ where: { id: ids.secondProjectId } })).status,
        "CONTRACTED",
      );
      assert.equal(
        (await prisma.contract.findUniqueOrThrow({ where: { id: ids.contractCId } })).status,
        "ACTIVE",
      );

      await prisma.contract.update({
        where: { id: ids.contractCId },
        data: { depositDeadline: new Date("2026-11-01T00:00:00.000Z") },
      });
      const afterDue = new Date("2026-11-05T00:00:00.000Z");
      // 실행
      const [firstBreak, secondBreak] = await Promise.all([
        breakContract(uow, { contractId: ids.contractCId, reason: "DEPOSIT_TIMEOUT", now: afterDue }),
        breakContract(uow, { contractId: ids.contractCId, reason: "DEPOSIT_TIMEOUT", now: afterDue }),
      ]);
      // 확인
      assert.equal([firstBreak, secondBreak].filter((result) => result.broken).length, 1);
      assert.equal(
        [firstBreak, secondBreak].find((result) => result.broken)?.projectStatus,
        "RECRUITING",
      );
      assert.equal(
        await prisma.notification.count({ where: { type: "CONTRACT_BROKEN", targetId: ids.contractCId } }),
        2,
      );
      assert.equal(
        (await prisma.project.findUniqueOrThrow({ where: { id: ids.secondProjectId } })).status,
        "RECRUITING",
      );
      assert.equal(
        (await prisma.contract.findUniqueOrThrow({ where: { id: ids.contractCId } })).status,
        "CANCELLED",
      );
      assert.equal(
        (await prisma.application.findUniqueOrThrow({ where: { id: ids.applicationCId } })).status,
        "REJECTED",
      );
    } finally {
      await cleanup(prisma, ids);
      await prisma.$disconnect();
    }
  });
});
