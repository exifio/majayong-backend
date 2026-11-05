import { describe, expect, it } from "@jest/globals";
import { createRequestId, errorResponse, sanitizeLogContext } from "./observability.ts";

describe("A-00 요청·로그 컨텍스트", () => {
  it("오류 응답 봉투에 생성된 요청 ID를 포함한다", () => {
    // 준비
    const requestId = createRequestId();

    // 확인
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(errorResponse("INTERNAL_ERROR", "요청을 처리할 수 없습니다.", requestId)).toEqual({
      error: { code: "INTERNAL_ERROR", message: "요청을 처리할 수 없습니다.", requestId },
    });
  });

  it("구조화 로그 전에 민감 필드를 재귀적으로 제거한다", () => {
    // 준비
    const sanitized = sanitizeLogContext({
      event: "request_failed",
      requestId: "req-1",
      userEmail: "private@example.invalid",
      clientUtterance: "원문",
      nested: { apiKey: "secret", amount: 1234, status: "failed" },
    });

    // 확인
    expect(sanitized).toEqual({
      event: "request_failed",
      requestId: "req-1",
      nested: { status: "failed" },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/private|원문|secret|1234/);
  });
});
