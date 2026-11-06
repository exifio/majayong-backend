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

  it("orderId 조회는 Toss 원형 결제 객체를 반환한다", async () => {
    // 준비
    const { calls, fetcher } = fetcherWith(200, {
      orderId: "order-1",
      paymentKey: "pk-1",
      totalAmount: 3_255_000,
      status: "DONE",
    });
    const verifier = createTossSandboxVerifier({
      secretKey: "test_sk_dummy",
      baseUrl: "https://sandbox.tosspayments.test",
      fetchImpl: fetcher,
    });

    // 실행
    const result = await verifier.findPaymentByOrderId("order/1");

    // 확인
    assert.equal(calls[0]?.url, "https://sandbox.tosspayments.test/v1/payments/orders/order%2F1");
    assert.deepEqual(result, {
      found: true,
      orderId: "order-1",
      paymentKey: "pk-1",
      amount: 3_255_000,
      status: "DONE",
    });
  });

  it("주문 결제 없음은 재시도하지 않고 PG 오류는 재시도로 표시한다", async () => {
    // 준비
    const notFound = createTossSandboxVerifier({
      secretKey: "test_sk_dummy",
      fetchImpl: async () => new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 }),
    });
    const unavailable = createTossSandboxVerifier({
      secretKey: "test_sk_dummy",
      fetchImpl: async () => new Response(JSON.stringify({ code: "UNAVAILABLE" }), { status: 503 }),
    });

    // 실행 및 확인
    assert.deepEqual(await notFound.findPaymentByOrderId("order-1"), { found: false });
    assert.deepEqual(await unavailable.findPaymentByOrderId("order-1"), { found: false, retryable: true });
  });

  it("PG HTTP 오류는 Toss 재전송을 위한 재시도 실패로 표시한다", async () => {
    // 준비
    const verifier = createTossSandboxVerifier({
      secretKey: "test_sk_dummy",
      fetchImpl: async () => new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 }),
    });
    // 실행 및 확인
    const evidence = await verifier.verifyPayment("o", "p", 1) as { verified: boolean; retryable?: boolean };
    assert.equal(evidence.verified, false);
    assert.equal(evidence.retryable, true);
  });

  it("결제 승인은 서버가 저장한 주문·금액으로 POST confirm하고 DONE일 때만 verified=true", async () => {
    // 준비
    const { calls, fetcher } = fetcherWith(200, {
      orderId: "order-1",
      paymentKey: "pk-1",
      totalAmount: 3_255_000,
      status: "DONE",
    });
    const verifier = createTossSandboxVerifier({
      secretKey: "test_sk_dummy",
      baseUrl: "https://sandbox.tosspayments.test",
      fetchImpl: fetcher,
    });

    // 실행
    const evidence = await verifier.confirmPayment("order-1", "pk-1", 3_255_000);

    // 확인: 승인 URL·메서드·본문이 서버 저장값과 일치한다
    assert.equal((evidence as { verified: boolean }).verified, true);
    assert.equal(calls[0]?.url, "https://sandbox.tosspayments.test/v1/payments/confirm");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      paymentKey: "pk-1",
      orderId: "order-1",
      amount: 3_255_000,
    });
  });

  it("결제 승인 응답이 실패면 verified=false", async () => {
    // 준비
    const verifier = createTossSandboxVerifier({
      secretKey: "test_sk_dummy",
      fetchImpl: async () => new Response(JSON.stringify({ code: "ALREADY_PROCESSED_PAYMENT" }), { status: 400 }),
    });
    // 실행 및 확인
    assert.equal((await verifier.confirmPayment("o", "p", 1) as { verified: boolean }).verified, false);
  });
});
