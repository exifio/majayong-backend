import { afterAll, describe, expect, it } from "@jest/globals";
import { DraftEntryType, PrismaClient, Role } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createDraftCatalogAdapter } from "./draft-catalog-adapter.ts";
import type { CatalogBlockGenerator, CatalogFeatureExtractor } from "../modules/catalog/service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("A-04 adapter tests require the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const industryCode = "ADAPTER_TEST";
const userIds: string[] = [];

const metadata = { model: "test-model", tokens: { input: 1, output: 1 }, costKrw: 0, latencyMs: 0 };

/** 기능 텍스트마다 서로 다른 블록을 만든다(같은 텍스트는 재사용). */
function blockGenerator(): CatalogBlockGenerator {
  return async ({ text }) => ({
    content: {
      name: text,
      functionSummary: text,
      description: `${text} 설명`,
      techTags: ["test"],
      wireframe: { parts: [{ type: "TEXT", label: text, props: {} }] },
      conditions: [{ key: "a", text: "조건 A" }, { key: "b", text: "조건 B" }],
      unitPrice: 1000,
      priceBasis: "범위\n가정\n참고 추정치",
    },
    metadata,
  });
}

function featureExtractor(features: string[]): CatalogFeatureExtractor {
  return async () => ({ features, metadata });
}

async function makeClient(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `adapter-${id}@example.invalid`, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: id, industryField: industryCode } });
  return id;
}

async function makeBlock(input: {
  inDefaultDraft: boolean; isActive: boolean; recommendRank: number | null; sortOrder: number;
}): Promise<string> {
  const id = randomUUID();
  await db.blockCatalog.create({
    data: {
      id, code: `adapter-${id}`, name: `블록 ${id}`, functionSummary: `요약 ${id}`, description: "설명",
      industryCode, unitPrice: 1000, priceBasis: "범위\n가정\n참고 추정치", techTags: [],
      inDefaultDraft: input.inDefaultDraft, isActive: input.isActive,
      recommendRank: input.recommendRank, sortOrder: input.sortOrder,
    },
  });
  return id;
}

afterAll(async () => {
  await db.blockCatalog.deleteMany({ where: { industryCode } });
  if (userIds.length) await db.eventLog.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length) await db.clientProfile.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

// 카탈로그 어댑터가 기본 초안·문장 입력·대기 기능을 어떻게 해석하는지 검증한다.
describe("A-04 초안 카탈로그 어댑터", () => {
  it("DEFAULT_DRAFT에는 활성·미병합 기본 초안 블록만 반환한다", async () => {
    // 준비: 기본 초안 포함·제외·비활성 블록
    const clientId = await makeClient();
    const activeDefault = await makeBlock({ inDefaultDraft: true, isActive: true, recommendRank: 1, sortOrder: 1 });
    const nonDefault = await makeBlock({ inDefaultDraft: false, isActive: true, recommendRank: null, sortOrder: 2 });
    const inactiveDefault = await makeBlock({ inDefaultDraft: true, isActive: false, recommendRank: null, sortOrder: 3 });
    const adapter = createDraftCatalogAdapter(db);

    // 실행: 기본 초안 해석
    const defaults = await adapter.resolveExisting({ clientId, entryType: DraftEntryType.DEFAULT_DRAFT, utterances: [] });
    // 확인: 활성 기본 초안 블록만 포함된다
    // 전용 테스트 DB에는 팀 승인 시드의 기본 초안 6개가 남을 수 있으므로 정확한 집합 대신 포함/제외로 검증한다.
    expect(defaults.blockIds).toContain(activeDefault);
    expect(defaults.blockIds).not.toContain(nonDefault);
    expect(defaults.blockIds).not.toContain(inactiveDefault);
    expect(defaults.pendingFeatures).toEqual([]);
  });

  it("약 5개 기능을 추출하고 각각을 생성 블록으로 연결한다", async () => {
    // 준비: 5개 기능을 돌려주는 추출기와 생성기가 연결된 어댑터
    const clientId = await makeClient();
    const features = ["예약 달력", "예약금 결제", "노쇼 기록", "예약 알림", "리뷰 요청"];
    const adapter = createDraftCatalogAdapter(db, {
      extractor: featureExtractor(features),
      generator: blockGenerator(),
    });

    // 실행: 첫 문장으로 초안 해석
    const result = await adapter.resolveExisting({
      clientId, entryType: DraftEntryType.SENTENCE,
      utterances: [{ kind: "FIRST_SENTENCE", text: "예약 서비스가 필요해요" }],
    });

    // 확인: 추출한 5개가 모두 블록으로 생성된다
    expect(result.blockIds).toHaveLength(5);
    expect(result.pendingFeatures).toEqual([]);
    expect(result).toMatchObject({ reusedBlocks: 0, generatedBlocks: 5 });
    expect(await db.blockCatalog.count({ where: { industryCode, functionSummary: { in: features } } })).toBe(5);

    // 실행: 같은 문장으로 다시 해석
    const reused = await adapter.resolveExisting({
      clientId, entryType: DraftEntryType.SENTENCE,
      utterances: [{ kind: "FIRST_SENTENCE", text: "예약 서비스가 필요해요" }],
    });
    // 확인: 같은 블록을 재사용하고 새로 만들지 않는다
    expect(reused).toMatchObject({ reusedBlocks: 5, generatedBlocks: 0 });
  });

  it("추출 결과가 없으면 대기 기능 하나를 유지한다", async () => {
    // 준비: 빈 추출 결과를 돌려주는 어댑터
    const clientId = await makeClient();
    const adapter = createDraftCatalogAdapter(db, {
      extractor: featureExtractor([]),
      generator: blockGenerator(),
    });
    // 실행: 첫 문장으로 초안 해석
    const result = await adapter.resolveExisting({
      clientId, entryType: DraftEntryType.SENTENCE,
      utterances: [{ kind: "FIRST_SENTENCE", text: "예약 서비스가 필요해요" }],
    });
    // 확인: 블록은 없고 대기 기능만 하나 남는다
    expect(result.blockIds).toEqual([]);
    expect(result.pendingFeatures).toHaveLength(1);
  });

  it("대기 기능에서 카탈로그 블록을 생성하고 대기 상태를 지운다", async () => {
    // 준비: 생성기만 연결된 어댑터와 대기 기능 하나
    const clientId = await makeClient();
    const adapter = createDraftCatalogAdapter(db, { generator: blockGenerator() });
    const pending = [{ key: randomUUID(), summary: "예약 취소 기능", attempts: 0, lastTriedAt: null }];

    // 실행: 대기 기능 생성
    const first = await adapter.generatePending({
      clientId, entryType: DraftEntryType.SENTENCE,
      utterances: [{ kind: "FIRST_SENTENCE", text: "예약 취소 기능이 필요해요" }], pendingFeatures: pending,
    });
    // 확인: 대기 기능이 비고 활성 블록이 하나 만들어진다
    expect(first.pendingFeatures).toEqual([]);
    expect(first.blockIds).toHaveLength(1);
    const stored = await db.blockCatalog.findFirstOrThrow({ where: { id: first.blockIds[0]!, industryCode } });
    expect(stored.functionSummary).toBe("예약 취소 기능");
    expect(stored.isActive).toBe(true);
  });

  it("생성기가 설정되지 않으면 대기 기능을 그대로 둔다", async () => {
    // 준비: 생성기 없이 만든 어댑터와 대기 기능
    const clientId = await makeClient();
    const adapter = createDraftCatalogAdapter(db, {});
    const pending = [{ key: randomUUID(), summary: "대기", attempts: 0, lastTriedAt: null }];
    // 실행: 대기 기능 생성 시도
    const result = await adapter.generatePending({
      clientId, entryType: DraftEntryType.SENTENCE,
      utterances: [{ kind: "FIRST_SENTENCE", text: "아무 문장" }], pendingFeatures: pending,
    });
    // 확인: 블록 없이 대기 기능이 그대로 남는다
    expect(result.blockIds).toEqual([]);
    expect(result.pendingFeatures).toEqual(pending);
  });
});
