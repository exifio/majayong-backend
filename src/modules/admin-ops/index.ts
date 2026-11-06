export class AdminHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminHttpError";
    this.status = status;
  }
}

const ADMIN_BLOCK_ACTIONS: Record<string, true> = {
  UPDATE_PRICE: true,
  MERGE: true,
  DISABLE: true,
  ENABLE: true,
};

export interface AdminBlock {
  id: string;
  title: string;
  unitPrice: number;
  isActive: boolean;
  mergedIntoId?: string | null;
}

export interface AdminHeldDeposit {
  id: string;
  contractId: string;
  amount: number;
  status: "HELD" | "COMPLETED" | "FAILED";
  heldReason: string;
}

export interface AdminEscalatedInspection {
  id: string;
  contractItemId: string;
  deliveryId: string;
  status: "ESCALATED" | "OPEN" | "RESOLVED";
  reason: string;
  decision?: "REWORK_VALID" | "APPROVE" | "UNDECIDED_CONDITION";
  decisionNotes?: { client: string; supplier: string };
}

export interface AdminCancellationContract {
  id: string;
  status: string;
  cancelCause: string;
  totalDeposited: number;
  agreedAmount: number;
  clientFee: number;
  compensationRate?: number | null;
  cancelResolution?: "ADMIN_DECIDED" | null;
  cancelResolvedAt?: Date | null;
  refundAmount?: number | null;
  settledAmount?: number | null;
  clientFeeRefund?: number | null;
  refundedAt?: Date | null;
  cancelPayoutAt?: Date | null;
  depositedAt?: Date | null;
  cancelRequestedAt?: Date | null;
  cancelEscalatedAt?: Date | null;
  objectionRate?: number | null;
  installmentStatuses?: readonly string[];
}

export interface EventLogEntity {
  id: string;
  actorUserId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  reason: string;
  occurredAt: Date;
}

export interface CatalogAdminPort {
  executeBlockAction(input: {
    actorId: string;
    blockId: string;
    action: string;
    reason: string;
    unitPrice?: number;
    mergedIntoId?: string;
  }, tx?: unknown): Promise<{ success: boolean; blockId: string; action: string }>;
}

export interface AdminRepository {
  seedBlock(block: AdminBlock): void;
  seedHeldDeposit(deposit: AdminHeldDeposit): void;
  seedEscalatedInspection(inspection: AdminEscalatedInspection): void;
  seedCancellationQueueContract(contract: AdminCancellationContract): void;
  listBlocks(): Promise<AdminBlock[]>;
  getBlock(id: string): Promise<AdminBlock | null>;
  listHeldDeposits(): Promise<AdminHeldDeposit[]>;
  getHeldDeposit(id: string): Promise<AdminHeldDeposit | null>;
  updateHeldDeposit(id: string, patch: Partial<AdminHeldDeposit>): Promise<AdminHeldDeposit>;
  listEscalatedInspections(): Promise<AdminEscalatedInspection[]>;
  getInspection(id: string): Promise<AdminEscalatedInspection | null>;
  updateInspection(id: string, patch: Partial<AdminEscalatedInspection>): Promise<AdminEscalatedInspection>;
  listCancellationQueue(): Promise<AdminCancellationContract[]>;
  getCancellationContract(id: string): Promise<AdminCancellationContract | null>;
  updateCancellationContract(
    id: string,
    patch: Partial<AdminCancellationContract>,
  ): Promise<AdminCancellationContract>;
  recordEvent(event: Omit<EventLogEntity, "id">, tx?: unknown): Promise<EventLogEntity>;
  listEventLogs(): Promise<EventLogEntity[]>;
}

export function createInMemoryAdminRepository(): AdminRepository {
  const blocks = new Map<string, AdminBlock>();
  const heldDeposits = new Map<string, AdminHeldDeposit>();
  const inspections = new Map<string, AdminEscalatedInspection>();
  const cancellationContracts = new Map<string, AdminCancellationContract>();
  const eventLogs: EventLogEntity[] = [];
  let logIdCounter = 1;

  return {
    seedBlock(block) {
      blocks.set(block.id, { ...block });
    },
    seedHeldDeposit(deposit) {
      heldDeposits.set(deposit.id, { ...deposit });
    },
    seedEscalatedInspection(inspection) {
      inspections.set(inspection.id, { ...inspection });
    },
    seedCancellationQueueContract(contract) {
      cancellationContracts.set(contract.id, { ...contract });
    },
    async listBlocks() {
      return Array.from(blocks.values());
    },
    async getBlock(id) {
      return blocks.get(id) ?? null;
    },
    async listHeldDeposits() {
      return Array.from(heldDeposits.values()).filter((d) => d.status === "HELD");
    },
    async getHeldDeposit(id) {
      return heldDeposits.get(id) ?? null;
    },
    async updateHeldDeposit(id, patch) {
      const existing = heldDeposits.get(id);
      if (!existing) throw new AdminHttpError(404, "보류된 예치 건을 찾을 수 없습니다.");
      const updated = { ...existing, ...patch };
      heldDeposits.set(id, updated);
      return updated;
    },
    async listEscalatedInspections() {
      return Array.from(inspections.values()).filter((i) => i.status === "ESCALATED");
    },
    async getInspection(id) {
      return inspections.get(id) ?? null;
    },
    async updateInspection(id, patch) {
      const existing = inspections.get(id);
      if (!existing) throw new AdminHttpError(404, "검수 요청을 찾을 수 없습니다.");
      const updated = { ...existing, ...patch };
      inspections.set(id, updated);
      return updated;
    },
    async listCancellationQueue() {
      return Array.from(cancellationContracts.values());
    },
    async getCancellationContract(id) {
      return cancellationContracts.get(id) ?? null;
    },
    async updateCancellationContract(id, patch) {
      const existing = cancellationContracts.get(id);
      if (!existing) throw new AdminHttpError(404, "취소 대기 계약을 찾을 수 없습니다.");
      const updated = { ...existing, ...patch };
      cancellationContracts.set(id, updated);
      return updated;
    },
    async recordEvent(data) {
      const rec: EventLogEntity = { ...data, id: `log-${logIdCounter++}` };
      eventLogs.push(rec);
      return rec;
    },
    async listEventLogs() {
      return [...eventLogs].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    },
  };
}

export interface AdminOpsServiceOptions {
  repo: AdminRepository;
  catalogPort: CatalogAdminPort;
  depositPort?: {
    resolveHeldDeposit(input: {
      depositId: string;
      decision: "OPERATOR_CONFIRMED" | "OPERATOR_VOIDED";
      reason: string;
      actorUserId: string;
      paymentKey?: string;
    }): Promise<{ deposit: { id: string; status: string } }>;
  };
  inspectionPort?: {
    decideDispute(input: {
      inspectionRequestId: string;
      decision: "REWORK_VALID" | "APPROVE" | "UNDECIDED_CONDITION";
      reason: string;
      decisionNotes: { client: string; supplier: string };
    }): Promise<{ id: string; status: string; decision?: string | null }>;
  };
  cancellationPort?: {
    decideCancellation(input: {
      contractId: string;
      compensationRate: number;
      reason: string;
    }): Promise<{
      status: string;
      compensationRate: number | null;
      refundAmount: number | null;
      settledAmount: number | null;
      clientFeeRefund: number | null;
      cancelResolution: string | null;
      cancelResolvedAt: Date | null;
    }>;
    markProcessed?(input: {
      contractId: string;
      operatorId: string;
      refunded: boolean;
      cancelPayout: boolean;
    }): Promise<{ refundedAt: Date | null; cancelPayoutAt: Date | null }>;
  };
  /** 수동 정산 지급. 실제 이체 없이 구간 상태만 RELEASED로 기록한다. */
  settlementPort?: {
    releaseInstallment(input: { installmentId: string }): Promise<{
      id: string;
      status: string;
      releasedAt: Date | null;
      holdReason?: string | null;
    }>;
  };
  clock?: { now(): Date };
  /** C 감사 로그와 A 카탈로그 변경을 같은 트랜잭션으로 묶는다. */
  transactionRunner?: { run<T>(work: (tx: unknown) => Promise<T>): Promise<T> };
}

export class AdminOpsService {
  private readonly repo: AdminRepository;
  private readonly catalogPort: CatalogAdminPort;
  private readonly depositPort?: AdminOpsServiceOptions["depositPort"];
  private readonly inspectionPort?: AdminOpsServiceOptions["inspectionPort"];
  private readonly cancellationPort?: AdminOpsServiceOptions["cancellationPort"];
  private readonly settlementPort?: AdminOpsServiceOptions["settlementPort"];
  private readonly clock: { now(): Date };
  private readonly transactionRunner?: AdminOpsServiceOptions["transactionRunner"];

  constructor(options: AdminOpsServiceOptions) {
    this.repo = options.repo;
    this.catalogPort = options.catalogPort;
    this.depositPort = options.depositPort;
    this.inspectionPort = options.inspectionPort;
    this.cancellationPort = options.cancellationPort;
    this.settlementPort = options.settlementPort;
    this.clock = options.clock ?? { now: () => new Date() };
    this.transactionRunner = options.transactionRunner;
  }

  private rethrowAsAdmin(err: unknown): never {
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && err instanceof Error) {
      throw new AdminHttpError(status, err.message);
    }
    throw err;
  }

  private checkAdminRole(actor: { userId: string; role: string }): void {
    if (actor.role !== "ADMIN") {
      throw new AdminHttpError(403, "관리자 권한이 필요합니다.");
    }
  }

  private validateReason(reason: string): void {
    if (!reason || reason.trim().length === 0) {
      throw new AdminHttpError(400, "관리자 조치 사유는 필수입니다.");
    }
  }

  async listBlocks(actor: { userId: string; role: string }): Promise<AdminBlock[]> {
    this.checkAdminRole(actor);
    return this.repo.listBlocks();
  }

  async executeBlockAction(
    actor: { userId: string; role: string },
    blockId: string,
    input: { action: string; reason: string; unitPrice?: number; mergedIntoId?: string },
  ): Promise<{ success: boolean; blockId: string; action: string }> {
    this.checkAdminRole(actor);
    this.validateReason(input.reason);
    const action = input.action?.trim();
    if (!action || !ADMIN_BLOCK_ACTIONS[action]) {
      throw new AdminHttpError(400, "허용되지 않은 블록 액션입니다. (UPDATE_PRICE|MERGE|DISABLE|ENABLE)");
    }
    if (action === "UPDATE_PRICE") {
      if (
        typeof input.unitPrice !== "number" ||
        Number.isSafeInteger(input.unitPrice) === false ||
        input.unitPrice <= 0
      ) {
        throw new AdminHttpError(400, "단가 수정은 양의 정수 unitPrice가 필요합니다.");
      }
    }
    if (action === "MERGE" && (!input.mergedIntoId || input.mergedIntoId.trim().length === 0)) {
      throw new AdminHttpError(400, "블록 병합은 mergedIntoId가 필요합니다.");
    }

    const work = async (tx?: unknown) => {
      const result = await this.catalogPort.executeBlockAction({
        actorId: actor.userId,
        blockId,
        action,
        reason: input.reason,
        unitPrice: input.unitPrice,
        mergedIntoId: input.mergedIntoId,
      }, tx);

      await this.repo.recordEvent({
        actorUserId: actor.userId,
        actionType: `BLOCK_${input.action}`,
        targetType: "BLOCK",
        targetId: blockId,
        reason: input.reason,
        occurredAt: this.clock.now(),
      }, tx);

      return result;
    };

    if (this.transactionRunner === undefined) return work();
    return this.transactionRunner.run(work);
  }

  async listHeldDeposits(actor: { userId: string; role: string }): Promise<AdminHeldDeposit[]> {
    this.checkAdminRole(actor);
    return this.repo.listHeldDeposits();
  }

  async resolveHeldDeposit(
    actor: { userId: string; role: string },
    depositId: string,
    input: { decision: "OPERATOR_CONFIRMED" | "OPERATOR_VOIDED"; reason: string; paymentKey?: string },
  ): Promise<AdminHeldDeposit> {
    this.checkAdminRole(actor);
    this.validateReason(input.reason);

    const deposit = await this.repo.getHeldDeposit(depositId);
    if (!deposit) throw new AdminHttpError(404, "보류된 예치 건을 찾을 수 없습니다.");
    if (!this.depositPort) {
      throw new AdminHttpError(503, "예치 서비스가 연결되지 않아 판정할 수 없습니다.");
    }

    let resolved: { deposit: { id: string; status: string } };
    try {
      resolved = await this.depositPort.resolveHeldDeposit({
        depositId,
        decision: input.decision,
        reason: input.reason,
        actorUserId: actor.userId,
        paymentKey: input.paymentKey,
      });
    } catch (err) {
      this.rethrowAsAdmin(err);
    }

    const nextStatus = resolved.deposit.status === "COMPLETED" ? "COMPLETED" : "FAILED";
    const wasTerminal = deposit.status !== "HELD";
    const updated = await this.repo.updateHeldDeposit(deposit.id, { status: nextStatus });

    if (!wasTerminal) {
      await this.repo.recordEvent({
        actorUserId: actor.userId,
        actionType: input.decision,
        targetType: "DEPOSIT",
        targetId: depositId,
        reason: input.reason,
        occurredAt: this.clock.now(),
      });
    }

    return updated;
  }

  async listEscalatedInspections(actor: { userId: string; role: string }): Promise<AdminEscalatedInspection[]> {
    this.checkAdminRole(actor);
    return this.repo.listEscalatedInspections();
  }

  async decideInspectionDispute(
    actor: { userId: string; role: string },
    inspectionRequestId: string,
    input: {
      decision: "REWORK_VALID" | "APPROVE" | "UNDECIDED_CONDITION";
      reason: string;
      decisionNotes: { client: string; supplier: string };
    },
  ): Promise<AdminEscalatedInspection> {
    this.checkAdminRole(actor);
    this.validateReason(input.reason);

    const inspection = await this.repo.getInspection(inspectionRequestId);
    if (!inspection) throw new AdminHttpError(404, "검수 요청을 찾을 수 없습니다.");
    if (!this.inspectionPort) {
      throw new AdminHttpError(503, "검수 서비스가 연결되지 않아 판정할 수 없습니다.");
    }

    try {
      await this.inspectionPort.decideDispute({
        inspectionRequestId,
        decision: input.decision,
        reason: input.reason,
        decisionNotes: input.decisionNotes,
      });
    } catch (err) {
      this.rethrowAsAdmin(err);
    }

    const wasResolved = inspection.status === "RESOLVED";
    const updated = await this.repo.updateInspection(inspection.id, {
      // REWORK_VALID는 납품 도메인과 같이 다시 '보완 진행'으로 남겨야 재납품할 수 있다.
      status: input.decision === "REWORK_VALID" ? "OPEN" : "RESOLVED",
      decision: input.decision,
      decisionNotes: input.decisionNotes,
    });

    if (!wasResolved) {
      await this.repo.recordEvent({
        actorUserId: actor.userId,
        actionType: `DISPUTE_${input.decision}`,
        targetType: "INSPECTION",
        targetId: inspectionRequestId,
        reason: input.reason,
        occurredAt: this.clock.now(),
      });
    }

    return updated;
  }

  async listCancellationQueue(actor: { userId: string; role: string }): Promise<AdminCancellationContract[]> {
    this.checkAdminRole(actor);
    return this.repo.listCancellationQueue();
  }

  async decideCancellation(
    actor: { userId: string; role: string },
    contractId: string,
    input: { compensationRate: number; reason: string },
  ): Promise<AdminCancellationContract> {
    this.checkAdminRole(actor);
    this.validateReason(input.reason);

    const contract = await this.repo.getCancellationContract(contractId);
    if (!contract) throw new AdminHttpError(404, "취소 계약을 찾을 수 없습니다.");
    if (!this.cancellationPort) {
      throw new AdminHttpError(503, "취소 서비스가 연결되지 않아 판정할 수 없습니다.");
    }

    let decided: {
      status: string;
      compensationRate: number | null;
      refundAmount: number | null;
      settledAmount: number | null;
      clientFeeRefund: number | null;
      cancelResolution: string | null;
      cancelResolvedAt: Date | null;
    };
    try {
      decided = await this.cancellationPort.decideCancellation({
        contractId,
        compensationRate: input.compensationRate,
        reason: input.reason,
      });
    } catch (err) {
      this.rethrowAsAdmin(err);
    }

    const wasResolved = contract.status === "CANCELLED" && contract.cancelResolution === "ADMIN_DECIDED";
    const updated = await this.repo.updateCancellationContract(contract.id, {
      status: decided.status,
      compensationRate: decided.compensationRate,
      refundAmount: decided.refundAmount,
      settledAmount: decided.settledAmount,
      clientFeeRefund: decided.clientFeeRefund,
      cancelResolution: decided.cancelResolution === "ADMIN_DECIDED" ? "ADMIN_DECIDED" : null,
      cancelResolvedAt: decided.cancelResolvedAt,
    });

    if (!wasResolved) {
      await this.repo.recordEvent({
        actorUserId: actor.userId,
        actionType: "CANCELLATION_ADMIN_DECIDED",
        targetType: "CONTRACT",
        targetId: contractId,
        reason: input.reason,
        occurredAt: this.clock.now(),
      });
    }

    return updated;
  }

  async markSettlementProcessed(
    actor: { userId: string; role: string },
    contractId: string,
    input: { refunded: boolean; cancelPayout: boolean; reason: string },
  ): Promise<AdminCancellationContract> {
    this.checkAdminRole(actor);
    this.validateReason(input.reason);

    const contract = await this.repo.getCancellationContract(contractId);
    if (!contract) throw new AdminHttpError(404, "취소 계약을 찾을 수 없습니다.");

    let refundedAt: Date | null = contract.refundedAt ?? null;
    let cancelPayoutAt: Date | null = contract.cancelPayoutAt ?? null;
    if (this.cancellationPort?.markProcessed) {
      try {
        const processed = await this.cancellationPort.markProcessed({
          contractId,
          operatorId: actor.userId,
          refunded: input.refunded,
          cancelPayout: input.cancelPayout,
        });
        refundedAt = processed.refundedAt;
        cancelPayoutAt = processed.cancelPayoutAt;
      } catch (err) {
        this.rethrowAsAdmin(err);
      }
    } else {
      const now = this.clock.now();
      refundedAt = input.refunded ? (contract.refundedAt ?? now) : (contract.refundedAt ?? null);
      cancelPayoutAt = input.cancelPayout ? (contract.cancelPayoutAt ?? now) : (contract.cancelPayoutAt ?? null);
    }

    const updated = await this.repo.updateCancellationContract(contract.id, {
      refundedAt,
      cancelPayoutAt,
    });

    await this.repo.recordEvent({
      actorUserId: actor.userId,
      actionType: "SETTLEMENT_MANUAL_PROCESSED",
      targetType: "CONTRACT",
      targetId: contractId,
      reason: input.reason,
      occurredAt: this.clock.now(),
    });

    return updated;
  }

  async releaseInstallment(
    actor: { userId: string; role: string },
    installmentId: string,
    input: { reason: string },
  ): Promise<{ id: string; status: string; releasedAt: Date | null; holdReason?: string | null }> {
    this.checkAdminRole(actor);
    this.validateReason(input.reason);
    if (!this.settlementPort) {
      throw new AdminHttpError(503, "정산 지급을 사용할 수 없습니다.");
    }

    try {
      const released = await this.settlementPort.releaseInstallment({ installmentId });
      await this.repo.recordEvent({
        actorUserId: actor.userId,
        actionType: "SETTLEMENT_MANUAL_RELEASED",
        targetType: "INSTALLMENT",
        targetId: installmentId,
        reason: input.reason,
        occurredAt: this.clock.now(),
      });
      return released;
    } catch (err) {
      this.rethrowAsAdmin(err);
    }
  }

  async listEventLogs(
    actor: { userId: string; role: string },
    filter?: {
      actorUserId?: string;
      actionType?: string;
      targetType?: string;
      targetId?: string;
      from?: Date;
      to?: Date;
    },
  ): Promise<EventLogEntity[]> {
    this.checkAdminRole(actor);
    const logs = await this.repo.listEventLogs();
    if (!filter) return logs;
    return logs.filter((log) => {
      if (filter.actorUserId && log.actorUserId !== filter.actorUserId) return false;
      if (filter.actionType && log.actionType !== filter.actionType) return false;
      if (filter.targetType && log.targetType !== filter.targetType) return false;
      if (filter.targetId && log.targetId !== filter.targetId) return false;
      if (filter.from && log.occurredAt.getTime() < filter.from.getTime()) return false;
      if (filter.to && log.occurredAt.getTime() > filter.to.getTime()) return false;
      return true;
    });
  }
}
