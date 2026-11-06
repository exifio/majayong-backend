import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPasswordResetMailerFromEnv,
  createResendPasswordResetMailer,
} from "./mail.ts";

function fetcherWith(status: number) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ id: "mail-1" }), { status });
  };
  return { calls, fetcher };
}

describe("BE-12: 비밀번호 재설정 메일 adapter", () => {
  it("Resend에 발신자·수신자·30분 1회 링크를 담아 POST한다", async () => {
    // 준비
    const { calls, fetcher } = fetcherWith(200);
    const mailer = createResendPasswordResetMailer({
      apiKey: "re_test_key",
      from: "no-reply@example.invalid",
      appBaseUrl: "https://app.example.test/",
      baseUrl: "https://sandbox.resend.test/",
      fetchImpl: fetcher,
    });

    // 실행
    await mailer.sendPasswordReset("user@example.invalid", "token-a b");

    // 확인
    assert.equal(calls[0]?.url, "https://sandbox.resend.test/emails");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(
      (calls[0]?.init?.headers as Record<string, string>).authorization,
      "Bearer re_test_key",
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      from: string;
      to: string;
      subject: string;
      html: string;
    };
    assert.equal(body.from, "no-reply@example.invalid");
    assert.equal(body.to, "user@example.invalid");
    assert.equal(body.subject, "마자용 비밀번호 재설정");
    assert.match(body.html, /https:\/\/app\.example\.test\/reset\?token=token-a%20b/);
    assert.match(body.html, /30분/);
  });

  it("Resend가 실패하면 발송 오류를 던진다", async () => {
    // 준비
    const { fetcher } = fetcherWith(422);
    const mailer = createResendPasswordResetMailer({
      apiKey: "re_test_key",
      from: "no-reply@example.invalid",
      appBaseUrl: "https://app.example.test",
      fetchImpl: fetcher,
    });

    // 실행 및 확인
    await assert.rejects(
      () => mailer.sendPasswordReset("user@example.invalid", "token"),
      /MAIL_DELIVERY_FAILED/,
    );
  });

  it("필수 환경변수가 모두 있어야 mailer를 만든다", () => {
    // 실행 및 확인
    assert.equal(createPasswordResetMailerFromEnv({}), undefined);
    assert.equal(
      createPasswordResetMailerFromEnv({
        RESEND_API_KEY: "re_test_key",
        MAIL_FROM: "no-reply@example.invalid",
      }),
      undefined,
    );
    assert.notEqual(
      createPasswordResetMailerFromEnv({
        RESEND_API_KEY: "re_test_key",
        MAIL_FROM: "no-reply@example.invalid",
        APP_BASE_URL: "https://app.example.test",
      }),
      undefined,
    );
  });
});
