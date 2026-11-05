import { describe, expect, it } from "@jest/globals";
import { Role } from "@prisma/client";
import {
  issueAccessToken,
  issueGoogleOnboardingToken,
  issuePasswordResetToken,
  verifyAccessToken,
  verifyGoogleOnboardingToken,
  verifyPasswordResetToken,
} from "./auth.ts";

const secret = "a-test-secret-that-is-at-least-32-characters";

describe("서명 토큰", () => {
  it("만료·위조 액세스 토큰을 거부한다", () => {
    // 준비
    const now = 1_800_000_000_000;

    // 실행
    const token = issueAccessToken({ userId: "user-1", role: Role.CLIENT, expiresAt: now + 60_000 }, secret);

    // 확인
    expect(verifyAccessToken(token, secret, now)).toEqual({
      userId: "user-1",
      role: Role.CLIENT,
      expiresAt: now + 60_000,
    });
    expect(verifyAccessToken(token, secret, now + 60_000)).toBeNull();
    expect(verifyAccessToken(`${token.slice(0, -1)}x`, secret, now)).toBeNull();
  });

  it("비밀번호 재설정은 30분까지 허용하고 이후 만료·재사용을 거부한다", () => {
    // 준비
    const now = 1_800_000_000_000;
    const oldHash = "scrypt$old-password-hash";

    // 실행
    const token = issuePasswordResetToken("user-1", oldHash, secret, now);

    // 확인
    expect(verifyPasswordResetToken(token, "user-1", oldHash, secret, now + 1_799_999)).toBe(true);
    expect(verifyPasswordResetToken(token, "user-1", oldHash, secret, now + 1_800_000)).toBe(false);
    expect(verifyPasswordResetToken(token, "user-1", "scrypt$new-password-hash", secret, now + 1_000)).toBe(false);
    expect(verifyPasswordResetToken(token, "user-2", oldHash, secret, now + 1_000)).toBe(false);
  });

  it("서명된 Google 온보딩 토큰을 10분으로 제한한다", () => {
    // 준비
    const now = 1_800_000_000_000;

    // 실행
    const token = issueGoogleOnboardingToken({ subject: "google-subject", email: "Person@Example.com" }, secret, now);

    // 확인
    expect(verifyGoogleOnboardingToken(token, secret, now + 599_999)).toEqual({
      subject: "google-subject",
      email: "person@example.com",
    });
    expect(verifyGoogleOnboardingToken(token, secret, now + 600_000)).toBeNull();
    expect(verifyGoogleOnboardingToken(`${token.slice(0, -1)}x`, secret, now + 1)).toBeNull();
  });
});
