import { describe, expect, it, jest } from "@jest/globals";
import { AuthProvider, Role } from "@prisma/client";
import { PasswordResetStore, hashPassword, setPassword } from "./auth.ts";

describe("계정 비밀번호 변경", () => {
  it("인증된 Google 전용 계정이 비밀번호를 만들 수 있다", async () => {
    // 준비
    let currentHash: string | null = null;
    const store: PasswordResetStore = {
      findByEmail: jest.fn(async () => null),
      createUser: jest.fn(async () => { throw new Error("unused"); }),
      findById: jest.fn(async () => ({
        id: "user-1", email: "person@example.com", role: Role.CLIENT, passwordHash: currentHash,
        termsVersion: "v0.7", termsAgreedAt: new Date(), suspendedAt: null, withdrawnAt: null,
        authProvider: AuthProvider.GOOGLE, providerUserId: "google-subject",
      })),
      updatePasswordHashIfCurrent: jest.fn(async (_id: string, expected: string | null, next: string) => {
        if (currentHash !== expected) return false;
        currentHash = next;
        return true;
      }),
    };

    // 실행 및 확인
    await expect(setPassword(store, "user-1", undefined, "NewPass456")).resolves.toBeUndefined();
    expect(currentHash).not.toBeNull();

    // 실행 및 확인
    await expect(setPassword(store, "user-1", undefined, "AnotherPass789"))
      .rejects.toMatchObject({ code: "CURRENT_PASSWORD_REQUIRED" });
  });
});
