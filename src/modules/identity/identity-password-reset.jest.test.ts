import { describe, expect, it, jest } from "@jest/globals";
import { Role } from "@prisma/client";
import {
  PasswordResetStore,
  completePasswordReset,
  hashPassword,
  issuePasswordResetToken,
} from "./auth.ts";

const secret = "a-test-secret-that-is-at-least-32-characters";
const now = 1_800_000_000_000;

describe("비밀번호 재설정 완료", () => {
  it("비밀번호를 한 번 변경하고 토큰 재사용을 거부한다", async () => {
    // 준비
    let currentHash = await hashPassword("CurrentPass123");
    const originalHash = currentHash;
    const account = {
      id: "user-1", email: "person@example.com", role: Role.CLIENT,
      termsVersion: "v0.7", termsAgreedAt: new Date(now), suspendedAt: null, withdrawnAt: null,
    };
    const store: PasswordResetStore = {
      findByEmail: jest.fn(async () => null),
      createUser: jest.fn(async () => ({ ...account, passwordHash: currentHash })),
      findById: jest.fn(async () => ({ ...account, passwordHash: currentHash })),
      updatePasswordHashIfCurrent: jest.fn(async (_id: string, expected: string, next: string) => {
        if (currentHash !== expected) return false;
        currentHash = next;
        return true;
      }),
    };
    const token = issuePasswordResetToken(account.id, originalHash, secret, now);

    // 실행 및 확인
    await expect(completePasswordReset(store, {
      token,
      newPassword: "NewPass456",
      secret,
      now: now + 1_000,
    })).resolves.toBeUndefined();

    // 실행 및 확인
    await expect(completePasswordReset(store, {
      token,
      newPassword: "AnotherPass789",
      secret,
      now: now + 2_000,
    })).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID" });

    // 확인
    expect(currentHash).not.toBe(originalHash);
  });
});
