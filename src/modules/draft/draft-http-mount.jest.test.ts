import { afterAll, describe, expect, it } from "@jest/globals";
import { PrismaClient, Role } from "@prisma/client";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createApp } from "../../app.ts";
import { createDraftCatalogAdapter } from "../../integration/draft-catalog-adapter.ts";
import { issueAccessToken } from "../identity/auth.ts";
import type { CatalogBlockGenerator, CatalogFeatureExtractor } from "../catalog/service.ts";
import type { DraftCatalogAdapter, DraftPorts } from "./service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("A-04 draft mount tests require the dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;

const db = new PrismaClient();
const now = new Date("2026-11-03T09:00:00.000Z");
const tokenSecret = "a-04-http-mount-token-secret-over-32-bytes";
const industryCode = "HTTP_MOUNT_TEST";
const servers: Server[] = [];
const userIds: string[] = [];

const metadata = { model: "test-model", tokens: { input: 1, output: 1 }, costKrw: 0, latencyMs: 0 };
const features = ["예약 달력", "예약금 결제", "노쇼 기록", "예약 알림", "리뷰 요청"];
const extractor: CatalogFeatureExtractor = async () => ({ features, metadata });
const generator: CatalogBlockGenerator = async ({ text }) => ({
  content: {
    name: text, functionSummary: text, description: `${text} 설명`, techTags: ["test"],
    wireframe: { parts: [{ type: "TEXT", label: text, props: {} }] },
    conditions: [{ key: "a", text: "조건 A" }, { key: "b", text: "조건 B" }],
    unitPrice: 1000, priceBasis: "범위\n가정\n참고 추정치",
  },
  metadata,
});

const emptyCatalog: DraftCatalogAdapter = {
  resolveExisting: async () => ({ blockIds: [], pendingFeatures: [] }),
  generatePending: async () => ({ blockIds: [], pendingFeatures: [] }),
  recommend: async () => [],
};

afterAll(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  if (userIds.length) await db.clientUtterance.deleteMany({ where: { draft: { clientId: { in: userIds } } } });
  if (userIds.length) await db.draftBlock.deleteMany({ where: { draft: { clientId: { in: userIds } } } });
  if (userIds.length) await db.draft.deleteMany({ where: { clientId: { in: userIds } } });
  await db.blockCatalog.deleteMany({ where: { industryCode } });
  if (userIds.length) await db.eventLog.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length) await db.clientProfile.deleteMany({ where: { userId: { in: userIds } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

async function startApp(draft?: DraftPorts): Promise<string> {
  const server = createServer(createApp({ db, tokenSecret, now: () => now, ...(draft ? { draft } : {}) }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind");
  return `http://127.0.0.1:${address.port}/api/v1`;
}

async function makeClient(): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await db.user.create({ data: { id, email: `a04m-${id}@example.invalid`, role: Role.CLIENT } });
  await db.clientProfile.create({ data: { userId: id, industryField: industryCode } });
  return id;
}

describe("A-04 초안 HTTP 마운트", () => {
  it("카탈로그 어댑터가 주입될 때만 createApp으로 초안 API를 마운트한다", async () => {
    // 준비
    const clientId = await makeClient();
    const token = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: now.getTime() + 60_000 }, tokenSecret);
    const post = (baseUrl: string) => fetch(`${baseUrl}/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ entryType: "DEFAULT_DRAFT" }),
    });

    // 실행 및 확인
    const mounted = await startApp({ catalog: emptyCatalog });
    expect((await post(mounted)).status).toBe(201);

    const unmounted = await startApp();
    expect((await post(unmounted)).status).toBe(404);
  });

  it("실제 A-03 어댑터로 한 문장 초안에 약 5개 블록을 만든다", async () => {
    // 준비
    const clientId = await makeClient();
    const token = issueAccessToken({ userId: clientId, role: Role.CLIENT, expiresAt: now.getTime() + 60_000 }, tokenSecret);
    const baseUrl = await startApp({ catalog: createDraftCatalogAdapter(db, { extractor, generator }) });

    // 실행
    const response = await fetch(`${baseUrl}/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ entryType: "SENTENCE", text: "예약 서비스가 필요해요" }),
    });

    // 확인
    expect(response.status).toBe(201);
    const body = await response.json() as { data: { status: string; pendingFeatures: unknown[]; blocks: { unitPrice: number }[] } };
    expect(body.data.blocks).toHaveLength(5);
    expect(body.data.blocks.every(block => block.unitPrice === 1000)).toBe(true);
    expect(body.data.pendingFeatures).toEqual([]);
  });
});
