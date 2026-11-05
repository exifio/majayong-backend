import { describe, expect, it, jest } from "@jest/globals";
import { Role } from "@prisma/client";
import {
  EmailChangeStore,
  completeEmailChange,
  requestEmailChange,
} from "./auth.ts";

describe("인증된 이메일 변경", () => {
  it("서명된 링크를 사용한 뒤에만 갱신하고 링크는 재사용할 수 없다", async () => {
    // 준비
    const now = 1_800_000_000_000;
    const secret = "a-test-secret-that-is-at-least-32-characters";
    let email = "person@example.com";
    let deliveredToken = "";
    const account = () => ({
      id: "user-1", email, role: Role.CLIENT, passwordHash: null,
      termsVersion: "v0.7", termsAgreedAt: new Date(now), suspendedAt: null, withdrawnAt: null,
    });
    const store: EmailChangeStore = {
      findByEmail: jest.fn(async requested => requested === email ? account() : null),
      createUser: jest.fn(async () => { throw new Error("unused"); }),
      findById: jest.fn(async () => account()),
      updateEmailIfCurrent: jest.fn(async (_id: string, current: string, next: string) => {
        if (email !== current) return false;
        email = next;
        return true;
      }),
    };

    // 실행 및 확인
    await requestEmailChange(store, "user-1", "new@example.com", secret, now + 3_600_000, async (_email, token) => {
      deliveredToken = token;
    });
    expect(email).toBe("person@example.com");

    // 실행 및 확인
    await completeEmailChange(store, deliveredToken, secret, now + 1_000);
    expect(email).toBe("new@example.com");

    // 실행 및 확인
    await expect(completeEmailChange(store, deliveredToken, secret, now + 2_000))
      .rejects.toMatchObject({ code: "EMAIL_TOKEN_INVALID" });
  });
});
