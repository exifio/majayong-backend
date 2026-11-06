import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminOpsService } from "./modules/admin-ops/index.ts";
import type { CancellationService } from "./modules/cancellation/index.ts";
import type { DeliveryService } from "./modules/delivery/index.ts";
import type { DepositService } from "./modules/deposit/index.ts";
import type { FileService } from "./modules/files/index.ts";
import type { ReviewService } from "./modules/review/index.ts";
import type { SettlementService } from "./modules/settlement/policy.ts";

export interface HttpActor {
  userId: string;
  role: string;
}

export interface AppServices {
  deposits: DepositService;
  deliveries: DeliveryService;
  settlement: SettlementService;
  cancellations: CancellationService;
  reviews: ReviewService;
  files: FileService;
  admin: AdminOpsService;
  /** `/projects/{projectId}/client-reviews`에서 projectId → 의뢰인 ID 조회. 통합 담당 주입. */
  projectClientId?(projectId: string): Promise<string | null>;
}

export interface AppOptions {
  services: AppServices;
  /** 토큰/세션 검증. null이면 401. 통합 담당이 실제 인증으로 교체한다. */
  authenticate(req: IncomingMessage): Promise<HttpActor | null> | HttpActor | null;
  maxBodyBytes?: number;
  /**
   * true면 매칭되지 않은 경로에 C 자체 404를 쓰지 않고 반환한다.
   * 통합 앱이 A/B와 같은 공통 오류 봉투로 응답할 때 쓴다. 단독 C 서버는 기본값(false)을 유지한다.
   */
  deferUnmatched?: boolean;
}

interface RouteContext {
  actor: HttpActor;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  rawBody?: Buffer;
  req: IncomingMessage;
}

interface Route {
  method: string;
  parts: string[];
  auth: "user" | "webhook";
  handle(ctx: RouteContext, services: AppServices): Promise<{ status?: number; body: unknown }>;
}

const route = (
  method: string,
  path: string,
  auth: Route["auth"],
  handle: Route["handle"],
): Route => ({
  method,
  parts: path.split("/").filter(Boolean),
  auth,
  handle,
});

const ROUTES: Route[] = [
  route("POST", "/contracts/:contractId/deposits", "user", async ({ actor, params, body }, s) => ({
    status: 201,
    body: await s.deposits.createDeposit(actor, {
      contractId: params.contractId,
      idempotencyKey: String(body.idempotencyKey ?? ""),
      method: String(body.method ?? ""),
      amount: Number(body.amount),
    }),
  })),
  route("GET", "/contracts/:contractId/deposits", "user", async ({ actor, params }, s) => ({
    body: await s.deposits.getDeposits(actor, params.contractId),
  })),
  route("POST", "/contracts/:contractId/deposits/:depositId/confirm", "user", async ({ actor, params, body }, s) => ({
    body: await s.deposits.confirmDeposit(actor, {
      contractId: params.contractId,
      depositId: params.depositId,
      paymentKey: String(body.paymentKey ?? ""),
      amount: Number(body.amount),
    }),
  })),
  route("GET", "/me/payment-statements", "user", async ({ actor }, s) => ({
    body: await s.settlement.getMyPaymentStatements(actor),
  })),
  route("GET", "/contracts/:contractId/statement", "user", async ({ actor, params }, s) => ({
    body: await s.settlement.getContractStatement(actor, params.contractId),
  })),
  route("GET", "/contracts/:contractId/installments", "user", async ({ actor, params }, s) => ({
    body: await s.settlement.listInstallments(actor, params.contractId),
  })),
  route("POST", "/installments/:installmentId/tax-invoice-issued", "user", async ({ actor, params }, s) => ({
    body: await s.settlement.markTaxInvoiceIssued(actor, { installmentId: params.installmentId }),
  })),
  route("POST", "/integrations/toss/payment-events", "webhook", async ({ body, rawBody, req }, s) => {
    const signature = req.headers["tosspayments-webhook-signature"];
    const transmissionTime = req.headers["tosspayments-webhook-transmission-time"];
    return {
      body: await s.deposits.handleTossWebhook(
        {
          ...(typeof signature === "string" ? { signature } : {}),
          ...(typeof transmissionTime === "string" ? { transmissionTime } : {}),
          ...(rawBody === undefined ? {} : { rawPayload: rawBody }),
        },
        body,
      ),
    };
  }),
  route("POST", "/installments/:installmentId/deliveries", "user", async ({ actor, params, body }, s) => ({
    status: 201,
    body: await s.deliveries.submitDelivery(actor, {
      installmentId: params.installmentId,
      items: body.items as never,
      summary: body.summary as string | undefined,
    }),
  })),
  route("GET", "/installments/:installmentId/deliveries", "user", async ({ actor, params }, s) => ({
    body: await s.deliveries.listDeliveries(actor, params.installmentId),
  })),
  route("GET", "/deliveries/:deliveryId", "user", async ({ actor, params }, s) => ({
    body: await s.deliveries.getDelivery(actor, params.deliveryId),
  })),
  route("POST", "/contract-items/:contractItemId/approve", "user", async ({ actor, params, body }, s) => ({
    body: await s.deliveries.approveItem(actor, {
      contractItemId: params.contractItemId,
      deliveryId: String(body.deliveryId ?? ""),
    }),
  })),
  route("POST", "/contract-items/:contractItemId/rework-requests", "user", async ({ actor, params, body }, s) => ({
    status: 201,
    body: await s.deliveries.requestRework(actor, {
      deliveryId: String(body.deliveryId ?? ""),
      contractItemId: params.contractItemId,
      reason: body.reason as never,
      conditionKey: body.conditionKey as string | undefined,
      note: body.note as string | undefined,
    }),
  })),
  route("GET", "/contract-items/:contractItemId/rework-requests", "user", async ({ actor, params }, s) => ({
    body: await s.deliveries.listReworkRequests(actor, params.contractItemId),
  })),
  route("POST", "/inspection-requests/:inspectionRequestId/escalate", "user", async ({ actor, params, body }, s) => ({
    body: await s.deliveries.escalateInspection(actor, params.inspectionRequestId, {
      reason: String(body.reason ?? ""),
      what: String(body.what ?? ""),
      claims: body.claims as never,
      evidence: body.evidence,
    }),
  })),
  route("POST", "/contracts/:contractId/cancellation", "user", async ({ actor, params, body }, s) => ({
    status: 201,
    body: await s.cancellations.requestCancellation(actor, {
      contractId: params.contractId,
      cause: body.cause as never,
      note: String(body.note ?? ""),
      evidence: body.evidence,
      proposedCompensationRate: body.proposedCompensationRate as number | undefined,
    }),
  })),
  route("GET", "/contracts/:contractId/cancellation", "user", async ({ actor, params }, s) => ({
    body: await s.cancellations.getCancellation(actor, params.contractId),
  })),
  route("POST", "/contracts/:contractId/cancellation/agree", "user", async ({ actor, params }, s) => ({
    body: await s.cancellations.agreeCancellation(actor, { contractId: params.contractId }),
  })),
  route("POST", "/contracts/:contractId/cancellation/object", "user", async ({ actor, params, body }, s) => ({
    body: await s.cancellations.objectCancellation(actor, {
      contractId: params.contractId,
      objectionRate: Number(body.objectionRate),
      note: String(body.note ?? ""),
    }),
  })),
  route("POST", "/contracts/:contractId/reviews", "user", async ({ actor, params, body }, s) => ({
    status: 201,
    body: await s.reviews.createReview(actor, {
      contractId: params.contractId,
      rating: Number(body.rating),
      comment: body.comment as string | undefined,
      tags: body.tags as string[] | undefined,
    }),
  })),
  route("GET", "/contracts/:contractId/reviews", "user", async ({ actor, params }, s) => ({
    body: await s.reviews.listContractReviews(actor, params.contractId),
  })),
  route("GET", "/profiles/suppliers/:supplierId/reviews", "user", async ({ params }, s) => ({
    body: await s.reviews.listSupplierReviews(params.supplierId),
  })),
  route("GET", "/projects/:projectId/client-reviews", "user", async ({ params }, s) => {
    if (!s.projectClientId) {
      throw Object.assign(new Error("PROJECT_PORT_UNAVAILABLE"), { status: 503 });
    }
    const clientId = await s.projectClientId(params.projectId);
    if (!clientId) throw Object.assign(new Error("PROJECT_NOT_FOUND"), { status: 404 });
    return { body: await s.reviews.listClientReviews(clientId) };
  }),
  route("POST", "/uploads/presign", "user", async ({ actor, body }, s) => ({
    status: 201,
    body: await s.files.createPresignedUpload(actor, body as never),
  })),
  route("GET", "/uploads/:fileId/download", "user", async ({ actor, params }, s) => ({
    body: await s.files.createPresignedDownload(actor, params.fileId),
  })),
  route("GET", "/admin/blocks", "user", async ({ actor }, s) => ({
    body: await s.admin.listBlocks(actor),
  })),
  route("POST", "/admin/blocks/:blockId/actions", "user", async ({ actor, params, body }, s) => ({
    body: await s.admin.executeBlockAction(actor, params.blockId, {
      action: String(body.action ?? ""),
      reason: String(body.reason ?? ""),
      unitPrice: body.unitPrice as number | undefined,
      mergedIntoId: body.mergedIntoId as string | undefined,
    }),
  })),
  route("GET", "/admin/deposits/held", "user", async ({ actor }, s) => ({
    body: await s.admin.listHeldDeposits(actor),
  })),
  route("POST", "/admin/deposits/:depositId/resolve", "user", async ({ actor, params, body }, s) => ({
    body: await s.admin.resolveHeldDeposit(actor, params.depositId, {
      decision: body.decision as never,
      reason: String(body.reason ?? ""),
      paymentKey: body.paymentKey as string | undefined,
    }),
  })),
  route("GET", "/admin/inspection-requests/escalated", "user", async ({ actor }, s) => ({
    body: await s.admin.listEscalatedInspections(actor),
  })),
  route(
    "POST",
    "/admin/inspection-requests/:inspectionRequestId/decision",
    "user",
    async ({ actor, params, body }, s) => ({
      body: await s.admin.decideInspectionDispute(actor, params.inspectionRequestId, {
        decision: body.decision as never,
        reason: String(body.reason ?? ""),
        decisionNotes: body.decisionNotes as never,
      }),
    }),
  ),
  route("GET", "/admin/contracts/cancellation-queue", "user", async ({ actor }, s) => ({
    body: await s.admin.listCancellationQueue(actor),
  })),
  route("POST", "/admin/contracts/:contractId/cancellation/decide", "user", async ({ actor, params, body }, s) => ({
    body: await s.admin.decideCancellation(actor, params.contractId, {
      compensationRate: Number(body.compensationRate),
      reason: String(body.reason ?? ""),
    }),
  })),
  route(
    "POST",
    "/admin/contracts/:contractId/settlement/mark-processed",
    "user",
    async ({ actor, params, body }, s) => ({
      body: await s.admin.markSettlementProcessed(actor, params.contractId, {
        refunded: Boolean(body.refunded),
        cancelPayout: Boolean(body.cancelPayout),
        reason: String(body.reason ?? ""),
      }),
    }),
  ),
  route("GET", "/admin/event-logs", "user", async ({ actor, query }, s) => ({
    body: await s.admin.listEventLogs(actor, {
      actorUserId: query.get("actorUserId") ?? undefined,
      actionType: query.get("actionType") ?? undefined,
      targetType: query.get("targetType") ?? undefined,
      targetId: query.get("targetId") ?? undefined,
      from: query.get("from") ? new Date(query.get("from")!) : undefined,
      to: query.get("to") ? new Date(query.get("to")!) : undefined,
    }),
  })),
];

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const segments = pathname.split("/").filter(Boolean);
  for (const candidate of ROUTES) {
    if (candidate.method !== method || candidate.parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segments.length; i += 1) {
      const part = candidate.parts[i];
      if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segments[i]);
      else if (part !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: candidate, params };
  }
  return null;
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ body: Record<string, unknown>; rawBody?: Buffer }> {
  const request = req as IncomingMessage & { body?: unknown; rawBody?: Buffer };
  const reqBody = request.body;
  if (typeof reqBody === "object" && reqBody !== null) {
    if (Array.isArray(reqBody)) {
      throw Object.assign(new Error("not object"), { status: 400 });
    }
    return {
      body: reqBody as Record<string, unknown>,
      ...(request.rawBody === undefined ? {} : { rawBody: request.rawBody }),
    };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw Object.assign(new Error("BODY_TOO_LARGE"), { status: 413 });
    }
    chunks.push(buffer);
  }
  if (size === 0) return { body: {} };
  try {
    const rawBody = Buffer.concat(chunks);
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return { body: parsed as Record<string, unknown>, rawBody };
  } catch {
    throw Object.assign(new Error("INVALID_JSON"), { status: 400 });
  }
}

const STATUS_ERROR_CODES: Readonly<Record<number, string>> = {
  400: "INVALID_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "UNPROCESSABLE_ENTITY",
  503: "SERVICE_UNAVAILABLE",
};

function errorCodeFor(err: unknown, status: number): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return STATUS_ERROR_CODES[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "ERROR");
}

function requestIdOf(req: IncomingMessage, res: ServerResponse): string {
  const fromResponse = res.getHeader("x-request-id");
  if (typeof fromResponse === "string" && fromResponse.length > 0) return fromResponse;
  const fromRequest = req.headers["x-request-id"];
  if (typeof fromRequest === "string" && fromRequest.length > 0) return fromRequest;
  return randomUUID();
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
): void {
  res.setHeader("x-request-id", requestId);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function createHttpHandler(options: AppOptions) {
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = matchRoute(req.method ?? "GET", url.pathname);
    const requestId = requestIdOf(req, res);
    if (!matched) {
      // 통합 앱에서는 상위 Express의 공통 404 봉투가 응답하도록 넘긴다.
      if (options.deferUnmatched === true) return;
      writeJson(res, 404, { error: { code: "NOT_FOUND", message: "NOT_FOUND", requestId } }, requestId);
      return;
    }
    const isWebhook = matched.route.auth === "webhook";

    try {
      const parsedBody = matched.route.method === "GET"
        ? { body: {} }
        : await readJsonBody(req, maxBodyBytes);
      const body = parsedBody.body;
      const rawBody = parsedBody.rawBody;
      let actor: HttpActor | null = null;
      if (matched.route.auth === "user") {
        actor = await options.authenticate(req);
        if (!actor) {
          writeJson(res, 401, { error: { code: "UNAUTHORIZED", message: "UNAUTHORIZED", requestId } }, requestId);
          return;
        }
      }

      const result = await matched.route.handle(
        {
          actor: actor ?? { userId: "", role: "" },
          params: matched.params,
          query: url.searchParams,
          body,
          req,
          ...(rawBody === undefined ? {} : { rawBody }),
        },
        options.services,
      );
      const status = result.status ?? 200;
      const responseBody = isWebhook ? (result.body ?? null) : { data: result.body ?? null };
      writeJson(res, status, responseBody, requestId);
    } catch (err) {
      const rawStatus = (err as { status?: unknown } | null)?.status;
      const status = typeof rawStatus === "number" ? rawStatus : 500;
      const rawMessage = err instanceof Error ? err.message : "INTERNAL_ERROR";
      if (isWebhook) {
        // Toss webhook은 외부 PG 프로토콜이므로 공통 봉투를 적용하지 않는다.
        writeJson(res, status, { message: status >= 500 ? "INTERNAL_ERROR" : rawMessage }, requestId);
        return;
      }
      writeJson(
        res,
        status,
        {
          error: {
            code: errorCodeFor(err, status),
            message: status >= 500 ? "요청을 처리할 수 없습니다." : rawMessage,
            requestId,
          },
        },
        requestId,
      );
    }
  };
}

export const ROUTE_PATHS = ROUTES.map((item) => `${item.method} /${item.parts.join("/")}`);
