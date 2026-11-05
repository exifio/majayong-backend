import { describe, expect, it } from "@jest/globals";
import { mutableClock, systemClock } from "./clock.ts";
import { loadCoreConfig } from "./config.ts";
import { withTransaction, type TransactionHost } from "./transaction.ts";

describe("A-00 공통 포트 제안", () => {
  it("시간 경계 테스트를 위해 변경 가능한 시계를 제공한다", () => {
    // 준비
    const clock = mutableClock(new Date("2026-11-04T00:00:00.000Z"));

    // 확인
    expect(clock.now().toISOString()).toBe("2026-11-04T00:00:00.000Z");

    // 실행 및 확인
    clock.advance(30 * 60 * 1000);
    expect(clock.now().toISOString()).toBe("2026-11-04T00:30:00.000Z");

    // 실행 및 확인
    clock.set(new Date("2026-12-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-12-01T00:00:00.000Z");

    // 확인
    expect(Math.abs(systemClock().now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it("실행 환경 설정을 검증한다", () => {
    // 준비
    const base = {
      DATABASE_URL: "postgresql://tester@localhost:5432/majayong_a00_test",
      TOKEN_SECRET: "x".repeat(32),
    };

    // 실행 및 확인
    const expected = { databaseUrl: base.DATABASE_URL, tokenSecret: base.TOKEN_SECRET };
    expect(loadCoreConfig({ ...base, PORT: "4000" })).toEqual({ ...expected, port: 4000 });
    expect(loadCoreConfig(base)).toEqual({ ...expected, port: 3000 });

    // 확인
    expect(() => loadCoreConfig({ TOKEN_SECRET: base.TOKEN_SECRET })).toThrow();
    expect(() => loadCoreConfig({ ...base, TOKEN_SECRET: "short" })).toThrow();
    expect(() => loadCoreConfig({ ...base, PORT: "abc" })).toThrow();
    expect(() => loadCoreConfig({ ...base, PORT: "70000" })).toThrow();
  });

  it("콜백에 타입이 지정된 트랜잭션 핸들과 상관 ID를 전달한다", async () => {
    // 준비
    const host: TransactionHost<string> = {
      async $transaction<Result>(run: (tx: string) => Promise<Result>): Promise<Result> {
        return run("tx-handle");
      },
    };
    const seen: string[] = [];

    // 실행
    const result = await withTransaction(host, "req-1", async context => {
      seen.push(context.correlationId);
      seen.push(context.tx);
      return 7;
    });

    // 확인
    expect(result).toBe(7);
    expect(seen).toEqual(["req-1", "tx-handle"]);
  });
});
