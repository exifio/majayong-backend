import { describe, expect, it, jest } from "@jest/globals";
import { Role } from "@prisma/client";
import {
  IdentityError,
  IdentityStore,
  authenticateWithEmail,
  hashPassword,
  registerWithEmail,
} from "./auth.ts";

function makeStore(existing: Awaited<ReturnType<IdentityStore["findByEmail"]>> = null) {
  const store: IdentityStore = {
    findByEmail: jest.fn(async () => existing),
    createUser: jest.fn(async (input: Parameters<IdentityStore["createUser"]>[0]) => ({
      id: "new-user",
      email: input.email,
      role: input.role,
      passwordHash: input.passwordHash,
      termsVersion: input.termsVersion,
      termsAgreedAt: input.termsAgreedAt,
      suspendedAt: null,
      withdrawnAt: null,
    })),
  };
  return store;
}

const input = {
  email: " Person@Example.com ",
  password: "LongPass123",
  role: Role.CLIENT,
  termsVersion: "v0.7",
  now: new Date("2026-11-03T00:00:00.000Z"),
};

describe("이메일 인증", () => {
  it("정규화된 이메일, 고정 역할, 비밀번호 해시, 약관 동의를 저장한다", async () => {
    // 준비
    const store = makeStore();

    // 실행 및 확인
    await expect(registerWithEmail(store, input)).resolves.toEqual({
      id: "new-user",
      email: "person@example.com",
      role: Role.CLIENT,
    });

    // 확인
    expect(store.createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "person@example.com",
      role: Role.CLIENT,
      termsVersion: "v0.7",
      termsAgreedAt: input.now,
    }));
    const created = jest.mocked(store.createUser).mock.calls[0]?.[0];
    expect(created?.passwordHash).not.toBe(input.password);
  });

  it("같은 역할이든 충돌하는 역할이든 중복 이메일을 거부한다", async () => {
    // 준비
    const account = {
      id: "existing-user",
      email: "person@example.com",
      role: Role.SUPPLIER,
      passwordHash: "stored-hash",
      termsVersion: "v0.7",
      termsAgreedAt: input.now,
      suspendedAt: null,
      withdrawnAt: null,
    };
    const store = makeStore(account);

    // 실행 및 확인
    await expect(registerWithEmail(store, input)).rejects.toMatchObject({ code: "ROLE_MISMATCH" });
    await expect(registerWithEmail(store, { ...input, role: Role.SUPPLIER })).rejects.toMatchObject({
      code: "EMAIL_ALREADY_REGISTERED",
    });

    // 확인
    expect(store.createUser).not.toHaveBeenCalled();
  });

  it("잘못된 자격 증명과 비활성 계정을 거부한다", async () => {
    // 준비
    const passwordHash = await hashPassword(input.password);
    const store = makeStore({
      id: "existing-user",
      email: "person@example.com",
      role: Role.CLIENT,
      passwordHash,
      termsVersion: "v0.7",
      termsAgreedAt: input.now,
      suspendedAt: null,
      withdrawnAt: null,
    });

    // 실행 및 확인
    await expect(authenticateWithEmail(store, { email: input.email, password: "WrongPass123" }))
      .rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(authenticateWithEmail(makeStore({
      id: "withdrawn-user", email: "person@example.com", role: Role.CLIENT, passwordHash,
      termsVersion: "v0.7", termsAgreedAt: input.now, suspendedAt: null, withdrawnAt: input.now,
    }), { email: input.email, password: input.password })).rejects.toBeInstanceOf(IdentityError);
  });
});
