import { endOfKstDayPlus, isClientFullRefund } from "../settlement/policy.ts";

export class CancellationHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CancellationHttpError";
    this.status = status;
  }
}

export type CancelCause = "CLIENT" | "SUPPLIER" | "MUTUAL";
export type CancelResolution = "AGREED" | "ADMIN_DECIDED";

const CANCEL_CAUSES: readonly CancelCause[] = ["CLIENT", "SUPPLIER", "MUTUAL"];

export interface CancellationMessageInfo {
  id: string;
  contractId: string;
  authorUserId: string;
}

export interface CancellationMessagePort {
  getMessage(id: string): Promise<CancellationMessageInfo | null>;
}

export interface CancellationContractEntity {
  id: string;
  clientUserId: string;
  supplierUserId: string;
  status: string;
  paymentStatus: string;
  agreedAmount: number;
  clientFee: number;
  totalDeposited: number;
  interimRatio: number;
  depositedAt: Date | null;
  cancelCause: CancelCause | null;
  cancelRequestedBy: string | null;
  cancelRequestedAt: Date | null;
  cancelNote: string | null;
  objectionNote: string | null;
  objectionRate: number | null;
  cancelEvidence: unknown | null;
  cancelEscalatedAt: Date | null;
  compensationRate: number | null;
  cancelResolution: CancelResolution | null;
  cancelResolvedAt: Date | null;
  refundAmount: number | null;
  clientFeeRefund: number | null;
  settledAmount: number | null;
  refundReason: string | null;
  refundedAt: Date | null;
  cancelPayoutAt: Date | null;
}

export interface CancellationInstallmentInfo {
  id: string;
  contractId: string;
  stage: "INTERIM" | "FINAL";
  amount: number;
  status: "PENDING" | "DELIVERED" | "REWORK_REQUESTED" | "APPROVED" | "RELEASED" | "REFUNDED";
}

export interface CancellationRepository {
  seedContract(contract: CancellationContractEntity): void;
  seedInstallments(installments: CancellationInstallmentInfo[]): void;
  getContract(id: string): Promise<CancellationContractEntity | null>;
  updateContract(id: string, patch: Partial<CancellationContractEntity>): Promise<CancellationContractEntity>;
  listInstallments(contractId: string): Promise<CancellationInstallmentInfo[]>;
  updateInstallment(
    id: string,
    patch: Partial<CancellationInstallmentInfo>,
  ): Promise<CancellationInstallmentInfo>;
}

export function createInMemoryCancellationRepository(): CancellationRepository {
  const contracts = new Map<string, CancellationContractEntity>();
  const installments = new Map<string, CancellationInstallmentInfo>();

  return {
    seedContract(contract) {
      contracts.set(contract.id, { ...contract });
    },
    seedInstallments(items) {
      for (const item of items) {
        installments.set(item.id, { ...item });
      }
    },
    async getContract(id) {
      return contracts.get(id) ?? null;
    },
    async updateContract(id, patch) {
      const c = contracts.get(id);
      if (!c) throw new CancellationHttpError(404, "계약을 찾을 수 없습니다.");
      const updated = { ...c, ...patch };
      contracts.set(id, updated);
      return updated;
    },
    async listInstallments(contractId) {
      return Array.from(installments.values()).filter((i) => i.contractId === contractId);
    },
    async updateInstallment(id, patch) {
      const inst = installments.get(id);
      if (!inst) throw new CancellationHttpError(404, "구간을 찾을 수 없습니다.");
      const updated = { ...inst, ...patch };
      installments.set(id, updated);
      return updated;
    },
  };
}

export interface CancellationServiceOptions {
  repo: CancellationRepository;
  clock?: { now(): Date };
  messagePort?: CancellationMessagePort;
}

export class CancellationService {
  private readonly repo: CancellationRepository;
  private readonly clock: { now(): Date };
  private readonly messagePort?: CancellationMessagePort;

  constructor(options: CancellationServiceOptions) {
    this.repo = options.repo;
    this.clock = options.clock ?? { now: () => new Date() };
    this.messagePort = options.messagePort;
  }

  async requestCancellation(
    actor: { userId: string; role: string },
    input: {
      contractId: string;
      cause: CancelCause;
      note: string;
      evidence?: unknown;
      /** 내부 서비스 계약. HTTP 본문 필드명은 Gate 0 확정 전까지 API_CONTRACT에 없다. */
      proposedCompensationRate?: number;
    },
  ): Promise<CancellationContractEntity> {
    const contract = await this.repo.getContract(input.contractId);
    if (!contract) throw new CancellationHttpError(404, "계약을 찾을 수 없습니다.");

    const isClient = actor.userId === contract.clientUserId;
    const isSupplier = actor.userId === contract.supplierUserId;
    if (!isClient && !isSupplier) {
      throw new CancellationHttpError(403, "계약 당사자만 취소를 요청할 수 있습니다.");
    }

    if (!CANCEL_CAUSES.includes(input.cause)) {
      throw new CancellationHttpError(400, "취소 사유는 CLIENT|SUPPLIER|MUTUAL 중 하나여야 합니다.");
    }
    if (!input.note || input.note.trim().length === 0) {
      throw new CancellationHttpError(400, "취소 사유 설명은 필수입니다.");
    }
    if (input.cause === "CLIENT" && !isClient) {
      throw new CancellationHttpError(422, "의뢰인 사정 취소는 의뢰인만 요청할 수 있습니다.");
    }
    if (input.cause === "SUPPLIER" && !isSupplier) {
      throw new CancellationHttpError(422, "공급자 사정 취소는 공급자만 요청할 수 있습니다.");
    }

    if (contract.status === "CANCEL_REQUESTED" || contract.status === "CANCELLED") {
      throw new CancellationHttpError(409, "이미 취소 진행 중이거나 취소된 계약입니다.");
    }
    if (contract.status !== "ACTIVE") {
      throw new CancellationHttpError(409, "진행 중(ACTIVE) 계약만 취소를 요청할 수 있습니다.");
    }
    if (contract.paymentStatus !== "DEPOSITED" && contract.paymentStatus !== "PARTIALLY_RELEASED") {
      throw new CancellationHttpError(
        409,
        "예치 완료된 계약만 취소를 요청할 수 있습니다. 예치 전 계약은 기한 경과 시 자동 결렬됩니다.",
      );
    }

    let proposedRate: number | null = null;
    if (input.cause === "MUTUAL") {
      if (
        typeof input.proposedCompensationRate !== "number" ||
        Number.isInteger(input.proposedCompensationRate) === false ||
        input.proposedCompensationRate < 0 ||
        input.proposedCompensationRate > 100
      ) {
        throw new CancellationHttpError(422, "합의 취소는 0~100 정수 보상 비율 제안이 필요합니다.");
      }
      proposedRate = input.proposedCompensationRate;
    }

    const evidence = await this.validateEvidence(contract, input.evidence);

    return this.repo.updateContract(contract.id, {
      status: "CANCEL_REQUESTED",
      cancelCause: input.cause,
      cancelRequestedBy: actor.userId,
      cancelRequestedAt: this.clock.now(),
      cancelNote: input.note,
      cancelEvidence: evidence,
      compensationRate: proposedRate,
    });
  }

  private async validateEvidence(
    contract: CancellationContractEntity,
    evidence: unknown,
  ): Promise<{ messageIds: string[] } | null> {
    if (evidence === undefined || evidence === null) return null;
    if (typeof evidence !== "object" || Array.isArray(evidence)) {
      throw new CancellationHttpError(422, "취소 근거는 메시지 ID 목록이어야 합니다.");
    }
    const ids = (evidence as { messageIds?: unknown }).messageIds;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.some((id) => typeof id !== "string" || id.trim().length === 0)
    ) {
      throw new CancellationHttpError(422, "취소 근거는 1개 이상의 메시지 ID가 필요합니다.");
    }
    if (!this.messagePort) {
      throw new CancellationHttpError(422, "근거 메시지를 검증할 수 없습니다.");
    }
    for (const id of ids) {
      const message = await this.messagePort.getMessage(id);
      const isParty =
        message !== null &&
        (message.authorUserId === contract.clientUserId || message.authorUserId === contract.supplierUserId);
      if (!message || message.contractId !== contract.id || !isParty) {
        throw new CancellationHttpError(422, "계약 당사자가 작성한 이 계약의 메시지만 근거로 쓸 수 있습니다.");
      }
    }
    return { messageIds: ids as string[] };
  }

  async agreeCancellation(
    actor: { userId: string; role: string },
    input: { contractId: string },
  ): Promise<CancellationContractEntity> {
    const contract = await this.repo.getContract(input.contractId);
    if (!contract) throw new CancellationHttpError(404, "계약을 찾을 수 없습니다.");

    if (contract.status !== "CANCEL_REQUESTED") {
      throw new CancellationHttpError(409, "취소 요청 상태의 계약이 아닙니다.");
    }

    if (contract.cancelResolvedAt) {
      throw new CancellationHttpError(409, "이미 확정된 취소 건입니다.");
    }

    if (contract.cancelEscalatedAt) {
      throw new CancellationHttpError(409, "3일 무응답으로 운영자 판정 대기 중입니다.");
    }

    // 상대방인지 확인
    const isCounterparty =
      (contract.cancelRequestedBy === contract.clientUserId && actor.userId === contract.supplierUserId) ||
      (contract.cancelRequestedBy === contract.supplierUserId && actor.userId === contract.clientUserId);

    if (!isCounterparty) {
      throw new CancellationHttpError(403, "취소를 요청한 상대방만 동의할 수 있습니다.");
    }

    const installments = await this.repo.listInstallments(contract.id);
    const requestedAt = contract.cancelRequestedAt ?? this.clock.now();
    const clientFullRefund = isClientFullRefund({
      cause: contract.cancelCause,
      depositedAt: contract.depositedAt,
      requestedAt,
      installmentStatuses: installments.map((row) => row.status),
    });

    // 합의 사유는 요청 단계에 기록된 비율만 확정한다. 그 외 사유는 PRD 13.2 정책값을 쓴다.
    let agreedRate: number | null;
    if (contract.cancelCause === "MUTUAL") {
      if (contract.compensationRate === null) {
        throw new CancellationHttpError(409, "합의 보상 비율이 요청에 기록되지 않았습니다.");
      }
      agreedRate = contract.compensationRate;
    } else if (contract.cancelCause === "SUPPLIER") {
      agreedRate = 0;
    } else if (contract.cancelCause === "CLIENT") {
      // D-16: 예치 후 24시간 내·무납품이면 보상 없이 전액 환불(nullable 표현).
      agreedRate = clientFullRefund ? null : 50;
    } else {
      throw new CancellationHttpError(409, "취소 사유가 기록되지 않았습니다.");
    }

    const split = await this.calculateCancellationSplit(contract.id, agreedRate ?? 0);

    return this.repo.updateContract(contract.id, {
      cancelResolution: "AGREED",
      cancelResolvedAt: this.clock.now(),
      status: "CANCELLED",
      compensationRate: agreedRate,
      refundAmount: split.refundAmount,
      settledAmount: split.settledAmount,
      clientFeeRefund: split.clientFeeRefund,
    });
  }

  async objectCancellation(
    actor: { userId: string; role: string },
    input: { contractId: string; objectionRate: number; note: string },
  ): Promise<CancellationContractEntity> {
    const contract = await this.repo.getContract(input.contractId);
    if (!contract) throw new CancellationHttpError(404, "계약을 찾을 수 없습니다.");

    if (contract.status !== "CANCEL_REQUESTED") {
      throw new CancellationHttpError(409, "취소 요청 상태의 계약이 아닙니다.");
    }

    if (contract.cancelResolvedAt) {
      throw new CancellationHttpError(409, "이미 동의 또는 판정 완료된 계약입니다.");
    }

    if (contract.cancelEscalatedAt) {
      throw new CancellationHttpError(409, "이미 운영자 판정 대기 중이라 이의를 다시 제기할 수 없습니다.");
    }

    const isCounterparty =
      (contract.cancelRequestedBy === contract.clientUserId && actor.userId === contract.supplierUserId) ||
      (contract.cancelRequestedBy === contract.supplierUserId && actor.userId === contract.clientUserId);
    if (!isCounterparty) {
      throw new CancellationHttpError(403, "취소를 요청한 상대방만 이의를 제기할 수 있습니다.");
    }

    if (
      typeof input.objectionRate !== "number" ||
      Number.isInteger(input.objectionRate) === false ||
      input.objectionRate < 0 ||
      input.objectionRate > 100
    ) {
      throw new CancellationHttpError(422, "보상 비율은 0~100 사이여야 합니다.");
    }
    const installments = await this.repo.listInstallments(contract.id);
    const requestedAt = contract.cancelRequestedAt ?? this.clock.now();
    const clientFullRefund = isClientFullRefund({
      cause: contract.cancelCause,
      depositedAt: contract.depositedAt,
      requestedAt,
      installmentStatuses: installments.map((row) => row.status),
    });
    if (contract.cancelCause === "CLIENT" && !clientFullRefund && input.objectionRate < 50) {
      throw new CancellationHttpError(422, "의뢰인 사정 취소는 보상 비율이 50% 이상이어야 합니다.");
    }

    return this.repo.updateContract(contract.id, {
      objectionRate: input.objectionRate,
      objectionNote: input.note,
      cancelEscalatedAt: this.clock.now(), // 이의 제기 시 운영자 판정 대기로 전환
    });
  }

  async withdrawCancellation(
    actor: { userId: string; role: string },
    input: { contractId: string },
  ): Promise<CancellationContractEntity> {
    const contract = await this.repo.getContract(input.contractId);
    if (!contract) throw new CancellationHttpError(404, "계약을 찾을 수 없습니다.");

    const isParty = actor.userId === contract.clientUserId || actor.userId === contract.supplierUserId;
    if (!isParty) throw new CancellationHttpError(403, "계약 당사자만 취소 요청을 철회할 수 있습니다.");
    if (contract.status !== "CANCEL_REQUESTED") {
      throw new CancellationHttpError(409, "취소 요청 상태의 계약이 아닙니다.");
    }
    if (contract.cancelResolvedAt) {
      throw new CancellationHttpError(409, "이미 동의 또는 판정 완료된 취소 건입니다.");
    }
    if (contract.cancelEscalatedAt) {
      throw new CancellationHttpError(409, "운영자 판정 대기 중에는 취소 요청을 철회할 수 없습니다.");
    }
    if (contract.cancelRequestedBy !== actor.userId) {
      throw new CancellationHttpError(403, "취소를 요청한 본인만 철회할 수 있습니다.");
    }

    return this.repo.updateContract(contract.id, {
      status: "ACTIVE",
      cancelCause: null,
      cancelRequestedBy: null,
      cancelRequestedAt: null,
      cancelNote: null,
      cancelEvidence: null,
      compensationRate: null,
      objectionRate: null,
      objectionNote: null,
      cancelEscalatedAt: null,
    });
  }

  async checkCancellationDeadlines(
    contractId: string,
    now: Date,
  ): Promise<{ escalatedToAdmin: boolean }> {
    const contract = await this.repo.getContract(contractId);
    if (!contract || contract.status !== "CANCEL_REQUESTED") return { escalatedToAdmin: false };

    if (!contract.cancelResolvedAt && !contract.cancelEscalatedAt && contract.cancelRequestedAt) {
      const deadline = endOfKstDayPlus(contract.cancelRequestedAt, 3);
      if (now.getTime() > deadline.getTime()) {
        await this.repo.updateContract(contract.id, {
          cancelEscalatedAt: now,
        });
        return { escalatedToAdmin: true };
      }
    }

    return { escalatedToAdmin: false };
  }

  async decideCancellation(input: {
    contractId: string;
    compensationRate: number;
    reason: string;
  }): Promise<CancellationContractEntity> {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new CancellationHttpError(400, "운영자 판정 사유는 필수입니다.");
    }
    if (
      typeof input.compensationRate !== "number" ||
      Number.isInteger(input.compensationRate) === false ||
      input.compensationRate < 0 ||
      input.compensationRate > 100
    ) {
      throw new CancellationHttpError(422, "보상 비율은 0~100 사이의 정수여야 합니다.");
    }

    const contract = await this.repo.getContract(input.contractId);
    if (!contract) throw new CancellationHttpError(404, "계약을 찾을 수 없습니다.");

    // 확정된 취소는 같은 요청을 반복해도 아무 값도 바꾸지 않는다.
    if (contract.cancelResolvedAt || contract.cancelResolution) {
      return contract;
    }

    if (contract.status !== "CANCEL_REQUESTED") {
      throw new CancellationHttpError(409, "취소 요청 상태의 계약만 운영자 판정할 수 있습니다.");
    }
    if (!contract.cancelEscalatedAt && contract.objectionRate === null) {
      throw new CancellationHttpError(409, "상대 이의 또는 3일 무응답 에스컬레이션 이후에만 운영자 판정할 수 있습니다.");
    }

    const installments = await this.repo.listInstallments(contract.id);
    const requestedAt = contract.cancelRequestedAt ?? this.clock.now();
    const clientFullRefund = isClientFullRefund({
      cause: contract.cancelCause,
      depositedAt: contract.depositedAt,
      requestedAt,
      installmentStatuses: installments.map((row) => row.status),
    });

    if (contract.cancelCause === "CLIENT" && !clientFullRefund && input.compensationRate < 50) {
      throw new CancellationHttpError(
        422,
        "의뢰인 사정 취소는 보상 비율이 50% 이상이어야 합니다. (raw 제약 6)",
      );
    }
    const effectiveRate = contract.cancelCause === "CLIENT" && clientFullRefund ? 0 : input.compensationRate;
    const split = await this.calculateCancellationSplit(contract.id, effectiveRate);

    return this.repo.updateContract(contract.id, {
      compensationRate: contract.cancelCause === "CLIENT" && clientFullRefund ? null : input.compensationRate,
      refundReason: input.reason,
      refundAmount: split.refundAmount,
      settledAmount: split.settledAmount,
      clientFeeRefund: split.clientFeeRefund,
      cancelResolution: "ADMIN_DECIDED",
      cancelResolvedAt: this.clock.now(),
      status: "CANCELLED",
    });
  }

  async calculateCancellationSplit(
    contractId: string,
    compensationRate: number,
  ): Promise<{
    refundAmount: number;
    settledAmount: number;
    clientFeeRefund: number;
    ongoingStagePaidFull: boolean;
  }> {
    const contract = await this.repo.getContract(contractId);
    if (!contract) throw new CancellationHttpError(404, "계약을 찾을 수 없습니다.");

    const installments = await this.repo.listInstallments(contract.id);
    const ordered = installments
      .slice()
      .sort((a, b) => (a.stage === b.stage ? 0 : a.stage === "INTERIM" ? -1 : 1));
    const released = ordered.filter((row) => row.status === "RELEASED");
    const releasedPrincipal = released.reduce((sum, row) => sum + row.amount, 0);
    const unpaid = ordered.filter((row) => row.status !== "RELEASED" && row.status !== "REFUNDED");

    // 기준은 아직 지급되지 않은 첫 구간(진행 중 구간)이다.
    const ongoing = unpaid[0];
    const ongoingStageAmount = ongoing?.amount ?? 0;
    const ongoingStagePaidFull = ongoing?.status === "DELIVERED" || ongoing?.status === "APPROVED";

    let compensationPrincipal = 0;
    if (contract.cancelCause !== "SUPPLIER" && ongoing) {
      compensationPrincipal = ongoingStagePaidFull
        ? ongoingStageAmount
        : Math.floor((ongoingStageAmount * compensationRate) / 100);
    }
    if (compensationPrincipal > ongoingStageAmount) {
      throw new CancellationHttpError(422, "보상 원금이 진행 중 구간 금액을 초과할 수 없습니다.");
    }

    const supplierFee = Math.floor((compensationPrincipal * 5) / 100);
    const settledAmount = compensationPrincipal - supplierFee;

    // 남은 예치 잔액 = 총예치 - 이미 지급된 구간 원금
    const remainingDeposit = contract.totalDeposited - releasedPrincipal;
    const refundAmount = remainingDeposit - compensationPrincipal - supplierFee;
    if (refundAmount < 0) {
      throw new CancellationHttpError(422, "이미 지급된 금액을 초과하는 환불/보상은 불가합니다.");
    }

    // 수수료 환급: 공급자 지급 확정액에만 양측 5%, 나머지 의뢰인 수수료 환불
    const clientFeeKept = supplierFee;
    const clientFeeRefund = Math.max(0, contract.clientFee - clientFeeKept);

    return {
      refundAmount,
      settledAmount,
      clientFeeRefund,
      ongoingStagePaidFull,
    };
  }

  async getCancellation(
    actor: { userId: string; role: string },
    contractId: string,
  ): Promise<{
    contractId: string;
    status: string;
    cancelCause: CancelCause | null;
    cancelRequestedBy: string | null;
    cancelRequestedAt: Date | null;
    cancelNote: string | null;
    cancelEvidence: unknown | null;
    objectionRate: number | null;
    objectionNote: string | null;
    cancelEscalatedAt: Date | null;
    compensationRate: number | null;
    cancelResolution: CancelResolution | null;
    cancelResolvedAt: Date | null;
    refundAmount: number | null;
    settledAmount: number | null;
    clientFeeRefund: number | null;
    refundReason: string | null;
    refundedAt: Date | null;
    cancelPayoutAt: Date | null;
    paused: boolean;
  }> {
    const contract = await this.repo.getContract(contractId);
    if (!contract) throw new CancellationHttpError(404, "계약을 찾을 수 없습니다.");

    const isParty = actor.userId === contract.clientUserId || actor.userId === contract.supplierUserId;
    if (!isParty && actor.role !== "ADMIN") {
      throw new CancellationHttpError(403, "계약 당사자 또는 운영자만 취소 상세를 조회할 수 있습니다.");
    }

    return {
      contractId: contract.id,
      status: contract.status,
      cancelCause: contract.cancelCause,
      cancelRequestedBy: contract.cancelRequestedBy,
      cancelRequestedAt: contract.cancelRequestedAt,
      cancelNote: contract.cancelNote,
      cancelEvidence: contract.cancelEvidence,
      objectionRate: contract.objectionRate,
      objectionNote: contract.objectionNote,
      cancelEscalatedAt: contract.cancelEscalatedAt,
      compensationRate: contract.compensationRate,
      cancelResolution: contract.cancelResolution,
      cancelResolvedAt: contract.cancelResolvedAt,
      refundAmount: contract.refundAmount,
      settledAmount: contract.settledAmount,
      clientFeeRefund: contract.clientFeeRefund,
      refundReason: contract.refundReason,
      refundedAt: contract.refundedAt,
      cancelPayoutAt: contract.cancelPayoutAt,
      paused: contract.status === "CANCEL_REQUESTED",
    };
  }

  async isOperationsPaused(contractId: string): Promise<boolean> {
    const contract = await this.repo.getContract(contractId);
    return contract?.status === "CANCEL_REQUESTED";
  }

  async markProcessed(input: {
    contractId: string;
    operatorId: string;
    refunded: boolean;
    cancelPayout: boolean;
  }): Promise<CancellationContractEntity> {
    const contract = await this.repo.getContract(input.contractId);
    if (!contract) throw new CancellationHttpError(404, "계약을 찾을 수 없습니다.");

    const now = this.clock.now();
    return this.repo.updateContract(contract.id, {
      refundedAt: input.refunded ? now : contract.refundedAt,
      cancelPayoutAt: input.cancelPayout ? now : contract.cancelPayoutAt,
    });
  }
}
