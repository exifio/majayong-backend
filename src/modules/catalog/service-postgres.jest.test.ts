import { afterAll, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { BlockOrigin, BlockSource, DraftEntryType, PrismaClient, Role } from "@prisma/client";
import { extractCatalogFeatures, generateOrReuseCatalogBlock } from "./service.ts";
import { mergeCatalogBlock, setCatalogBlockActive, updateCatalogBlockPrice } from "./admin.ts";
import type { CatalogBlockGenerator } from "./service.ts";
import { reservationRestaurantSeedBlocks, seedReservationRestaurantCatalog } from "./seed.ts";
import { createCatalogAdminPort } from "../../integration/catalog-admin-port.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("A-03 tests require the dedicated local majayong_a00_test database");
const parsedTestDatabaseUrl = new URL(testDatabaseUrl);
if (!['localhost', '127.0.0.1'].includes(parsedTestDatabaseUrl.hostname) || parsedTestDatabaseUrl.pathname !== "/majayong_a00_test") {
  throw new Error("A-03 tests refuse to run outside the dedicated local majayong_a00_test database");
}
process.env.DATABASE_URL = testDatabaseUrl;
const prisma = new PrismaClient();
const userIds = new Set<string>();
const blockIds = new Set<string>();
const draftIds = new Set<string>();
const projectIds = new Set<string>();
const industryCodes = new Set<string>();

function testIndustryCode(): string {
  const value = `A03-${randomUUID().replace(/[0-9]/g, "")}`;
  industryCodes.add(value);
  return value;
}

function generatedBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Reservation calendar",
    functionSummary: "show and edit available reservation hours",
    description: "Lets staff manage booking times.",
    techTags: ["calendar", "booking"],
    wireframe: { parts: [{ type: "CALENDAR" }, { type: "FORM" }] },
    conditions: [
      { key: "timezone", text: "Choose the store timezone." },
      { key: "capacity", text: "Set the available reservation capacity." },
    ],
    unitPrice: 120000,
    priceBasis: "Implement reservation calendar and API.\nConnect booking data and validation.\nFinal scope may change the effort.",
    ...overrides,
  };
}

function generationResponse(content = generatedBlock()) {
  return { content, metadata: { model: "gpt-5.4-mini", tokens: { input: 100, output: 50 }, costKrw: 2, latencyMs: 30 } };
}

async function createClient() {
  const id = randomUUID();
  userIds.add(id);
  return prisma.user.create({
    data: {
      id,
      email: `a03-${id}@example.invalid`,
      name: "김하나",
      role: Role.CLIENT,
      clientProfile: { create: { businessName: "Cafe Blue", storeAddress: "서울 마포구 월드컵로 12" } },
    },
  });
}

async function createAdmin() {
  const id = randomUUID();
  userIds.add(id);
  return prisma.user.create({ data: { id, email: `a03-admin-${id}@example.invalid`, role: Role.ADMIN } });
}

async function createExistingBlock(industryCode: string, unitPrice = 7000, functionSummary = "show and edit available reservation hours") {
  const id = randomUUID();
  blockIds.add(id);
  return prisma.blockCatalog.create({
    data: {
      id,
      code: `A03-${id}`,
      name: "Existing reservation calendar",
      functionSummary,
      description: "Existing fixture",
      industryCode,
      techTags: [],
      source: BlockSource.TEAM,
      unitPrice,
      priceBasis: "Existing fixture.\nExisting fixture.\nExisting fixture.",
      isActive: true,
    },
  });
}

function generationInput(clientId: string, industryCode: string) {
  return {
    clientId,
    industryCode,
    trigger: BlockOrigin.FIRST_SENTENCE,
    text: "Cafe Blue 김하나 서울 마포구 월드컵로 12 010-1234-5678 hana@example.invalid 예약 달력을 만들고 싶어요.",
  };
}

afterAll(async () => {
  const ids = [...userIds];
  const fixtureBlocks = industryCodes.size
    ? await prisma.blockCatalog.findMany({ where: { industryCode: { in: [...industryCodes] } }, select: { id: true } })
    : [];
  const blockList = [...new Set([...blockIds, ...fixtureBlocks.map(block => block.id)])];
  const draftList = [...draftIds];
  const projectList = [...projectIds];
  if (ids.length) await prisma.eventLog.deleteMany({ where: { userId: { in: ids } } });
  if (projectList.length) await prisma.specItem.deleteMany({ where: { projectId: { in: projectList } } });
  if (projectList.length) await prisma.project.deleteMany({ where: { id: { in: projectList } } });
  if (draftList.length) await prisma.draftBlock.deleteMany({ where: { draftId: { in: draftList } } });
  if (draftList.length) await prisma.draft.deleteMany({ where: { id: { in: draftList } } });
  if (blockList.length) await prisma.blockCatalog.updateMany({ where: { id: { in: blockList } }, data: { mergedIntoId: null } });
  if (blockList.length) await prisma.blockCatalog.deleteMany({ where: { id: { in: blockList } } });
  if (ids.length) await prisma.clientProfile.deleteMany({ where: { userId: { in: ids } } });
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("A-03 카탈로그 생성과 재사용", () => {
  it("검수된 레스토랑 블록을 한 번 시드하고 활성화한다", async () => {
    // 준비
    const codes = reservationRestaurantSeedBlocks.map(block => block.code);
    const existing = await prisma.blockCatalog.count({ where: { code: { in: codes } } });
    try {
      // 실행 및 확인
      const created = await seedReservationRestaurantCatalog(prisma);
      expect(created).toBe(36 - existing);
      expect(await seedReservationRestaurantCatalog(prisma)).toBe(0);
      const seeded = await prisma.blockCatalog.findMany({ where: { code: { in: codes } } });
      expect(seeded).toHaveLength(36);
      expect(seeded.every(block => block.isActive && block.reviewedAt instanceof Date)).toBe(true);
    } finally {
      // 다른 테스트가 먼저 만든 시드 행에는 그 테스트의 draft_blocks/spec_items가 걸려 있다.
      if (existing === 0) await prisma.blockCatalog.deleteMany({ where: { code: { in: codes } } });
    }
  });

  it("AI 입력 전에 의뢰인 프로필을 가리고 기존 가격을 재사용한다", async () => {
    // 준비
    const client = await createClient();
    const industryCode = testIndustryCode();
    const existing = await createExistingBlock(industryCode, 7000);
    const providerInputs: string[] = [];
    const generator: CatalogBlockGenerator = async input => {
      providerInputs.push(input.text);
      return generationResponse(generatedBlock({ unitPrice: 120000 }));
    };

    // 실행
    const result = await generateOrReuseCatalogBlock(prisma, generationInput(client.id, industryCode), generator);

    // 확인
    expect(result.status).toBe("REUSED");
    if (result.status !== "REUSED") throw new Error("Expected an existing catalog block");
    expect(result.block.id).toBe(existing.id);
    expect(result.block.unitPrice).toBe(7000);
    blockIds.add(result.block.id);
    for (const value of ["Cafe Blue", "김하나", "서울 마포구 월드컵로 12", "010-1234-5678", "hana@example.invalid"]) {
      expect(providerInputs[0]).not.toContain(value);
    }
    expect(await prisma.blockCatalog.count({ where: { industryCode } })).toBe(1);
  });

  it("비활성·병합된 블록은 재사용하지 않는다", async () => {
    // 준비
    const client = await createClient();
    const industryCode = testIndustryCode();
    const inactive = await createExistingBlock(industryCode, 7000);
    await prisma.blockCatalog.update({ where: { id: inactive.id }, data: { isActive: false } });
    const target = await createExistingBlock(industryCode, 9000, "a different function");
    const merged = await createExistingBlock(industryCode, 8000);
    await prisma.blockCatalog.update({ where: { id: merged.id }, data: { mergedIntoId: target.id } });

    // 실행
    const result = await generateOrReuseCatalogBlock(prisma, generationInput(client.id, industryCode), async () => generationResponse());

    // 확인
    expect(result.status).toBe("CREATED");
    if (result.status !== "CREATED") throw new Error("Expected a new catalog block");
    blockIds.add(result.block.id);
    expect(result.block.unitPrice).toBe(120000);
    expect(await prisma.blockCatalog.count({ where: { industryCode, isActive: true, mergedIntoId: null } })).toBe(2);
  });

  it("같은 업종의 동시 생성을 직렬화하고 블록 하나만 저장한다", async () => {
    // 준비
    const client = await createClient();
    const industryCode = testIndustryCode();
    const calls: string[] = [];
    const generator: CatalogBlockGenerator = async input => {
      calls.push(input.text);
      await new Promise(resolve => setTimeout(resolve, 10));
      return generationResponse();
    };

    // 실행
    const results = await Promise.all([
      generateOrReuseCatalogBlock(prisma, generationInput(client.id, industryCode), generator),
      generateOrReuseCatalogBlock(prisma, generationInput(client.id, industryCode), generator),
    ]);

    // 확인
    expect(calls).toHaveLength(2);
    expect(results.map(result => result.status).sort()).toEqual(["CREATED", "REUSED"]);
    for (const result of results) if (result.status !== "PENDING") blockIds.add(result.block.id);
    expect(await prisma.blockCatalog.count({ where: { industryCode, isActive: true, mergedIntoId: null } })).toBe(1);
  });

  it("잘못된 비공개 출력을 한 번 재시도하고 안전한 응답만 저장한다", async () => {
    // 준비
    const client = await createClient();
    const industryCode = testIndustryCode();
    const outputs = [generationResponse(generatedBlock({ name: "Cafe Blue schedule" })), generationResponse()];
    let calls = 0;
    const generator: CatalogBlockGenerator = async () => outputs[calls++];

    // 실행
    const result = await generateOrReuseCatalogBlock(prisma, generationInput(client.id, industryCode), generator);

    // 확인
    expect(calls).toBe(2);
    expect(result.status).toBe("CREATED");
    if (result.status !== "CREATED") throw new Error("Expected a catalog block");
    blockIds.add(result.block.id);
    expect(JSON.stringify(result)).not.toContain("Cafe Blue");
    expect(await prisma.blockCatalog.count({ where: { industryCode } })).toBe(1);
  });

  it("완료된 카탈로그 생성 호출마다 토큰 비용을 기록한다", async () => {
    // 준비
    const client = await createClient();
    const industryCode = testIndustryCode();

    // 실행
    const result = await generateOrReuseCatalogBlock(prisma, generationInput(client.id, industryCode), async () => ({
      content: generatedBlock(),
      metadata: { model: "gpt-5.4-mini", tokens: { input: 100, output: 50 }, costKrw: 2, latencyMs: 30 },
    }));

    // 확인
    expect(result.status).toBe("CREATED");
    if (result.status !== "CREATED") throw new Error("Expected a catalog block");
    blockIds.add(result.block.id);
    expect(await prisma.eventLog.findMany({ where: { userId: client.id, type: "LLM_CALLED" }, select: { payload: true } })).toEqual([
      { payload: { purpose: "BLOCK_CREATE", model: "gpt-5.4-mini", tokens: { input: 100, output: 50 }, costKrw: 2, latencyMs: 30, succeeded: true } },
    ]);
  });

  it("비공개 입력값을 가리고 기능 추출 비용을 계량한다", async () => {
    // 준비
    const client = await createClient();
    const industryCode = testIndustryCode();
    const sent: string[] = [];

    // 실행
    const features = await extractCatalogFeatures(prisma, {
      ...generationInput(client.id, industryCode),
      text: "Cafe Blue 김하나 서울 마포구 월드컵로 12 010-1234-5678 hana@example.invalid 예약 서비스",
    }, async input => {
      sent.push(input.text);
      return {
        features: ["예약 달력", "예약금 결제", "노쇼 기록"],
        metadata: { model: "gpt-5.4-mini", tokens: { input: 100, output: 50 }, costKrw: 2, latencyMs: 30 },
      };
    });

    // 확인
    for (const value of ["Cafe Blue", "김하나", "서울 마포구 월드컵로 12", "010-1234-5678", "hana@example.invalid"]) {
      expect(sent[0]).not.toContain(value);
    }
    expect(features).toEqual(["예약 달력", "예약금 결제", "노쇼 기록"]);
    expect(await prisma.eventLog.findMany({ where: { userId: client.id, type: "LLM_CALLED" }, select: { payload: true } }))
      .toEqual([{ payload: { purpose: "BLOCK_CLASSIFY", model: "gpt-5.4-mini", tokens: { input: 100, output: 50 }, costKrw: 2, latencyMs: 30, succeeded: true } }]);
  });

  it("잘못되었거나 실패한 기능 추출을 모델 출력 없이 거부한다", async () => {
    // 준비
    const client = await createClient();
    const industryCode = testIndustryCode();

    // 실행
    const malformed = await extractCatalogFeatures(prisma, generationInput(client.id, industryCode), async () => ({
      features: ["x".repeat(201)],
      metadata: { model: "gpt-5.4-mini", tokens: { input: 100, output: 50 }, costKrw: 2, latencyMs: 30 },
    }));
    const failed = await extractCatalogFeatures(prisma, generationInput(client.id, industryCode), async () => {
      throw new Error("provider response must not escape");
    });

    // 확인
    expect(malformed).toEqual([]);
    expect(failed).toEqual([]);
    expect(await prisma.blockCatalog.count({ where: { industryCode } })).toBe(0);
    expect(await prisma.eventLog.findMany({ where: { userId: client.id, type: "LLM_CALLED" }, select: { payload: true } }))
      .toEqual([
        { payload: { purpose: "BLOCK_CLASSIFY", model: "gpt-5.4-mini", tokens: { input: 100, output: 50 }, costKrw: 2, latencyMs: 30, succeeded: false } },
        { payload: { purpose: "BLOCK_CLASSIFY", model: "unknown", tokens: { input: 0, output: 0 }, costKrw: 0, latencyMs: 0, succeeded: false } },
      ]);
  });

  it("추출 기능 요약에 반복된 프로필상 비공개 값을 가린다", async () => {
    // 준비
    const client = await createClient();
    const industryCode = testIndustryCode();

    // 실행
    const features = await extractCatalogFeatures(prisma, generationInput(client.id, industryCode), async () => ({
      features: ["예약 달력", "Cafe Blue 예약 관리"],
      metadata: { model: "gpt-5.4-mini", tokens: { input: 100, output: 50 }, costKrw: 2, latencyMs: 30 },
    }));

    // 확인
    expect(features).toEqual(["예약 달력", "[비공개] 예약 관리"]);
  });

  it("정확히 두 번의 무효 생성 시도 후 일반 대기 상태를 반환한다", async () => {
    // 준비
    const client = await createClient();
    const industryCode = testIndustryCode();
    let calls = 0;
    const generator: CatalogBlockGenerator = async () => {
      calls += 1;
      return generationResponse(generatedBlock({ unitPrice: 1.5 }));
    };

    // 실행
    const result = await generateOrReuseCatalogBlock(prisma, generationInput(client.id, industryCode), generator);

    // 확인
    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: "PENDING", pendingFeature: { summary: "기능 분석 대기 중", attempts: 2 } });
    expect(JSON.stringify(result)).not.toContain("Cafe Blue");
    expect(JSON.stringify(result)).not.toContain("예약 달력을 만들고 싶어요");
    expect(await prisma.blockCatalog.count({ where: { industryCode } })).toBe(0);
    const failedCalls = await prisma.eventLog.findMany({ where: { userId: client.id, type: "LLM_CALLED" }, select: { payload: true } });
    expect(failedCalls).toHaveLength(2);
    expect(failedCalls).toEqual(expect.arrayContaining([
      { payload: { purpose: "BLOCK_CREATE", model: "gpt-5.4-mini", tokens: { input: 100, output: 50 }, costKrw: 2, latencyMs: 30, succeeded: false } },
      { payload: { purpose: "BLOCK_CREATE", model: "gpt-5.4-mini", tokens: { input: 100, output: 50 }, costKrw: 2, latencyMs: 30, succeeded: false } },
    ]));
  });
});

describe("A-03 카탈로그 관리자 변경", () => {
  it("ADMIN과 사유를 요구하고 초안·명세 가격 스냅샷은 바꾸지 않는다", async () => {
    // 준비
    const client = await createClient();
    const admin = await createAdmin();
    const industryCode = testIndustryCode();
    const source = await createExistingBlock(industryCode, 7000, "source function");
    const target = await createExistingBlock(industryCode, 9000, "target function");
    const catalogAdmin = createCatalogAdminPort(prisma);
    const draftId = randomUUID();
    const projectId = randomUUID();
    draftIds.add(draftId);
    projectIds.add(projectId);
    await prisma.draft.create({ data: { id: draftId, clientId: client.id, entryType: DraftEntryType.SENTENCE } });
    await prisma.draftBlock.create({ data: { draftId, blockId: source.id, origin: BlockOrigin.FIRST_SENTENCE, unitPrice: 7000 } });
    await prisma.project.create({
      data: {
        id: projectId,
        draftId,
        confirmedAt: new Date(),
        disclosureConsentVersion: "test-v1",
        title: "A-03 test project",
        summary: "A-03 test project",
        industryCode,
        requiredSkills: [],
      },
    });
    await prisma.specItem.create({
      data: {
        projectId,
        blockId: source.id,
        title: "Saved feature snapshot",
        description: "Saved feature snapshot",
        origin: BlockOrigin.FIRST_SENTENCE,
        unitPrice: 7000,
      },
    });

    // 실행 및 확인
    await expect(updateCatalogBlockPrice(prisma, {
      actorId: client.id, blockId: source.id, unitPrice: 10000, reason: "approved price update",
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED", status: 403 });
    await expect(updateCatalogBlockPrice(prisma, {
      actorId: admin.id, blockId: source.id, unitPrice: 10000, reason: "  ",
    })).rejects.toMatchObject({ code: "REASON_REQUIRED", status: 400 });

    // 실행
    await catalogAdmin.executeBlockAction({ actorId: admin.id, blockId: source.id, action: "UPDATE_PRICE", unitPrice: 10000, reason: "approved price update" });
    await catalogAdmin.executeBlockAction({ actorId: admin.id, blockId: source.id, action: "MERGE", mergedIntoId: target.id, reason: "duplicate block" });
    await catalogAdmin.executeBlockAction({ actorId: admin.id, blockId: target.id, action: "DISABLE", reason: "temporarily unavailable" });
    await catalogAdmin.executeBlockAction({ actorId: admin.id, blockId: target.id, action: "ENABLE", reason: "restored after review" });

    // 확인
    expect(await prisma.blockCatalog.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
      unitPrice: 10000, isActive: false, mergedIntoId: target.id,
    });
    expect(await prisma.blockCatalog.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ isActive: true });
    expect(await prisma.draftBlock.findUniqueOrThrow({ where: { draftId_blockId: { draftId, blockId: source.id } } })).toMatchObject({ unitPrice: 7000 });
    expect(await prisma.specItem.findFirstOrThrow({ where: { projectId, blockId: source.id } })).toMatchObject({ unitPrice: 7000 });
    expect(await prisma.eventLog.count({ where: { userId: admin.id, type: { in: ["BLOCK_PRICE_UPDATED", "BLOCK_MERGED", "BLOCK_DEACTIVATED"] } } })).toBe(4);
  });

  it("운영자 가격·병합·활성화 불변식을 보호한다", async () => {
    // 준비
    const admin = await createAdmin();
    const industry = testIndustryCode();
    const foreignIndustry = testIndustryCode();
    const source = await createExistingBlock(industry, 7000, "merge source");
    const target = await createExistingBlock(industry, 9000, "merge target");
    const foreign = await createExistingBlock(foreignIndustry, 8000, "foreign industry");

    // 실행 및 확인
    await expect(updateCatalogBlockPrice(prisma, { actorId: admin.id, blockId: source.id, unitPrice: -1, reason: "negative" }))
      .rejects.toMatchObject({ code: "INVALID_UNIT_PRICE", status: 400 });
    await expect(updateCatalogBlockPrice(prisma, { actorId: admin.id, blockId: source.id, unitPrice: 1.5, reason: "fractional" }))
      .rejects.toMatchObject({ code: "INVALID_UNIT_PRICE", status: 400 });

    await expect(mergeCatalogBlock(prisma, { actorId: admin.id, sourceId: source.id, targetId: source.id, reason: "self" }))
      .rejects.toMatchObject({ code: "INVALID_CATALOG_MERGE", status: 409 });
    await expect(mergeCatalogBlock(prisma, { actorId: admin.id, sourceId: source.id, targetId: foreign.id, reason: "cross industry" }))
      .rejects.toMatchObject({ code: "INVALID_CATALOG_MERGE", status: 409 });

    // 실행
    await mergeCatalogBlock(prisma, { actorId: admin.id, sourceId: source.id, targetId: target.id, reason: "duplicate" });

    // 실행 및 확인
    await expect(mergeCatalogBlock(prisma, { actorId: admin.id, sourceId: source.id, targetId: target.id, reason: "again" }))
      .rejects.toMatchObject({ code: "INVALID_CATALOG_MERGE", status: 409 });
    await expect(setCatalogBlockActive(prisma, { actorId: admin.id, blockId: source.id, isActive: true, reason: "reactivate" }))
      .rejects.toMatchObject({ code: "MERGED_BLOCK_CANNOT_BE_ACTIVATED", status: 409 });

    // 확인
    expect(await prisma.blockCatalog.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ unitPrice: 7000, isActive: false, mergedIntoId: target.id });
    expect(await prisma.blockCatalog.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ isActive: true });
  });
});
