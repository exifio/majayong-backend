import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createHttpHandler, type AppServices, type HttpActor } from "./c-app.ts";
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

  async function start(
    servicesValue: AppServices,
    auth?: (req: import("node:http").IncomingMessage) => HttpActor | null,
    cronSecret?: string,
  ) {
    const authenticate =
      auth ??
      ((req: import("node:http").IncomingMessage): HttpActor | null => {
        const userId = req.headers["x-user-id"];
        const role = req.headers["x-role"];
        if (typeof userId !== "string" || typeof role !== "string") return null;
        return { userId, role };
      });
    const server = createServer(
      createHttpHandler({
        services: servicesValue,
        authenticate,
        ...(cronSecret === undefined ? {} : { cronSecret }),
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  type TossWebhookAuth = { signature?: string; transmissionTime?: string; rawPayload?: Uint8Array };
  const TOSS_SECURITY_KEY = "0123456789abcdef".repeat(4);

  function tossWebhookHeaders(rawBody: string): Record<string, string> {
    const transmissionTime = "2026-11-06T10:15:30+09:00";
    const signature = createHmac("sha256", Buffer.from(TOSS_SECURITY_KEY, "hex"))
      .update(rawBody)
      .update(":")
      .update(transmissionTime)
      .digest("base64");
    return {
      "tosspayments-webhook-signature": `v1:${signature}`,
      "tosspayments-webhook-transmission-time": transmissionTime,
    };
  }


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

  it("사용자용 C 성공은 data 봉투를 유지한다", async () => {
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

  it("웹훅 원문 서명 헤더와 raw body를 전달하고 응답은 raw로 유지한다", async () => {
    // 준비
    let received: { auth: TossWebhookAuth; payload: unknown } | undefined;
    const app = await start(
      services({
        deposits: {
          async handleTossWebhook(auth: TossWebhookAuth, payload: unknown) {
            received = { auth, payload };
            return { status: "HELD", deposit: { id: "deposit-1" } };
          },
        } as never,
      }),
    );
    const rawBody = '{\n  "orderId" : "d1", "paymentKey": "p1", "amount": 1000, "status": "DONE"\n}';
    const headers = tossWebhookHeaders(rawBody);
    try {
      // 실행
      const webhook = await fetch(`${app.baseUrl}/integrations/toss/payment-events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: rawBody,
      });
      // 확인
      assert.equal(webhook.status, 200);
      assert.deepEqual(await webhook.json(), { status: "HELD", deposit: { id: "deposit-1" } });
      assert.deepEqual(received?.payload, JSON.parse(rawBody));
      assert.equal(received?.auth.signature, headers["tosspayments-webhook-signature"]);
      assert.equal(received?.auth.transmissionTime, headers["tosspayments-webhook-transmission-time"]);
      assert.deepEqual(Buffer.from(received?.auth.rawPayload ?? []), Buffer.from(rawBody));
    } finally {
      await app.close();
    }
  });

  it("잘못된 JSON 요청은 400으로 거절한다", async () => {
    // 준비
    const app = await start(services());
    try {
      // 실행: 잘못된 JSON 본문 전송
      const invalid = await fetch(`${app.baseUrl}/contracts/c1/deposits`, {
        method: "POST",
        headers: { "x-user-id": "u1", "x-role": "CLIENT", "content-type": "application/json" },
        body: "{",
      });
      // 확인
      assert.equal(invalid.status, 400);
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

  it("관리자 수동 배치 실행은 ADMIN만 호출하고 결과를 돌려준다", async () => {
    // 준비
    const app = await start(
      services({
        runDueJobs: async () => ({ success: true, actionsCount: 1, failures: [] }),
      }),
    );
    try {
      // 실행: 비관리자
      const denied = await fetch(`${app.baseUrl}/admin/jobs/run`, {
        method: "POST",
        headers: { "x-user-id": "client-1", "x-role": "CLIENT" },
      });
      // 확인: 403
      assert.equal(denied.status, 403);

      // 실행: 관리자
      const res = await fetch(`${app.baseUrl}/admin/jobs/run`, {
        method: "POST",
        headers: { "x-user-id": "admin-1", "x-role": "ADMIN" },
      });
      // 확인: 200과 배치 결과
      assert.equal(res.status, 200);
      const body = (await res.json()) as { data?: { actionsCount?: number } };
      assert.equal(body.data?.actionsCount, 1);
    } finally {
      await app.close();
    }
  });

  it("Cron 배치 실행은 CRON_SECRET이 일치할 때만 동작한다", async () => {
    // 준비
    const app = await start(
      services({
        runDueJobs: async () => ({ success: true, actionsCount: 1, failures: [] }),
      }),
      undefined,
      "test-cron-secret",
    );
    try {
      // 실행: 헤더 없음
      const missing = await fetch(`${app.baseUrl}/internal/jobs/run`);
      // 확인: 401
      assert.equal(missing.status, 401);

      // 실행: 잘못된 secret
      const wrong = await fetch(`${app.baseUrl}/internal/jobs/run`, {
        headers: { authorization: "Bearer wrong-secret" },
      });
      // 확인: 401
      assert.equal(wrong.status, 401);

      // 실행: 올바른 secret
      const ok = await fetch(`${app.baseUrl}/internal/jobs/run`, {
        headers: { authorization: "Bearer test-cron-secret" },
      });
      // 확인: 200과 배치 결과
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as { data?: { actionsCount?: number } };
      assert.equal(body.data?.actionsCount, 1);
    } finally {
      await app.close();
    }
  });

  it("CRON_SECRET이 없으면 Cron 배치 실행을 503으로 막는다", async () => {
    // 준비
    const app = await start(services());
    try {
      // 실행
      const res = await fetch(`${app.baseUrl}/internal/jobs/run`, {
        headers: { authorization: "Bearer anything" },
      });
      // 확인: 설정 없음
      assert.equal(res.status, 503);
    } finally {
      await app.close();
    }
  });
});
