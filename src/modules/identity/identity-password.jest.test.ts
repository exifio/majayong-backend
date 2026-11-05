import { describe, expect, it } from "@jest/globals";
import { hashPassword, verifyPassword } from "./auth.ts";

describe("비밀번호 해싱", () => {
  it("솔트가 적용된 해시를 저장하고 일치하는 비밀번호만 검증한다", async () => {
    // 준비
    const firstHash = await hashPassword("LongPass123");
    const secondHash = await hashPassword("LongPass123");

    // 확인
    expect(firstHash).not.toBe("LongPass123");
    expect(firstHash).not.toBe(secondHash);
    await expect(verifyPassword("LongPass123", firstHash)).resolves.toBe(true);
    await expect(verifyPassword("WrongPass123", firstHash)).resolves.toBe(false);
    await expect(verifyPassword("LongPass123", "malformed")).resolves.toBe(false);
  });

  it("ASCII 문자와 숫자를 포함해 8자 이상이어야 한다", async () => {
    // 실행 및 확인
    await expect(hashPassword("short1A")).rejects.toThrow("WEAK_PASSWORD");
    await expect(hashPassword("lettersOnly")).rejects.toThrow("WEAK_PASSWORD");
    await expect(hashPassword("12345678")).rejects.toThrow("WEAK_PASSWORD");
  });
});
