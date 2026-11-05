import { afterAll, describe, expect, it } from "@jest/globals";
import { EventType, PrismaClient, Role } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createLogger } from "./observability.ts";
import { EventError, recordEvent, recordLlmCall } from "./events.ts";
import { getProductMetrics, specCompletionRate } from "./metrics.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test") {
  throw new Error("A-07 tests require the dedicated majayong_a00_test database");
}
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const userIds: string[] = [];

async function makeUser(role = Role.CLIENT): Promise<string> {
  const id = randomUUID();
  await db.user.create({ data: { id, email: `a07-${id}@example.invalid`, role } });
  userIds.push(id);
  return id;
}

afterAll(async () => {
  if (userIds.length > 0) {
    await db.eventLog.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.$disconnect();
});

describe("A-07 공통 이벤트 로그", () => {
  it("A-07-T01 실패한 LLM 호출에도 토큰·비용을 남기고 잘못된 지표를 거부한다", async () => {
    // 준비
    const userId = await makeUser();

    // 실행
    const row = await db.$transaction(tx => recordLlmCall(tx, {
      userId, purpose: "BLOCK_CREATE", model: "gpt-test",
      tokens: { input: 120, output: 0 }, costKrw: 37, latencyMs: 250, succeeded: false,
    }));
    const saved = await db.eventLog.findUniqueOrThrow({ where: { id: row.id } });

    // 확인
    expect(saved.type).toBe(EventType.LLM_CALLED);
    expect(saved.payload).toEqual({
      purpose: "BLOCK_CREATE", model: "gpt-test", tokens: { input: 120, output: 0 },
      costKrw: 37, latencyMs: 250, succeeded: false,
    });

    // 실행 및 확인
    await expect(recordLlmCall(db, { userId, purpose: "BLOCK_CREATE", model: "", tokens: { input: 0, output: 0 }, costKrw: 0, latencyMs: 0, succeeded: false }))
      .rejects.toBeInstanceOf(EventError);
    await expect(recordLlmCall(db, { userId, purpose: "BLOCK_CREATE", model: "m", tokens: { input: -1, output: 0 }, costKrw: 0, latencyMs: 0, succeeded: true }))
      .rejects.toBeInstanceOf(EventError);
    await expect(recordLlmCall(db, { userId, purpose: "NOT_A_PURPOSE" as never, model: "m", tokens: { input: 0, output: 0 }, costKrw: 0, latencyMs: 0, succeeded: true }))
      .rejects.toBeInstanceOf(EventError);
  });

  it("A-07-T02 이벤트 페이로드를 손실 없이 왕복 변환한다", async () => {
    // 준비
    const userId = await makeUser();
    const payload = { status: "DRAFT", count: 3, nested: { ok: true }, tags: ["a", "b"] };

    // 실행
    const first = await recordEvent(db, { type: EventType.PORTFOLIO_SUMMARIZED, userId, payload });
    const second = await recordEvent(db, { type: EventType.PORTFOLIO_SUMMARIZED, userId, payload });
    const rows = await db.eventLog.findMany({ where: { id: { in: [first.id, second.id] } }, orderBy: { id: "asc" } });

    // 확인
    expect(rows).toHaveLength(2);
    expect(rows[0]!.payload).toEqual(payload);
    expect(rows[1]!.payload).toEqual(payload);
  });

  it("A-07-T03 개인정보 원문을 기록하거나 저장하지 않는다", async () => {
    // 준비
    const userId = await makeUser();
    const lines: string[] = [];

    // 실행
    createLogger(line => lines.push(line)).log("error", "request_failed", {
      requestId: "req-1", userEmail: "private@example.invalid", clientUtterance: "원문", amount: 1234, status: "failed",
    });

    // 확인
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("request_failed");
    expect(lines[0]).toContain("req-1");
    expect(lines[0]).not.toMatch(/private|원문|1234/);

    // 실행 및 확인
    await expect(recordEvent(db, { type: EventType.CHAT_SUBMITTED, userId, payload: { utterance: "원문", count: 1 } }))
      .rejects.toBeInstanceOf(EventError);
    await expect(recordEvent(db, { type: EventType.CHAT_SUBMITTED, userId, payload: { nested: { email: "a@b.invalid" } } }))
      .rejects.toBeInstanceOf(EventError);
  });

  it("A-07-T04 제품 지표를 기록된 이벤트와 일치시킨다", async () => {
    // 준비
    const userId = await makeUser();
    const from = new Date("2099-06-01T00:00:00.000Z");
    const to = new Date("2099-06-02T00:00:00.000Z");
    const at = new Date("2099-06-01T09:00:00.000Z");

    // 실행
    await db.$transaction(async tx => {
      await recordEvent(tx, { type: EventType.DRAFT_RENDERED, userId, occurredAt: at, payload: { reusedBlocks: 2, generatedBlocks: 1, pendingFeatures: 0, durationMs: 1000 } });
      await recordEvent(tx, { type: EventType.DRAFT_RENDERED, userId, occurredAt: at, payload: { reusedBlocks: 3, generatedBlocks: 0, pendingFeatures: 1, durationMs: 3000 } });
      await recordEvent(tx, { type: EventType.SPEC_CONFIRMED, userId, occurredAt: at });
      await recordEvent(tx, { type: EventType.DRAFT_RENDERED, userId, occurredAt: new Date("2099-06-05T00:00:00.000Z"), payload: { reusedBlocks: 9 } });
    });

    const metrics = await getProductMetrics(db, { from, to });

    // 확인
    expect(metrics).toMatchObject({
      draftRendered: 2, specConfirmed: 1, specCompletionRate: 0.5,
      averageDraftRenderMs: 2000, reusedBlocks: 5, generatedBlocks: 1, pendingFeatures: 1,
    });
  });

  it("A-07-T05 JSON이 아닌 페이로드 값을 거부한다", async () => {
    // 준비
    const userId = await makeUser();

    // 실행 및 확인
    await expect(recordEvent(db, { type: EventType.SPEC_REVISED, userId, payload: { when: new Date() as unknown as string } }))
      .rejects.toBeInstanceOf(EventError);
    await expect(recordEvent(db, { type: EventType.SPEC_REVISED, userId, payload: { nan: Number.NaN } }))
      .rejects.toBeInstanceOf(EventError);
  });

  it("A-07-T05b 완료 비율을 0과 1 사이로 제한한다", () => {
    // 확인
    expect(specCompletionRate(4, 2)).toBe(0.5);
    expect(specCompletionRate(2, 5)).toBe(1);
    expect(specCompletionRate(0, 3)).toBe(0);
  });
});
