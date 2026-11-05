import { describe, expect, it } from "@jest/globals";
import { assertTestDatabase } from "./test-database.ts";

describe("A-00 데이터베이스 테스트 격리", () => {
  it("전용 로컬 테스트 데이터베이스를 허용하고 그대로 돌려준다", () => {
    // 실행 및 확인
    expect(assertTestDatabase("postgresql://tester@localhost:5432/majayong_a00_test"))
      .toBe("postgresql://tester@localhost:5432/majayong_a00_test");
    expect(() => assertTestDatabase("postgresql://tester@127.0.0.1:5432/majayong_a00_test")).not.toThrow();
    expect(() => assertTestDatabase("postgresql://tester@[::1]:5432/majayong_a00_test")).not.toThrow();
    expect(() => assertTestDatabase("postgresql://tester@localhost:5432/majayong_gate2_check")).not.toThrow();
  });

  it("테스트 데이터베이스 URL이 없거나 비어 있으면 거부한다", () => {
    // 실행 및 확인
    expect(() => assertTestDatabase(undefined)).toThrow();
    expect(() => assertTestDatabase("")).toThrow();
    expect(() => assertTestDatabase("   ")).toThrow();
  });

  it("운영·원격 데이터베이스는 거부한다", () => {
    // 실행 및 확인
    expect(() => assertTestDatabase("not a url")).toThrow();
    expect(() => assertTestDatabase("postgresql://tester@localhost:5432/majayong")).toThrow();
    expect(() => assertTestDatabase("postgresql://tester@db.example.com:5432/majayong_a00_test")).toThrow();
    expect(() => assertTestDatabase("postgresql://tester@10.0.0.5:5432/majayong_a00_test")).toThrow();
  });
});
