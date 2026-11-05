import { describe, expect, it, jest } from "@jest/globals";
import { Role } from "@prisma/client";
import { GoogleIdentityStore, authenticateWithGoogle } from "./auth.ts";

const now = new Date("2026-11-03T00:00:00.000Z");
const account = {
  id: "user-1",
  email: "person@example.com",
  role: Role.SUPPLIER,
  passwordHash: null,
  termsVersion: "v0.7",
  termsAgreedAt: now,
  suspendedAt: null,
  withdrawnAt: null,
};

function makeGoogleStore(existingByEmail = null as typeof account | null) {
  const store: GoogleIdentityStore = {
    findByEmail: jest.fn(async () => existingByEmail),
    createUser: jest.fn(async () => account),
    findByGoogleSubject: jest.fn(async () => null),
    linkGoogle: jest.fn(async () => account),
    createGoogleUser: jest.fn(async () => account),
  };
  return store;
}

describe("Google 로그인", () => {
  it("선택한 역할과 약관으로 최초 계정을 만든다", async () => {
    // 준비
    const store = makeGoogleStore();

    // 실행 및 확인
    await authenticateWithGoogle(store, {
      subject: "google-subject",
      email: "person@example.com",
      emailVerified: true,
      role: Role.SUPPLIER,
      termsVersion: "v0.7",
      now,
    });

    // 확인
    expect(store.createGoogleUser).toHaveBeenCalledWith({
      email: "person@example.com",
      subject: "google-subject",
      role: Role.SUPPLIER,
      termsVersion: "v0.7",
      termsAgreedAt: now,
    });
  });

  it("기존 이메일을 연결하되 고정 역할은 바꾸지 않는다", async () => {
    // 준비
    const store = makeGoogleStore(account);

    // 실행 및 확인
    await expect(authenticateWithGoogle(store, {
      subject: "google-subject",
      email: "person@example.com",
      emailVerified: true,
      role: Role.SUPPLIER,
      now,
    })).resolves.toEqual({ id: account.id, email: account.email, role: Role.SUPPLIER });

    // 확인
    expect(store.linkGoogle).toHaveBeenCalledWith(account.id, "google-subject");
    expect(store.createGoogleUser).not.toHaveBeenCalled();
  });

  it("다른 역할로 요청한 기존 이메일은 거부한다", async () => {
    // 실행 및 확인
    await expect(authenticateWithGoogle(makeGoogleStore(account), {
      subject: "google-subject",
      email: "person@example.com",
      emailVerified: true,
      role: Role.CLIENT,
      now,
    })).rejects.toMatchObject({ code: "ROLE_MISMATCH" });
  });
});
