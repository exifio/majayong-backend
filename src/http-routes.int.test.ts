import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createHttpHandler, ROUTE_PATHS, type AppServices, type HttpActor } from "./c-app.ts";
import { createTokenAuthenticator, signAccessToken } from "./infrastructure/token-auth.ts";

describe("INT-C-01: HTTP 라우트", () => {
  function services(overrides: Partial<AppServices> = {}): AppServices {
    const unused = async () => {
      throw Object.assign(new Error("NOT_IMPLEMENTED_IN_TEST"), { status: 501 });
    };
    return {
      deposits: { getDeposits: async () => [], createDeposit: unused, handleTossWebhook: unused } as never,
      deliveries: {} as never,
      settlement: {} as never,
      cancellations: {} as never,
      reviews: {} as never,
      files: {} as never,
      admin: {} as never,
      ...overrides,
    };
  }

  async function start(servicesValue: AppServices, auth?: (req: import("node:http").IncomingMessage) => HttpActor | null) {
    const authenticate =
      auth ??
      ((req: import("node:http").IncomingMessage): HttpActor | null => {
        const userId = req.headers["x-user-id"];
        const role = req.headers["x-role"];
        if (typeof userId !== "string" || typeof role !== "string") return null;
        return { userId, role };
      });
    const server = createServer(createHttpHandler({ services: servicesValue, authenticate }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("34개 operation 경로가 중복 없이 매핑됨", () => {
    // 확인
    assert.equal(ROUTE_PATHS.length, 34);
    assert.equal(new Set(ROUTE_PATHS).size, 34);
  });

  it("인증·404·오류 status 매핑", async () => {
    // 준비
    const app = await start(services());
    try {
      // 실행: 인증 없이 호출
      const unauthorized = await fetch(`${app.baseUrl}/contracts/c1/deposits`);
      // 확인
      assert.equal(unauthorized.status, 401);

      // 실행: 없는 경로 호출
      const missing = await fetch(`${app.baseUrl}/nope`, {
        headers: { "x-user-id": "u1", "x-role": "CLIENT" },
      });
      // 확인
      assert.equal(missing.status, 404);
    } finally {
      await app.close();
    }
  });

  it("서비스 오류 status를 그대로 응답", async () => {
    // 준비
    const app = await start(
      services({
        deposits: {
          async getDeposits() {
            throw Object.assign(new Error("계약 당사자만 조회할 수 있습니다."), { status: 403 });
          },
        } as never,
      }),
    );
    try {
      // 실행
      const res = await fetch(`${app.baseUrl}/contracts/c1/deposits`, {
        headers: { "x-user-id": "u1", "x-role": "CLIENT" },
      });
      // 확인
      assert.equal(res.status, 403);
      const body = (await res.json()) as {
        error?: { code?: string; message?: string; requestId?: string };
      };
      assert.equal(body.error?.code, "FORBIDDEN");
      assert.equal(body.error?.message, "계약 당사자만 조회할 수 있습니다.");
      assert.equal(typeof body.error?.requestId, "string");
      assert.equal(res.headers.get("x-request-id"), body.error?.requestId);
    } finally {
      await app.close();
    }
  });

  it("사용자용 C 성공은 data 봉투, 웹훅은 raw 응답을 유지한다", async () => {
    // 준비
    const app = await start(
      services({
        deposits: {
          async getDeposits() {
            return [{ id: "deposit-1" }];
          },
        } as never,
      }),
    );
    try {
      // 실행
      const list = await fetch(`${app.baseUrl}/contracts/c1/deposits`, {
        headers: { "x-user-id": "u1", "x-role": "CLIENT" },
      });
      // 확인
      assert.equal(list.status, 200);
      assert.deepEqual(await list.json(), { data: [{ id: "deposit-1" }] });
      assert.ok(list.headers.get("x-request-id"));
    } finally {
      await app.close();
    }
  });

  it("웹훅 응답은 data 봉투 없이 raw를 유지한다", async () => {
    // 준비
    const app = await start(
      services({
        deposits: {
          async handleTossWebhook() {
            return { status: "HELD", deposit: { id: "deposit-1" } };
          },
        } as never,
      }),
    );
    try {
      // 실행
      const webhook = await fetch(`${app.baseUrl}/integrations/toss/payment-events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-toss-webhook-secret": "secret-1" },
        body: JSON.stringify({ orderId: "d1", paymentKey: "p1", amount: 1000, status: "DONE" }),
      });
      // 확인
      assert.equal(webhook.status, 200);
      assert.deepEqual(await webhook.json(), { status: "HELD", deposit: { id: "deposit-1" } });
    } finally {
      await app.close();
    }
  });

  it("본문 없음·잘못된 JSON·웹훅 헤더 전달", async () => {
    // 준비
    let webhookSecret: string | undefined;
    const app = await start(
      services({
        deposits: {
          async handleTossWebhook(auth: { serverSecret?: string }) {
            webhookSecret = auth.serverSecret;
            return { status: "HELD", deposit: {} };
          },
        } as never,
      }),
    );
    try {
      // 실행: 잘못된 JSON 본문 전송
      const invalid = await fetch(`${app.baseUrl}/contracts/c1/deposits`, {
        method: "POST",
        headers: { "x-user-id": "u1", "x-role": "CLIENT", "content-type": "application/json" },
        body: "{",
      });
      // 확인
      assert.equal(invalid.status, 400);

      // 실행: 웹훅 시크릿 헤더 전송
      const webhook = await fetch(`${app.baseUrl}/integrations/toss/payment-events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-toss-webhook-secret": "secret-1" },
        body: JSON.stringify({ orderId: "d1", paymentKey: "p1", amount: 1000, status: "DONE" }),
      });
      // 확인
      assert.equal(webhook.status, 200);
      assert.equal(webhookSecret, "secret-1");
    } finally {
      await app.close();
    }
  });

  it("HS256 Bearer 토큰을 검증하고 만료·변조를 거부", async () => {
    // 준비
    const secret = "test-auth-secret";
    const clock = { now: () => new Date("2026-11-04T00:00:00.000Z") };
    const authenticate = createTokenAuthenticator(secret, clock);
    const app = await start(
      services({
        deposits: { async getDeposits() { return []; } } as never,
      }),
      authenticate,
    );
    try {
      // 실행: 유효 토큰로 호출
      const valid = signAccessToken(
        { userId: "u1", role: "CLIENT", exp: Math.floor(new Date("2026-11-05T00:00:00.000Z").getTime() / 1000) },
        secret,
      );
      const ok = await fetch(`${app.baseUrl}/contracts/c1/deposits`, {
        headers: { authorization: `Bearer ${valid}` },
      });
      // 확인
      assert.equal(ok.status, 200);

      // 실행: 만료 토큰로 호출
      const expired = signAccessToken(
        { userId: "u1", role: "CLIENT", exp: Math.floor(new Date("2026-11-03T00:00:00.000Z").getTime() / 1000) },
        secret,
      );
      // 확인
      assert.equal(
        (await fetch(`${app.baseUrl}/contracts/c1/deposits`, { headers: { authorization: `Bearer ${expired}` } })).status,
        401,
      );

      // 실행: 변조 토큰·개발 헤더로 호출
      const tampered = `${valid.slice(0, -2)}xx`;
      // 확인
      assert.equal(
        (await fetch(`${app.baseUrl}/contracts/c1/deposits`, { headers: { authorization: `Bearer ${tampered}` } })).status,
        401,
      );
      // 토큰 인증이 켜지면 개발 헤더는 무시된다.
      assert.equal(
        (await fetch(`${app.baseUrl}/contracts/c1/deposits`, { headers: { "x-user-id": "u1", "x-role": "ADMIN" } })).status,
        401,
      );
    } finally {
      await app.close();
    }
  });

  it("관리자 EventLog 쿼리를 서비스 필터로 전달", async () => {
    // 준비
    let received: Record<string, unknown> | undefined;
    const app = await start(
      services({
        admin: {
          async listEventLogs(_actor: unknown, filter: Record<string, unknown>) {
            received = filter;
            return [];
          },
        } as never,
      }),
    );
    try {
      // 실행
      const res = await fetch(
        `${app.baseUrl}/admin/event-logs?actorUserId=admin-1&actionType=BLOCK_UPDATE&from=2026-11-01T00:00:00.000Z`,
        { headers: { "x-user-id": "admin-1", "x-role": "ADMIN" } },
      );
      // 확인
      assert.equal(res.status, 200);
      assert.equal(received?.actorUserId, "admin-1");
      assert.equal(received?.actionType, "BLOCK_UPDATE");
      assert.ok(received?.from instanceof Date);
    } finally {
      await app.close();
    }
  });
});
