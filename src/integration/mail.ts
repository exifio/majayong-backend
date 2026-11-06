/**
 * BE-12: 비밀번호 재설정 메일 발송 adapter.
 *
 * provider는 Resend HTTP API를 쓴다(추가 dependency 없이 fetch만 사용).
 * 키/발신 도메인/앱 URL이 모두 설정된 경우에만 활성화되고, 없으면 기존처럼
 * 비밀번호 재설정 요청은 503 DELIVERY_UNAVAILABLE로 남는다.
 * 토큰·이메일 원문은 로그에 남기지 않는다.
 */
export interface PasswordResetMailer {
  sendPasswordReset(email: string, token: string): Promise<void>;
}

export interface ResendMailerOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly appBaseUrl: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const SUBJECT = "마자용 비밀번호 재설정";

export function createResendPasswordResetMailer(
  options: ResendMailerOptions,
): PasswordResetMailer {
  const base = (options.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
  const resetUrl = `${options.appBaseUrl.replace(/\/+$/, "")}/reset`;
  const fetcher = options.fetchImpl ?? fetch;

  return {
    async sendPasswordReset(email, token) {
      const link = `${resetUrl}?token=${encodeURIComponent(token)}`;
      const response = await fetcher(`${base}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: options.from,
          to: email,
          subject: SUBJECT,
          html: [
            "<p>비밀번호를 다시 설정하려면 아래 링크를 여세요.</p>",
            `<p><a href="${link}">비밀번호 재설정</a></p>`,
            "<p>링크는 30분 동안 한 번만 사용할 수 있습니다. 요청하지 않았다면 무시하세요.</p>",
          ].join(""),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok) throw new Error("MAIL_DELIVERY_FAILED");
    },
  };
}

/** 필수 환경변수가 모두 있을 때만 mailer를 만든다. */
export function createPasswordResetMailerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): PasswordResetMailer | undefined {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  const appBaseUrl = env.APP_BASE_URL?.trim();
  if (!apiKey || !from || !appBaseUrl) return undefined;
  return createResendPasswordResetMailer({
    apiKey,
    from,
    appBaseUrl,
    baseUrl: env.RESEND_API_BASE_URL?.trim(),
    fetchImpl,
  });
}
