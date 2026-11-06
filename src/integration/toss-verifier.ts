/**
 * D-08: Toss Payments sandbox 결제 재조회 어댑터.
 *
 * 서버에서만 secret key를 쓰며, 결제 완료는 서버측 PG 조회 결과를 확인한다.
 * 결제키 조회는 주문번호·결제키·금액·DONE 상태가 모두 일치할 때만 verified=true다.
 */
import type { TossOrderLookup, TossVerifyAdapter } from "../modules/deposit/index.js";

export interface TossSandboxVerifierOptions {
  readonly secretKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface TossPayment {
  readonly orderId?: unknown;
  readonly paymentKey?: unknown;
  readonly totalAmount?: unknown;
  readonly status?: unknown;
}

export function createTossSandboxVerifier(
  options: TossSandboxVerifierOptions,
): Required<TossVerifyAdapter> {
  const base = (options.baseUrl ?? "https://api.tosspayments.com").replace(/\/+$/, "");
  const fetcher = options.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.secretKey}:`).toString("base64")}`;

  return {
    async verifyPayment(orderId, paymentKey, amount) {
      const response = await fetcher(`${base}/v1/payments/${encodeURIComponent(paymentKey)}`, {
        method: "GET",
        headers: { authorization },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok) return { verified: false, retryable: true };
      const body = (await response.json()) as TossPayment;
      return normalizePayment(body, orderId, paymentKey, amount);
    },
    async findPaymentByOrderId(orderId) {
      const response = await fetcher(`${base}/v1/payments/orders/${encodeURIComponent(orderId)}`, {
        method: "GET",
        headers: { authorization },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (response.status === 404) return { found: false };
      if (!response.ok) return { found: false, retryable: true };
      const body = (await response.json()) as TossPayment;
      return {
        found: true,
        orderId: body.orderId,
        paymentKey: body.paymentKey,
        amount: body.totalAmount,
        status: body.status,
      } satisfies TossOrderLookup;
    },

    async confirmPayment(orderId, paymentKey, amount) {
      const response = await fetcher(`${base}/v1/payments/confirm`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ paymentKey, orderId, amount }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok) return { verified: false };
      const body = (await response.json()) as TossPayment;
      return normalizePayment(body, orderId, paymentKey, amount);
    },
  };
}

function normalizePayment(
  body: TossPayment,
  orderId: string,
  paymentKey: string,
  amount: number,
): {
  verified: boolean;
  orderId: unknown;
  paymentKey: unknown;
  amount: unknown;
  status: unknown;
} {
  const verified =
    body.orderId === orderId &&
    body.paymentKey === paymentKey &&
    body.totalAmount === amount &&
    body.status === "DONE";
  return {
    verified,
    orderId: body.orderId,
    paymentKey: body.paymentKey,
    amount: body.totalAmount,
    status: body.status,
  };
}
