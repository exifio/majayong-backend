import { afterAll, describe, expect, it } from "@jest/globals";
import { createServer, type Server } from "node:http";
import { Router } from "express";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrismaClient } from "@prisma/client";
import { createApp } from "./app.ts";
import { createHttpHandler, type AppServices } from "./c-app.ts";

// G3-02: C 핸들러가 매칭하지 못한 경로도 A/B와 같은 공통 404 봉투를 써야 한다.
const tokenSecret = "integration-envelope-token-secret-32-bytes";
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function startIntegrated(): Promise<string> {
  const fallback = createHttpHandler({
    services: {} as unknown as AppServices,
    authenticate: () => null,
    deferUnmatched: true,
  });
  return listen(createServer(createApp({
    db: {} as unknown as PrismaClient,
    tokenSecret,
    fallback,
  })));
}

// 공통 오류 봉투가 라우터·fallback 경로에서 동일하게 적용되는지 검증한다.
describe("G3-02: 공통 오류 봉투", () => {
  it("C가 매칭하지 못한 경로도 공통 404 봉투와 x-request-id를 쓴다", async () => {
    // 준비: C 핸들러를 fallback으로 붙인 통합 앱
    const baseUrl = await startIntegrated();
    // 실행: C가 모르는 경로 요청
    const res = await fetch(`${baseUrl}/api/v1/__not_a_c_route__`);
    // 확인: 공통 404 봉투와 같은 요청 ID 헤더
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; requestId?: string };
      message?: string;
    };
    expect(body.error?.code).toBe("NOT_FOUND");
    expect(typeof body.error?.requestId).toBe("string");
    expect(res.headers.get("x-request-id")).toBe(body.error?.requestId);
  });

  it("Toss 웹훅 raw body를 보존해 Bearer 없이 C fallback까지 전달한다", async () => {
    // 준비: 원문 body를 기록하는 fallback과 앱
    let reached = false;
    let capturedRawBody: Buffer | undefined;
    const fallback = async (req: IncomingMessage, res: ServerResponse) => {
      reached = true;
      capturedRawBody = (req as IncomingMessage & { rawBody?: Buffer }).rawBody;
      res.statusCode = 418;
      res.end("fallback");
    };
    const baseUrl = await listen(createServer(createApp({
      db: {} as unknown as PrismaClient,
      tokenSecret,
      routers: [Router()],
      fallback,
    })));
    const rawBody = '{\n  "eventType" : "PAYMENT_STATUS_CHANGED", "data": {"status":"DONE"}\n}';

    // 실행: 인증 헤더 없이 whitespace가 포함된 webhook body 요청
    const res = await fetch(`${baseUrl}/api/v1/integrations/toss/payment-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    });
    // 확인: fallback까지 도달하고 Express 파서가 raw bytes를 그대로 보존한다
    expect(res.status).toBe(418);
    expect(reached).toBe(true);
    expect(capturedRawBody).toEqual(Buffer.from(rawBody));
  });

  it("단독 C 핸들러도 공통 404 봉투를 쓴다", async () => {
    // 준비: A 앱 없이 단독으로 띄운 C 핸들러
    const handler = createHttpHandler({
      services: {} as unknown as AppServices,
      authenticate: () => null,
    });
    const baseUrl = await listen(createServer((req, res) => { void handler(req, res); }));
    // 실행: 매칭되지 않는 경로 요청
    const res = await fetch(`${baseUrl}/nope`);
    // 확인: 공통 404 봉투와 같은 요청 ID 헤더
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    expect(body.error?.code).toBe("NOT_FOUND");
    expect(body.error?.message).toBe("NOT_FOUND");
    expect(typeof body.error?.requestId).toBe("string");
    expect(res.headers.get("x-request-id")).toBe(body.error?.requestId);
  });
});
