import { describe, expect, it, jest } from "@jest/globals";
import { AuthProvider, Role } from "@prisma/client";
import { GoogleDisconnectStore, disconnectGoogle } from "./auth.ts";

describe("Google 계정 연결 해제", () => {
  it("Google 전용 계정은 비밀번호가 있어야 연결을 해제한다", async () => {
    // 준비
    const now = new Date("2026-11-03T00:00:00.000Z");
    const store: GoogleDisconnectStore = {
      findByEmail: jest.fn(async () => null),
      createUser: jest.fn(async () => { throw new Error("unused"); }),
      findById: jest.fn(async () => ({
        id: "user-1", email: "person@example.com", role: Role.CLIENT, passwordHash: null,
        termsVersion: "v0.7", termsAgreedAt: now, suspendedAt: null, withdrawnAt: null,
        authProvider: AuthProvider.GOOGLE, providerUserId: "google-subject",
      })),
      disconnectGoogleIfCurrent: jest.fn(async () => true),
    };

    // 실행 및 확인
    await expect(disconnectGoogle(store, "user-1", "AnyPass123"))
      .rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });

    // 확인
    expect(store.disconnectGoogleIfCurrent).not.toHaveBeenCalled();
  });
});
