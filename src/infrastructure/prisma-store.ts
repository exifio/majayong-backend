import type { PrismaClient } from "@prisma/client";
import type {
  DepositContractInfo,
  DepositRepository,
  EscrowDeposit,
  PaymentEvent,
  PaymentInstallment,
} from "../modules/deposit/index.ts";
import type {
  ContractItemEntity,
  DeliveryContractInfo,
  DeliveryEntity,
  DeliveryInstallmentInfo,
  DeliveryRepository,
  InspectionRequestEntity,
} from "../modules/delivery/index.ts";
import type { SettlementRepository } from "../modules/settlement/policy.ts";
import type { CancellationRepository } from "../modules/cancellation/index.ts";
import type { ReviewRepository } from "../modules/review/index.ts";
import type { FileContractEntity, FileEntity, FileRepository } from "../modules/files/index.ts";
import type {
  AdminBlock,
  AdminBlockCondition,
  AdminCancellationContract,
  AdminEscalatedInspection,
  AdminHeldDeposit,
  AdminRepository,
  EventLogEntity,
} from "../modules/admin-ops/index.ts";

type Json = unknown;

const contractInclude = {
  application: {
    include: {
      project: { include: { draft: true } },
      supplier: true,
    },
  },
  installments: true,
  deposits: { where: { status: "COMPLETED" }, take: 1 },
} as const;

type ContractRow = Awaited<ReturnType<PrismaClient["contract"]["findFirst"]>> & {
  application: {
    supplierId: string;
    projectId: string;
    project: { draft: { clientId: string } };
    supplier: { businessType: string | null; payoutVerifiedAt: Date | null; payoutAccountNo: string | null };
  };
  installments: Array<{ status: string }>;
  deposits: Array<{ depositedAt: Date | null }>;
};

function mapContract(row: NonNullable<ContractRow>) {
  const kind = (row.application.supplier.businessType === "BUSINESS" ? "BUSINESS" : "INDIVIDUAL") as "BUSINESS" | "INDIVIDUAL";
  return {
    id: row.id,
    projectId: row.application.projectId,
    applicationId: row.applicationId,
    clientUserId: row.application.project.draft.clientId,
    supplierUserId: row.application.supplierId,
    status: row.status as DepositContractInfo["status"],
    paymentStatus: row.paymentStatus as DepositContractInfo["paymentStatus"],
    agreedAmount: row.agreedAmount,
    clientFee: row.clientFee,
    interimRatio: row.interimRatio,
    durationDays: row.durationDays,
    depositDeadline: row.depositDeadline,
    totalDeposited: row.totalDeposited,
    workDueAt: row.workDueAt,
    depositedAt: row.deposits[0]?.depositedAt ?? null,
    supplierKind: kind,
    payoutVerifiedAt: row.application.supplier.payoutVerifiedAt,
    payoutAccountNo: row.application.supplier.payoutAccountNo ?? undefined,
    completedAt: row.completedAt,
    cancelCause: row.cancelCause,
    cancelRequestedBy: row.cancelRequestedBy,
    cancelRequestedAt: row.cancelRequestedAt,
    cancelNote: row.cancelNote,
    objectionNote: row.objectionNote,
    objectionRate: row.objectionRate,
    cancelEvidence: row.cancelEvidence as Json,
    cancelEscalatedAt: row.cancelEscalatedAt,
    compensationRate: row.compensationRate,
    cancelResolution: row.cancelResolution,
    cancelResolvedAt: row.cancelResolvedAt,
    refundAmount: row.refundAmount,
    clientFeeRefund: row.clientFeeRefund,
    settledAmount: row.settledAmount,
    refundReason: row.refundReason,
    refundedAt: row.refundedAt,
    cancelPayoutAt: row.cancelPayoutAt,
  };
}

type MappedContract = ReturnType<typeof mapContract>;

function mapInstallment(row: {
  id: string;
  contractId: string;
  stage: string;
  ratio: number;
  amount: number;
  supplierFee: number;
  withholdingTax: number;
  releaseAmount: number;
  status: string;
  approvedAt: Date | null;
  releasedAt: Date | null;
  taxInvoiceIssuedAt: Date | null;
}): PaymentInstallment {
  return {
    id: row.id,
    contractId: row.contractId,
    stage: row.stage as PaymentInstallment["stage"],
    ratio: row.ratio,
    amount: row.amount,
    supplierFee: row.supplierFee,
    withholdingTax: row.withholdingTax,
    releaseAmount: row.releaseAmount,
    status: row.status as PaymentInstallment["status"],
    approvedAt: row.approvedAt,
    releasedAt: row.releasedAt,
    taxInvoiceIssuedAt: row.taxInvoiceIssuedAt,
  };
}

function mapItem(row: {
  id: string;
  contractId: string;
  stage: string;
  title: string;
  description: string;
  conditions: Json;
  approvedAt: Date | null;
  autoApproved: boolean;
}): ContractItemEntity {
  return {
    id: row.id,
    contractId: row.contractId,
    stage: row.stage as ContractItemEntity["stage"],
    title: row.title,
    description: row.description,
    conditions: (row.conditions ?? []) as ContractItemEntity["conditions"],
    approvedAt: row.approvedAt,
    autoApproved: row.autoApproved,
  };
}

function mapDelivery(row: {
  id: string;
  installmentId: string;
  attemptNo: number;
  items: Json;
  summary: string | null;
  status: string;
  submittedAt: Date;
  inspectionDueAt: Date;
  reviewedAt: Date | null;
}): DeliveryEntity {
  return {
    id: row.id,
    installmentId: row.installmentId,
    attemptNo: row.attemptNo,
    items: (row.items ?? []) as DeliveryEntity["items"],
    summary: row.summary,
    status: row.status as DeliveryEntity["status"],
    submittedAt: row.submittedAt,
    inspectionDueAt: row.inspectionDueAt,
    reviewedAt: row.reviewedAt,
  };
}

function mapInspection(row: {
  id: string;
  deliveryId: string;
  contractItemId: string;
  reason: string;
  conditionKey: string | null;
  note: string | null;
  status: string;
  escalatedAt: Date | null;
  escalation: Json;
  decision: string | null;
  decisionNotes: Json;
  resolvedAt: Date | null;
  createdAt: Date;
}): InspectionRequestEntity {
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    contractItemId: row.contractItemId,
    reason: row.reason as InspectionRequestEntity["reason"],
    conditionKey: row.conditionKey,
    note: row.note,
    status: row.status as InspectionRequestEntity["status"],
    escalatedAt: row.escalatedAt,
    escalation: row.escalation,
    decision: row.decision as InspectionRequestEntity["decision"],
    decisionNotes: row.decisionNotes as InspectionRequestEntity["decisionNotes"],
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

const EVENT_TYPE_BY_ACTION: Record<string, string> = {
  OPERATOR_CONFIRMED: "OPERATOR_DEPOSIT_REVIEWED",
  OPERATOR_VOIDED: "OPERATOR_DEPOSIT_REVIEWED",
  CANCELLATION_ADMIN_DECIDED: "CANCEL_RESOLVED",
  SETTLEMENT_MANUAL_PROCESSED: "REFUND_PROCESSED",
  DISPUTE_APPROVE: "DISPUTE_DECIDED",
  DISPUTE_REWORK_VALID: "DISPUTE_DECIDED",
  DISPUTE_UNDECIDED_CONDITION: "DISPUTE_DECIDED",
  DISPUTE_DECIDED: "DISPUTE_DECIDED",
  DISPUTE_ESCALATED: "DISPUTE_ESCALATED",
  BLOCK_UPDATE_PRICE: "BLOCK_PRICE_UPDATED",
  BLOCK_MERGE: "BLOCK_MERGED",
  BLOCK_DISABLE: "BLOCK_DEACTIVATED",
  BLOCK_ENABLE: "BLOCK_DEACTIVATED",
};

const ACTION_BY_EVENT_TYPE: Record<string, string> = {
  OPERATOR_DEPOSIT_REVIEWED: "OPERATOR_REVIEWED",
  CANCEL_RESOLVED: "CANCELLATION_ADMIN_DECIDED",
  REFUND_PROCESSED: "SETTLEMENT_MANUAL_PROCESSED",
  DISPUTE_DECIDED: "DISPUTE_DECIDED",
  DISPUTE_ESCALATED: "DISPUTE_ESCALATED",
  BLOCK_PRICE_UPDATED: "BLOCK_UPDATE_PRICE",
  BLOCK_MERGED: "BLOCK_MERGE",
  BLOCK_DEACTIVATED: "BLOCK_DEACTIVATE",
};

function eventTypeFor(actionType: string): string {
  if (EVENT_TYPE_BY_ACTION[actionType]) return EVENT_TYPE_BY_ACTION[actionType];
  if (actionType.startsWith("BLOCK_")) return "BLOCK_PRICE_UPDATED";
  return "DISPUTE_DECIDED";
}

function mapEventLog(row: {
  id: string;
  userId: string | null;
  type: string;
  payload: Json;
  occurredAt: Date;
}): EventLogEntity {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    actorUserId: row.userId ?? String(payload.actorUserId ?? ""),
    actionType: String(payload.actionType ?? ACTION_BY_EVENT_TYPE[row.type] ?? row.type),
    targetType: String(payload.targetType ?? ""),
    targetId: String(payload.targetId ?? ""),
    reason: String(payload.reason ?? ""),
    occurredAt: row.occurredAt,
  };
}

export interface PrismaStoreOptions {
  /** 테스트/시드에서만 쓰는 블록 기본값. */
  defaultBlockId?: string;
}

export function createPrismaRepositories(prisma: PrismaClient, options: PrismaStoreOptions = {}) {
  const db = (tx?: unknown) => (tx as PrismaClient | undefined) ?? prisma;

  async function loadContract(id: string, tx?: unknown) {
    const row = (await db(tx).contract.findUnique({
      where: { id },
      include: contractInclude,
    })) as ContractRow | null;
    return row ?? null;
  }

  const depositRepository: DepositRepository = {
    async createDeposit(data, tx) {
      const row = await db(tx).escrowDeposit.create({
        data: {
          contractId: data.contractId,
          principal: data.principal,
          clientFee: data.clientFee,
          amount: data.amount,
          method: data.method,
          status: data.status as never,
          idempotencyKey: data.idempotencyKey,
          pgKey: data.pgKey,
          depositedAt: data.depositedAt,
        },
      });
      return { ...row, status: row.status as EscrowDeposit["status"], heldReason: null } as EscrowDeposit;
    },
    async findByIdempotencyKey(key, tx) {
      const row = await db(tx).escrowDeposit.findUnique({ where: { idempotencyKey: key } });
      return row ? ({ ...row, status: row.status as EscrowDeposit["status"], heldReason: null } as EscrowDeposit) : null;
    },
    async findById(id, tx) {
      const row = await db(tx).escrowDeposit.findUnique({ where: { id } });
      return row ? ({ ...row, status: row.status as EscrowDeposit["status"], heldReason: null } as EscrowDeposit) : null;
    },
    async findByContractId(contractId, tx) {
      const rows = await db(tx).escrowDeposit.findMany({ where: { contractId } });
      return rows.map((row) => ({
        ...row,
        status: row.status as EscrowDeposit["status"],
        heldReason: null,
      })) as EscrowDeposit[];
    },
    async updateDeposit(id, patch, tx) {
      const row = await db(tx).escrowDeposit.update({
        where: { id },
        data: {
          ...(patch.status === undefined ? {} : { status: patch.status as never }),
          ...(patch.pgKey === undefined ? {} : { pgKey: patch.pgKey }),
          ...(patch.depositedAt === undefined ? {} : { depositedAt: patch.depositedAt }),
          ...(patch.amount === undefined ? {} : { amount: patch.amount }),
          ...(patch.method === undefined ? {} : { method: patch.method }),
        },
      });
      return { ...row, status: row.status as EscrowDeposit["status"], heldReason: patch.heldReason ?? null } as EscrowDeposit;
    },
    async createPaymentEvent(data, tx) {
      const row = await db(tx).paymentEvent.create({
        data: {
          depositId: data.depositId,
          eventType: data.eventType as never,
          dedupKey: data.dedupKey,
          payload: data.payload as never,
          resultNote: data.resultNote,
        },
      });
      return { ...row, eventType: row.eventType as PaymentEvent["eventType"], payload: row.payload } as PaymentEvent;
    },
    async findPaymentEventByDedupKey(depositId, dedupKey, tx) {
      const row = await db(tx).paymentEvent.findUnique({
        where: { depositId_dedupKey: { depositId, dedupKey } },
      });
      return row
        ? ({ ...row, eventType: row.eventType as PaymentEvent["eventType"], payload: row.payload } as PaymentEvent)
        : null;
    },
    async listPaymentEvents(depositId, tx) {
      const rows = await db(tx).paymentEvent.findMany({ where: { depositId }, orderBy: { occurredAt: "asc" } });
      return rows.map((row) => ({
        ...row,
        eventType: row.eventType as PaymentEvent["eventType"],
        payload: row.payload,
      })) as PaymentEvent[];
    },
    async createInstallments(rows, tx) {
      const created: PaymentInstallment[] = [];
      for (const row of rows) {
        const record = await db(tx).paymentInstallment.upsert({
          where: { contractId_stage: { contractId: row.contractId, stage: row.stage as never } },
          update: {},
          create: {
            contractId: row.contractId,
            stage: row.stage as never,
            ratio: row.ratio,
            amount: row.amount,
            supplierFee: row.supplierFee,
            withholdingTax: row.withholdingTax,
            releaseAmount: row.releaseAmount,
            status: row.status as never,
            approvedAt: row.approvedAt,
            releasedAt: row.releasedAt,
            taxInvoiceIssuedAt: row.taxInvoiceIssuedAt,
          },
        });
        created.push(mapInstallment(record));
      }
      return created;
    },
    async listInstallments(contractId, tx) {
      const rows = await db(tx).paymentInstallment.findMany({ where: { contractId } });
      return rows.map(mapInstallment);
    },
    async deleteInstallments(contractId, tx) {
      await db(tx).paymentInstallment.deleteMany({ where: { contractId } });
    },
  };

  const deliveryRepository: DeliveryRepository = {
    seedContract() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    seedInstallment() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    seedContractItems() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    async getContract(id) {
      const row = await loadContract(id);
      if (!row) return null;
      const mapped = mapContract(row);
      return {
        id: mapped.id,
        clientUserId: mapped.clientUserId,
        supplierUserId: mapped.supplierUserId,
        status: mapped.status,
        paymentStatus: mapped.paymentStatus,
        depositDeadline: mapped.depositDeadline ?? undefined,
        workDueAt: mapped.workDueAt ?? undefined,
      } satisfies DeliveryContractInfo;
    },
    async getInstallment(id) {
      const row = await prisma.paymentInstallment.findUnique({ where: { id } });
      if (!row) return null;
      return {
        id: row.id,
        contractId: row.contractId,
        stage: row.stage as DeliveryInstallmentInfo["stage"],
        status: row.status,
      };
    },
    async updateInstallment(id, patch) {
      const row = await prisma.paymentInstallment.update({
        where: { id },
        data: {
          ...(patch.status === undefined ? {} : { status: patch.status as never }),
        },
      });
      return {
        id: row.id,
        contractId: row.contractId,
        stage: row.stage as DeliveryInstallmentInfo["stage"],
        status: row.status,
      };
    },
    async getContractItem(id) {
      const row = await prisma.contractItem.findUnique({ where: { id } });
      return row ? mapItem(row) : null;
    },
    async listContractItemsByContractId(contractId) {
      const rows = await prisma.contractItem.findMany({ where: { contractId }, orderBy: { sortOrder: "asc" } });
      return rows.map(mapItem);
    },
    async updateContractItem(id, patch) {
      const row = await prisma.contractItem.update({
        where: { id },
        data: {
          ...(patch.approvedAt === undefined ? {} : { approvedAt: patch.approvedAt }),
          ...(patch.autoApproved === undefined ? {} : { autoApproved: patch.autoApproved }),
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.stage === undefined ? {} : { stage: patch.stage as never }),
          ...(patch.conditions === undefined ? {} : { conditions: patch.conditions as never }),
        },
      });
      return mapItem(row);
    },
    async createDelivery(data) {
      const row = await prisma.delivery.create({
        data: {
          installmentId: data.installmentId,
          attemptNo: data.attemptNo,
          items: data.items as never,
          summary: data.summary,
          status: data.status as never,
          submittedAt: data.submittedAt,
          inspectionDueAt: data.inspectionDueAt,
          reviewedAt: data.reviewedAt,
        },
      });
      return mapDelivery(row);
    },
    async getDelivery(id) {
      const row = await prisma.delivery.findUnique({ where: { id } });
      return row ? mapDelivery(row) : null;
    },
    async listDeliveries(installmentId) {
      const rows = await prisma.delivery.findMany({ where: { installmentId }, orderBy: { attemptNo: "asc" } });
      return rows.map(mapDelivery);
    },
    async listInstallments(contractId) {
      const rows = await prisma.paymentInstallment.findMany({ where: { contractId } });
      return rows.map((row) => ({
        id: row.id,
        contractId: row.contractId,
        stage: row.stage as DeliveryInstallmentInfo["stage"],
        status: row.status,
        amount: row.amount,
      }));
    },
    async updateDelivery(id, patch) {
      const row = await prisma.delivery.update({
        where: { id },
        data: {
          ...(patch.status === undefined ? {} : { status: patch.status as never }),
          ...(patch.reviewedAt === undefined ? {} : { reviewedAt: patch.reviewedAt }),
          ...(patch.items === undefined ? {} : { items: patch.items as never }),
          ...(patch.summary === undefined ? {} : { summary: patch.summary }),
        },
      });
      return mapDelivery(row);
    },
    async createInspectionRequest(data) {
      const row = await prisma.inspectionRequest.create({
        data: {
          deliveryId: data.deliveryId,
          contractItemId: data.contractItemId,
          reason: data.reason as never,
          conditionKey: data.conditionKey,
          note: data.note,
          status: data.status as never,
          escalatedAt: data.escalatedAt,
          escalation: data.escalation as never,
          decision: data.decision as never,
          decisionNotes: data.decisionNotes as never,
          resolvedAt: data.resolvedAt,
          createdAt: data.createdAt,
        },
      });
      return mapInspection(row);
    },
    async getInspectionRequest(id) {
      const row = await prisma.inspectionRequest.findUnique({ where: { id } });
      return row ? mapInspection(row) : null;
    },
    async listInspectionRequestsByItem(contractItemId) {
      const rows = await prisma.inspectionRequest.findMany({ where: { contractItemId } });
      return rows.map(mapInspection);
    },
    async listInspectionRequestsByDelivery(deliveryId) {
      const rows = await prisma.inspectionRequest.findMany({ where: { deliveryId } });
      return rows.map(mapInspection);
    },
    async updateInspectionRequest(id, patch) {
      const row = await prisma.inspectionRequest.update({
        where: { id },
        data: {
          ...(patch.status === undefined ? {} : { status: patch.status as never }),
          ...(patch.escalatedAt === undefined ? {} : { escalatedAt: patch.escalatedAt }),
          ...(patch.escalation === undefined ? {} : { escalation: patch.escalation as never }),
          ...(patch.decision === undefined ? {} : { decision: patch.decision as never }),
          ...(patch.decisionNotes === undefined ? {} : { decisionNotes: patch.decisionNotes as never }),
          ...(patch.resolvedAt === undefined ? {} : { resolvedAt: patch.resolvedAt }),
        },
      });
      return mapInspection(row);
    },
  };

  const settlementRepository: SettlementRepository = {
    seedContract() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    seedInstallments() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    seedContractItems() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    async getContract(id) {
      const row = await loadContract(id);
      if (!row) return null;
      const mapped = mapContract(row);
      return {
        id: mapped.id,
        clientUserId: mapped.clientUserId,
        supplierUserId: mapped.supplierUserId,
        status: mapped.status,
        paymentStatus: mapped.paymentStatus,
        agreedAmount: mapped.agreedAmount,
        clientFee: mapped.clientFee,
        totalDeposited: mapped.totalDeposited ?? 0,
        interimRatio: mapped.interimRatio ?? 50,
        supplierKind: mapped.supplierKind,
        payoutVerifiedAt: mapped.payoutVerifiedAt,
        payoutAccountNo: mapped.payoutAccountNo,
        completedAt: mapped.completedAt,
      };
    },
    async updateContract(id, patch) {
      await prisma.contract.update({
        where: { id },
        data: {
          ...(patch.status === undefined ? {} : { status: patch.status as never }),
          ...(patch.paymentStatus === undefined ? {} : { paymentStatus: patch.paymentStatus as never }),
          ...(patch.totalDeposited === undefined ? {} : { totalDeposited: patch.totalDeposited }),
          ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
        },
      });
      return (await this.getContract(id))!;
    },
    async listContractsForUser(userId) {
      const rows = (await prisma.contract.findMany({ include: contractInclude })) as ContractRow[];
      return rows
        .map(mapContract)
        .filter((row) => row.clientUserId === userId || row.supplierUserId === userId)
        .map((row) => ({
          id: row.id,
          clientUserId: row.clientUserId,
          supplierUserId: row.supplierUserId,
          status: row.status,
          paymentStatus: row.paymentStatus,
          agreedAmount: row.agreedAmount,
          clientFee: row.clientFee,
          totalDeposited: row.totalDeposited ?? 0,
          interimRatio: row.interimRatio ?? 50,
          supplierKind: row.supplierKind,
          payoutVerifiedAt: row.payoutVerifiedAt,
        }));
    },
    async getInstallment(id) {
      const row = await prisma.paymentInstallment.findUnique({ where: { id } });
      return row ? ({ ...mapInstallment(row), holdReason: null }) : null;
    },
    async listInstallments(contractId) {
      const rows = await prisma.paymentInstallment.findMany({ where: { contractId } });
      return rows.map((row) => ({ ...mapInstallment(row), holdReason: null }));
    },
    async updateInstallment(id, patch) {
      const row = await prisma.paymentInstallment.update({
        where: { id },
        data: {
          ...(patch.status === undefined ? {} : { status: patch.status as never }),
          ...(patch.approvedAt === undefined ? {} : { approvedAt: patch.approvedAt }),
          ...(patch.releasedAt === undefined ? {} : { releasedAt: patch.releasedAt }),
          ...(patch.taxInvoiceIssuedAt === undefined ? {} : { taxInvoiceIssuedAt: patch.taxInvoiceIssuedAt }),
          ...(patch.supplierFee === undefined ? {} : { supplierFee: patch.supplierFee }),
          ...(patch.withholdingTax === undefined ? {} : { withholdingTax: patch.withholdingTax }),
          ...(patch.releaseAmount === undefined ? {} : { releaseAmount: patch.releaseAmount }),
        },
      });
      return { ...mapInstallment(row), holdReason: patch.holdReason ?? null };
    },
    async listContractItems(contractId) {
      const rows = await prisma.contractItem.findMany({ where: { contractId } });
      return rows.map((row) => ({
        id: row.id,
        contractId: row.contractId,
        stage: row.stage as "INTERIM" | "FINAL",
        title: row.title,
        approvedAt: row.approvedAt,
      }));
    },
    async updateContractItem(id, patch) {
      const row = await prisma.contractItem.update({
        where: { id },
        data: { ...(patch.approvedAt === undefined ? {} : { approvedAt: patch.approvedAt }) },
      });
      return {
        id: row.id,
        contractId: row.contractId,
        stage: row.stage as "INTERIM" | "FINAL",
        title: row.title,
        approvedAt: row.approvedAt,
      };
    },
  };

  const cancellationRepository: CancellationRepository = {
    seedContract() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    seedInstallments() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    async getContract(id) {
      const row = await loadContract(id);
      return row ? (mapContract(row) as never) : null;
    },
    async updateContract(id, patch) {
      const data: Record<string, unknown> = {};
      for (const key of [
        "status",
        "cancelCause",
        "cancelRequestedBy",
        "cancelRequestedAt",
        "cancelNote",
        "objectionNote",
        "objectionRate",
        "cancelEvidence",
        "cancelEscalatedAt",
        "compensationRate",
        "cancelResolution",
        "cancelResolvedAt",
        "refundAmount",
        "clientFeeRefund",
        "settledAmount",
        "refundReason",
        "refundedAt",
        "cancelPayoutAt",
        "totalDeposited",
        "paymentStatus",
      ] as const) {
        if (patch[key] !== undefined) data[key] = patch[key];
      }
      await prisma.contract.update({ where: { id }, data: data as never });
      return (await this.getContract(id))!;
    },
    async listInstallments(contractId) {
      const rows = await prisma.paymentInstallment.findMany({ where: { contractId } });
      return rows.map((row) => ({
        id: row.id,
        contractId: row.contractId,
        stage: row.stage as "INTERIM" | "FINAL",
        amount: row.amount,
        status: row.status as never,
      }));
    },
    async updateInstallment(id, patch) {
      const row = await prisma.paymentInstallment.update({
        where: { id },
        data: {
          ...(patch.status === undefined ? {} : { status: patch.status as never }),
          ...(patch.amount === undefined ? {} : { amount: patch.amount }),
        },
      });
      return {
        id: row.id,
        contractId: row.contractId,
        stage: row.stage as "INTERIM" | "FINAL",
        amount: row.amount,
        status: row.status as never,
      };
    },
  };

  const reviewRepository: ReviewRepository = {
    seedContract() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    async getContract(id) {
      const row = await loadContract(id);
      if (!row) return null;
      const mapped = mapContract(row);
      return {
        id: mapped.id,
        clientUserId: mapped.clientUserId,
        supplierUserId: mapped.supplierUserId,
        status: mapped.status,
      };
    },
    async createReview(data, tx?: unknown) {
      const row = await db(tx).review.create({
        data: {
          contractId: data.contractId,
          reviewerId: data.reviewerId,
          revieweeId: data.revieweeId,
          reviewerRole: data.reviewerRole as never,
          rating: data.rating,
          comment: data.comment,
          tags: data.tags,
          createdAt: data.createdAt,
        },
      });
      return row as never;
    },
    async findReviewByContractAndReviewer(contractId, reviewerId) {
      return (await prisma.review.findUnique({
        where: { contractId_reviewerId: { contractId, reviewerId } },
      })) as never;
    },
    async listReviewsByContract(contractId) {
      return (await prisma.review.findMany({ where: { contractId } })) as never;
    },
    async listReviewsByReviewee(revieweeId) {
      return (await prisma.review.findMany({ where: { revieweeId } })) as never;
    },
  };

  function mapHeldDeposit(row: {
    id: string;
    contractId: string;
    amount: number;
    status: string;
  }): AdminHeldDeposit {
    return {
      id: row.id,
      contractId: row.contractId,
      amount: row.amount,
      status: row.status === "COMPLETED" ? "COMPLETED" : row.status === "FAILED" ? "FAILED" : "HELD",
      heldReason: "",
    };
  }

  function mapAdminInspection(row: {
    id: string;
    contractItemId: string;
    deliveryId: string;
    status: string;
    reason: string;
    decision: string | null;
    decisionNotes: Json;
  }): AdminEscalatedInspection {
    return {
      id: row.id,
      contractItemId: row.contractItemId,
      deliveryId: row.deliveryId,
      status: row.status === "RESOLVED" ? "RESOLVED" : row.status === "OPEN" ? "OPEN" : "ESCALATED",
      reason: row.reason,
      decision: (row.decision ?? undefined) as AdminEscalatedInspection["decision"],
      decisionNotes: (row.decisionNotes ?? undefined) as AdminEscalatedInspection["decisionNotes"],
    };
  }

  function mapQueue(row: MappedContract & { installments: Array<{ status: string }> }): AdminCancellationContract {
    return {
      id: row.id,
      status: row.status,
      cancelCause: row.cancelCause ?? "",
      totalDeposited: row.totalDeposited ?? 0,
      agreedAmount: row.agreedAmount,
      clientFee: row.clientFee,
      compensationRate: row.compensationRate,
      cancelResolution: row.cancelResolution as AdminCancellationContract["cancelResolution"],
      cancelResolvedAt: row.cancelResolvedAt,
      refundAmount: row.refundAmount,
      settledAmount: row.settledAmount,
      clientFeeRefund: row.clientFeeRefund,
      refundedAt: row.refundedAt,
      cancelPayoutAt: row.cancelPayoutAt,
      depositedAt: row.depositedAt,
      cancelRequestedAt: row.cancelRequestedAt,
      cancelEscalatedAt: row.cancelEscalatedAt,
      objectionRate: row.objectionRate,
      installmentStatuses: row.installments.map((item) => item.status),
    };
  }

  function mapAdminBlock(
    row: {
      id: string;
      name: string;
      unitPrice: number;
      isActive: boolean;
      mergedIntoId: string | null;
      description: string;
      functionSummary: string;
      industryCode: string;
      techTags: readonly string[];
      conditions: Json;
      priceBasis: string;
      source: string;
      reviewedAt: Date | null;
      createdAt: Date;
    },
    sourceProjectCount: number,
  ): AdminBlock {
    const conditions: AdminBlockCondition[] = [];
    if (Array.isArray(row.conditions)) {
      for (const item of row.conditions) {
        if (typeof item === "string") {
          conditions.push({ key: "", text: item });
          continue;
        }
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.text !== "string") continue;
        conditions.push({ key: typeof record.key === "string" ? record.key : "", text: record.text });
      }
    }
    return {
      id: row.id,
      title: row.name,
      unitPrice: row.unitPrice,
      isActive: row.isActive,
      mergedIntoId: row.mergedIntoId,
      description: row.description,
      functionSummary: row.functionSummary,
      industryCode: row.industryCode,
      techTags: row.techTags,
      conditions,
      priceBasis: row.priceBasis,
      source: row.source,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      sourceProjectCount,
    };
  }

  const adminRepository: AdminRepository = {
    seedBlock(block) {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    seedHeldDeposit() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    seedEscalatedInspection() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    seedCancellationQueueContract() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    async listBlocks() {
      const rows = await prisma.blockCatalog.findMany();
      const usages = await prisma.specItem.findMany({
        select: { blockId: true, projectId: true },
        distinct: ["blockId", "projectId"],
      });
      const counts = new Map<string, number>();
      for (const usage of usages) counts.set(usage.blockId, (counts.get(usage.blockId) ?? 0) + 1);
      return rows.map((row) => mapAdminBlock(row, counts.get(row.id) ?? 0));
    },
    async getBlock(id) {
      const row = await prisma.blockCatalog.findUnique({ where: { id } });
      if (row === null) return null;
      const projects = await prisma.specItem.findMany({
        where: { blockId: id },
        select: { projectId: true },
        distinct: ["projectId"],
      });
      return mapAdminBlock(row, projects.length);
    },
    async listHeldDeposits() {
      const rows = await prisma.escrowDeposit.findMany({ where: { status: "HELD" } });
      return rows.map(mapHeldDeposit);
    },
    async getHeldDeposit(id) {
      const row = await prisma.escrowDeposit.findUnique({ where: { id } });
      return row ? mapHeldDeposit(row) : null;
    },
    async updateHeldDeposit(id, patch) {
      const row = await prisma.escrowDeposit.update({
        where: { id },
        data: { ...(patch.status === undefined ? {} : { status: patch.status as never }) },
      });
      return mapHeldDeposit(row);
    },
    async listEscalatedInspections() {
      const rows = await prisma.inspectionRequest.findMany({ where: { status: "ESCALATED" } });
      return rows.map(mapAdminInspection);
    },
    async getInspection(id) {
      const row = await prisma.inspectionRequest.findUnique({ where: { id } });
      return row ? mapAdminInspection(row) : null;
    },
    async updateInspection(id, patch) {
      const row = await prisma.inspectionRequest.update({
        where: { id },
        data: {
          ...(patch.status === undefined ? {} : { status: patch.status as never }),
          ...(patch.decision === undefined ? {} : { decision: patch.decision as never }),
          ...(patch.decisionNotes === undefined ? {} : { decisionNotes: patch.decisionNotes as never }),
        },
      });
      return mapAdminInspection(row);
    },
    async listCancellationQueue() {
      const rows = (await prisma.contract.findMany({
        where: { status: "CANCEL_REQUESTED" },
        include: contractInclude,
      })) as Array<ContractRow & { installments: Array<{ status: string }> }>;
      return rows.map((row) => mapQueue({ ...mapContract(row), installments: row.installments }));
    },
    async getCancellationContract(id) {
      const row = (await prisma.contract.findUnique({
        where: { id },
        include: contractInclude,
      })) as (ContractRow & { installments: Array<{ status: string }> }) | null;
      return row ? mapQueue({ ...mapContract(row), installments: row.installments }) : null;
    },
    async updateCancellationContract(id, patch) {
      const data: Record<string, unknown> = {};
      for (const key of [
        "status",
        "compensationRate",
        "cancelResolution",
        "cancelResolvedAt",
        "refundAmount",
        "settledAmount",
        "clientFeeRefund",
        "refundedAt",
        "cancelPayoutAt",
      ] as const) {
        if (patch[key] !== undefined) data[key] = patch[key];
      }
      await prisma.contract.update({ where: { id }, data: data as never });
      return (await this.getCancellationContract(id))!;
    },
    async recordEvent(data, tx?: unknown) {
      const row = await db(tx).eventLog.create({
        data: {
          userId: data.actorUserId || null,
          type: eventTypeFor(data.actionType) as never,
          payload: {
            actionType: data.actionType,
            targetType: data.targetType,
            targetId: data.targetId,
            reason: data.reason,
            actorUserId: data.actorUserId,
          } as never,
          occurredAt: data.occurredAt,
        },
      });
      return mapEventLog(row);
    },
    async listEventLogs() {
      const rows = await prisma.eventLog.findMany({ orderBy: { occurredAt: "desc" } });
      return rows.map(mapEventLog);
    },
  };

  const contractsPort = {
    async getContract(id: string, tx?: unknown) {
      const row = await loadContract(id, tx);
      if (!row) return null;
      const mapped = mapContract(row);
      return {
        id: mapped.id,
        projectId: mapped.projectId,
        applicationId: mapped.applicationId,
        clientUserId: mapped.clientUserId,
        supplierUserId: mapped.supplierUserId,
        status: mapped.status,
        paymentStatus: mapped.paymentStatus,
        agreedAmount: mapped.agreedAmount,
        clientFee: mapped.clientFee,
        interimRatio: mapped.interimRatio,
        durationDays: mapped.durationDays,
        depositDeadline: mapped.depositDeadline,
        totalDeposited: mapped.totalDeposited,
        workDueAt: mapped.workDueAt,
      } satisfies DepositContractInfo;
    },
    async updateContract(id: string, patch: Partial<DepositContractInfo>, tx?: unknown) {
      await db(tx).contract.update({
        where: { id },
        data: {
          ...(patch.status === undefined ? {} : { status: patch.status as never }),
          ...(patch.paymentStatus === undefined ? {} : { paymentStatus: patch.paymentStatus as never }),
          ...(patch.totalDeposited === undefined ? {} : { totalDeposited: patch.totalDeposited }),
          ...(patch.workDueAt === undefined ? {} : { workDueAt: patch.workDueAt }),
        },
      });
      const updated = await contractsPort.getContract(id, tx);
      if (!updated) throw new Error(`contract not found: ${id}`);
      return updated;
    },
    async cancelIfUnpaid(id: string, tx?: unknown) {
      // 예치 완료(paymentStatus=DEPOSITED)가 먼저 커밋됐으면 한 행도 바뀌지 않는다.
      const result = await db(tx).contract.updateMany({
        where: {
          id,
          status: { in: ['PENDING_CONSENT', 'ACTIVE'] },
          paymentStatus: 'PENDING',
        },
        data: { status: 'CANCELLED' },
      });
      return result.count === 1;
    },
  };

  const fileRepository: FileRepository = {
    seedContract() {
      throw new Error("PRISMA_SEED_NOT_SUPPORTED: use prisma seed data");
    },
    async getContract(id) {
      const row = await loadContract(id);
      if (!row) return null;
      const mapped = mapContract(row);
      return {
        id: mapped.id,
        clientUserId: mapped.clientUserId,
        supplierUserId: mapped.supplierUserId,
      } satisfies FileContractEntity;
    },
    async saveFileMetadata(data) {
      const row = await prisma.fileAttachment.create({
        data: {
          purpose: data.purpose as never,
          contractId: data.contractId,
          inquiryId: data.inquiryId,
          uploaderId: data.uploaderId,
          objectKey: data.objectKey,
          fileName: data.fileName,
          fileSize: data.fileSize,
          mimeType: data.mimeType,
        },
      });
      return { ...row, purpose: row.purpose as FileEntity["purpose"] } as FileEntity;
    },
    async getFileMetadata(id) {
      const row = await prisma.fileAttachment.findUnique({ where: { id } });
      return row ? ({ ...row, purpose: row.purpose as FileEntity["purpose"] } as FileEntity) : null;
    },
    async countFilesInquiry(inquiryId) {
      return prisma.fileAttachment.count({ where: { inquiryId } });
    },
  };

  return {
    contractsPort,
    depositRepository,
    fileRepository,
    deliveryRepository,
    settlementRepository,
    cancellationRepository,
    reviewRepository,
    adminRepository,
    defaultBlockId: options.defaultBlockId,
  };
}
