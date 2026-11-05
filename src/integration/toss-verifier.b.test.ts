import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTossSandboxVerifier } from "./toss-verifier.ts";

function fetcherWith(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetcher };
}

describe("D-08: Toss sandbox 재조회 어댑터", () => {
  it("orderId·paymentKey·금액·DONE이 모두 일치할 때만 verified=true", async () => {
    // 준비
    const { calls, fetcher } = fetcherWith(200, {
      orderId: "order-1",
      paymentKey: "pk-1",
      totalAmount: 3_255_000,
      status: "DONE",
    });
    const verifier = createTossSandboxVerifier({
      secretKey: "test_sk_dummy",
      baseUrl: "https://sandbox.tosspayments.test/",
      fetchImpl: fetcher,
    });

    // 실행
    const evidence = await verifier.verifyPayment("order-1", "pk-1", 3_255_000);
    // 확인
    assert.equal((evidence as { verified: boolean }).verified, true);
    assert.equal(calls[0]?.url, "https://sandbox.tosspayments.test/v1/payments/pk-1");
    assert.equal(
      (calls[0]?.init?.headers as Record<string, string>).authorization,
      `Basic ${Buffer.from("test_sk_dummy:").toString("base64")}`,
    );
  });

  it("금액·주문·상태가 다르면 verified=false", async () => {
    // 준비
    const verifier = createTossSandboxVerifier({
      secretKey: "test_sk_dummy",
      fetchImpl: async () =>
        new Response(JSON.stringify({
          orderId: "order-2",
          paymentKey: "pk-1",
          totalAmount: 1_000,
          status: "CANCELED",
        }), { status: 200 }),
    });
    // 실행 및 확인
    const evidence = await verifier.verifyPayment("order-1", "pk-1", 3_255_000);
    assert.equal((evidence as { verified: boolean }).verified, false);
  });

  it("PG 조회가 실패하면 verified=false", async () => {
    // 준비
    const verifier = createTossSandboxVerifier({
      secretKey: "test_sk_dummy",
      fetchImpl: async () => new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 }),
    });
    // 실행 및 확인
    assert.equal((await verifier.verifyPayment("o", "p", 1) as { verified: boolean }).verified, false);
  });
});
