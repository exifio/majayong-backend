import { describe, expect, it } from "@jest/globals";
import { sanitizeLogContext } from "./observability.ts";

// v0.6.1 src/shared/events.ts의 SENSITIVE_PAYLOAD_KEYS를 그대로 옮겼다.
// v0.6.1이 마스킹한 키는 v0.7 로그 정화기에서도 반드시 마스킹해야 한다. 아니면 PII가 로그로 되돌아온다.
const legacySensitiveKeys = [
  "content",
  "rawContent",
  "rawText",
  "utterance",
  "phone",
  "email",
  "businessName",
  "password",
  "passwordHash",
  "secretKey",
  "apiKey",
  "accessToken",
  "refreshToken",
];

describe("A-00 v0.6.1 → v0.7 보안 기준선", () => {
  it("v0.6.1이 민감하다고 본 모든 키를 중첩 객체까지 마스킹한다", () => {
    // 준비
    const nested: Record<string, unknown> = {};
    for (const key of legacySensitiveKeys) nested[key] = "secret-value";
    const sanitized = sanitizeLogContext({ event: "kept", requestId: "kept", nested });
    const text = JSON.stringify(sanitized);

    // 확인
    for (const key of legacySensitiveKeys) expect(text).not.toContain(key);
    expect(text).not.toContain("secret-value");
    expect(text).toContain("kept");
  });

  it("관측을 위한 비민감 진단 정보는 남긴다", () => {
    // 준비
    const sanitized = sanitizeLogContext({ event: "request_failed", requestId: "req-1", status: "failed", latencyMs: 42 });
    const text = JSON.stringify(sanitized);

    // 확인
    expect(text).toContain("request_failed");
    expect(text).toContain("req-1");
    expect(text).toContain("failed");
    expect(text).toContain("42");
  });
});
