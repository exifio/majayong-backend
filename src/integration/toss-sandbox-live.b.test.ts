import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTossSandboxVerifier } from "./toss-verifier.ts";

// 실제 Toss sandbox 자격 증명 검증. 키/결제건이 없으면 skip한다(실제 결제·송금 없음).
const secretKey = process.env.TOSS_SECRET_KEY;
const baseUrl = (process.env.TOSS_SANDBOX_BASE_URL ?? "https://api.tosspayments.com").replace(/\/+$/, "");
const paymentKey = process.env.TOSS_TEST_PAYMENT_KEY;
const orderId = process.env.TOSS_TEST_ORDER_ID;
const amount = process.env.TOSS_TEST_AMOUNT ? Number(process.env.TOSS_TEST_AMOUNT) : undefined;

describe("INT-D08: Toss sandbox 자격 증명", { skip: secretKey ? false : "TOSS_SECRET_KEY 없음" }, () => {
  it("secret key 인증이 유효하다(잘못된 paymentKey는 401이 아니다)", async () => {
    // 준비
    const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
    // 실행
    const response = await fetch(`${baseUrl}/v1/payments/pk_invalid_${Date.now()}`, {
      headers: { authorization },
    });
    // 확인
    assert.notEqual(response.status, 401, "secret key 인증 실패");
    assert.ok([400, 403, 404].includes(response.status), `예상하지 못한 상태: ${response.status}`);
  });

  it("검증된 sandbox 결제건이 있으면 DONE 증빙을 확인한다", {
    skip: paymentKey && orderId && amount ? false : "TOSS_TEST_PAYMENT_KEY/ORDER_ID/AMOUNT 없음",
  }, async () => {
    // 준비
    const verifier = createTossSandboxVerifier({ secretKey: secretKey as string, baseUrl });
    // 실행
    const evidence = await verifier.verifyPayment(orderId as string, paymentKey as string, amount as number);
    // 확인
    const result = evidence as { verified?: boolean; status?: unknown; amount?: unknown };
    assert.equal(result.verified, true);
    assert.equal(result.status, "DONE");
    assert.equal(result.amount, amount);
  });
});
