import { endOfKstDayPlus } from "../settlement/policy.ts";

export type DeliveryStatus = "SUBMITTED" | "PARTIALLY_APPROVED" | "APPROVED" | "REWORK_REQUESTED";
export type InspectionReason = "CONDITION_MISMATCH" | "NOT_WORKING" | "MISSING_PART" | "OTHER";
export type InspectionStatus = "OPEN" | "RESOLVED" | "ESCALATED";
export type ConditionState = "DECIDED" | "PROPOSED" | "UNDECIDED";
export type DisputeDecision = "REWORK_VALID" | "APPROVE" | "UNDECIDED_CONDITION";

const INSPECTION_REASONS: readonly InspectionReason[] = [
  "CONDITION_MISMATCH",
  "NOT_WORKING",
  "MISSING_PART",
  "OTHER",
];

export interface DeliveryFile {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface DeliveryItemPayload {
  contractItemId: string;
  links: string[];
  files: DeliveryFile[];
  howToCheck: string;
}

export interface DeliveryEntity {
  id: string;
  installmentId: string;
  attemptNo: number;
  items: DeliveryItemPayload[];
  summary: string | null;
  status: DeliveryStatus;
  submittedAt: Date;
  inspectionDueAt: Date;
  reviewedAt: Date | null;
}

export interface ConditionLine {
  key: string;
  text: string;
  state: ConditionState;
}

export interface ContractItemEntity {
  id: string;
  contractId: string;
  stage: "INTERIM" | "FINAL";
  title: string;
  description: string;
  conditions: ConditionLine[];
  approvedAt: Date | null;
  autoApproved: boolean;
}

export interface InspectionRequestEntity {
  id: string;
  deliveryId: string;
  contractItemId: string;
  reason: InspectionReason;
  conditionKey: string | null;
  note?: string | null;
  status: InspectionStatus;
  escalatedAt: Date | null;
  escalation?: unknown;
  decision?: DisputeDecision | null;
  decisionNotes?: { client: string; supplier: string } | null;
  resolvedAt?: Date | null;
  createdAt: Date;
}

export interface DeliveryContractInfo {
  id: string;
  clientUserId: string;
  supplierUserId: string;
  status: string;
  paymentStatus: string;
  depositDeadline?: Date;
  workDueAt?: Date;
}

export interface DeliveryInstallmentInfo {
  id: string;
  contractId: string;
  stage: "INTERIM" | "FINAL";
  status: string;
}

export interface NotificationPorts {
  createOnce(input: {
    userId: string;
    type: string;
    targetId: string;
    targetUrl?: string;
    /** 기한 알림(DEPOSIT_DUE/INSPECTION_DUE/WORK_DUE/WORK_OVERDUE)은 dueAt이 필수다. */
    dueAt?: Date;
  }, tx?: unknown): Promise<{ created: boolean }>;
}

export interface SettlementApprovalPort {
  approveInstallment(input: { contractId: string; installmentId: string }): Promise<unknown>;
  /** 항목 승인 쓰기 전에 구간 승인 가능 여부를 확인한다. */
  assertApprovable?(input: {
    contractId: string;
    installmentId: string;
    assumingApprovedItemId?: string;
  }): Promise<void>;
}

export interface InspectionOpsPorts {
  createSystemMessage?(input: {
    contractId: string;
    targetId: string;
    type: string;
    body: string;
  }): Promise<void>;
  recordEvent?(input: {
    actionType: string;
    targetType: string;
    targetId: string;
    reason: string;
    payload?: unknown;
  }): Promise<void>;
}

export class DeliveryHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DeliveryHttpError";
    this.status = status;
  }
}

export interface DeliveryRepository {
  seedContract(contract: DeliveryContractInfo): void;
  seedInstallment(installment: DeliveryInstallmentInfo): void;
  seedContractItems(items: ContractItemEntity[]): void;
  getContract(id: string): Promise<DeliveryContractInfo | null>;
  getInstallment(id: string): Promise<DeliveryInstallmentInfo | null>;
  updateInstallment(id: string, patch: Partial<DeliveryInstallmentInfo>): Promise<DeliveryInstallmentInfo>;
  getContractItem(id: string): Promise<ContractItemEntity | null>;
  listContractItemsByContractId(contractId: string): Promise<ContractItemEntity[]>;
  updateContractItem(id: string, patch: Partial<ContractItemEntity>): Promise<ContractItemEntity>;
  createDelivery(data: Omit<DeliveryEntity, "id">): Promise<DeliveryEntity>;
  getDelivery(id: string): Promise<DeliveryEntity | null>;
  listDeliveries(installmentId: string): Promise<DeliveryEntity[]>;
  listInstallments(contractId: string): Promise<DeliveryInstallmentInfo[]>;
  updateDelivery(id: string, patch: Partial<DeliveryEntity>): Promise<DeliveryEntity>;
  createInspectionRequest(data: Omit<InspectionRequestEntity, "id">): Promise<InspectionRequestEntity>;
  getInspectionRequest(id: string): Promise<InspectionRequestEntity | null>;
  listInspectionRequestsByItem(contractItemId: string): Promise<InspectionRequestEntity[]>;
  listInspectionRequestsByDelivery(deliveryId: string): Promise<InspectionRequestEntity[]>;
  updateInspectionRequest(id: string, patch: Partial<InspectionRequestEntity>): Promise<InspectionRequestEntity>;
}

export function createInMemoryDeliveryRepository(): DeliveryRepository {
  const contracts = new Map<string, DeliveryContractInfo>();
  const installments = new Map<string, DeliveryInstallmentInfo>();
  const contractItems = new Map<string, ContractItemEntity>();
  const deliveries = new Map<string, DeliveryEntity>();
  const inspections = new Map<string, InspectionRequestEntity>();
  let idCounter = 1;

  return {
    seedContract(contract) {
      contracts.set(contract.id, { ...contract });
    },
    seedInstallment(installment) {
      installments.set(installment.id, { ...installment });
    },
    seedContractItems(items) {
      for (const item of items) {
        contractItems.set(item.id, { ...item });
      }
    },
    async getContract(id) {
      return contracts.get(id) ?? null;
    },
    async getInstallment(id) {
      return installments.get(id) ?? null;
    },
    async updateInstallment(id, patch) {
      const installment = installments.get(id);
      if (!installment) throw new DeliveryHttpError(404, "구간을 찾을 수 없습니다.");
      const updated = { ...installment, ...patch };
      installments.set(id, updated);
      return updated;
    },
    async getContractItem(id) {
      return contractItems.get(id) ?? null;
    },
    async listContractItemsByContractId(contractId) {
      return Array.from(contractItems.values()).filter((i) => i.contractId === contractId);
    },
    async updateContractItem(id, patch) {
      const item = contractItems.get(id);
      if (!item) throw new DeliveryHttpError(404, "계약 항목을 찾을 수 없습니다.");
      const updated = { ...item, ...patch };
      contractItems.set(id, updated);
      return updated;
    },
    async createDelivery(data) {
      const id = `del-${idCounter++}`;
      const rec: DeliveryEntity = { ...data, id };
      deliveries.set(id, rec);
      return rec;
    },
    async getDelivery(id) {
      return deliveries.get(id) ?? null;
    },
    async listDeliveries(installmentId) {
      return Array.from(deliveries.values())
        .filter((d) => d.installmentId === installmentId)
        .sort((a, b) => a.attemptNo - b.attemptNo);
    },
    async listInstallments(contractId) {
      return Array.from(installments.values()).filter((i) => i.contractId === contractId);
    },
    async updateDelivery(id, patch) {
      const d = deliveries.get(id);
      if (!d) throw new DeliveryHttpError(404, "납품을 찾을 수 없습니다.");
      const updated = { ...d, ...patch };
      deliveries.set(id, updated);
      return updated;
    },
    async createInspectionRequest(data) {
      const id = `insp-${idCounter++}`;
      const rec: InspectionRequestEntity = { ...data, id };
      inspections.set(id, rec);
      return rec;
    },
    async getInspectionRequest(id) {
      return inspections.get(id) ?? null;
    },
    async listInspectionRequestsByItem(contractItemId) {
      return Array.from(inspections.values()).filter((i) => i.contractItemId === contractItemId);
    },
    async listInspectionRequestsByDelivery(deliveryId) {
      return Array.from(inspections.values()).filter((i) => i.deliveryId === deliveryId);
    },
    async updateInspectionRequest(id, patch) {
      const rec = inspections.get(id);
      if (!rec) throw new DeliveryHttpError(404, "보완 요청을 찾을 수 없습니다.");
      const updated = { ...rec, ...patch };
      inspections.set(id, updated);
      return updated;
    },
  };
}

export interface DeliveryServiceOptions {
  repo: DeliveryRepository;
  clock?: { now(): Date };
  settlementPort?: SettlementApprovalPort;
  opsPorts?: InspectionOpsPorts;
}

async function applyAutoEscalation(
  repo: DeliveryRepository,
  clock: { now(): Date },
  contractItemId: string,
  inspectionRequestId: string,
): Promise<InspectionRequestEntity> {
  const inspections = await repo.listInspectionRequestsByItem(contractItemId);
  const target = await repo.getInspectionRequest(inspectionRequestId);
  if (!target) throw new DeliveryHttpError(404, "보완 요청을 찾을 수 없습니다.");

  if (inspections.length >= 3 && target.status !== "ESCALATED") {
    return repo.updateInspectionRequest(target.id, {
      status: "ESCALATED",
      escalatedAt: clock.now(),
      escalation: {
        requestedBy: "SYSTEM",
        reason: "동일 항목 보완 요청 3회 누적에 따른 자동 이견 개입",
      },
    });
  }

  return target;
}

export interface InspectionSummaryItem {
  contractItemId: string;
  title: string;
  stage: "INTERIM" | "FINAL";
  approved: boolean;
  autoApproved: boolean;
  latestDeliveryStatus: string | null;
  openInspectionCount: number;
  escalatedCount: number;
}

export interface InspectionSummary {
  contractId: string;
  totalItems: number;
  approvedItems: number;
  pendingItems: number;
  openInspectionItems: number;
  escalatedItems: number;
  installments: Array<{
    installmentId: string;
    stage: "INTERIM" | "FINAL";
    status: string;
    items: InspectionSummaryItem[];
  }>;
}

export class DeliveryService {
  private readonly repo: DeliveryRepository;
  private readonly clock: { now(): Date };
  private readonly settlementPort?: SettlementApprovalPort;
  private readonly opsPorts?: InspectionOpsPorts;

  constructor(options: DeliveryServiceOptions) {
    this.repo = options.repo;
    this.clock = options.clock ?? { now: () => new Date() };
    this.settlementPort = options.settlementPort;
    this.opsPorts = options.opsPorts;
  }

  private async announceEscalation(contractId: string, targetId: string, reason: string): Promise<void> {
    await this.opsPorts?.createSystemMessage?.({
      contractId,
      targetId,
      type: "DISPUTE_ESCALATED",
      body: `운영자 검토로 넘어갑니다: ${reason}`,
    });
    await this.opsPorts?.recordEvent?.({
      actionType: "DISPUTE_ESCALATED",
      targetType: "INSPECTION",
      targetId,
      reason,
    });
  }

  private async assertParty(
    actor: { userId: string; role: string },
    contract: DeliveryContractInfo,
  ): Promise<void> {
    const isParty =
      (actor.role === "CLIENT" && actor.userId === contract.clientUserId) ||
      (actor.role === "SUPPLIER" && actor.userId === contract.supplierUserId);
    if (!isParty) throw new DeliveryHttpError(403, "계약 당사자만 조회할 수 있습니다.");
  }

  private assertContractActive(contract: DeliveryContractInfo, action: string): void {
    if (contract.status !== "ACTIVE") {
      throw new DeliveryHttpError(409, `진행 중(ACTIVE) 계약만 ${action} 수 있습니다.`);
    }
  }

  async listDeliveries(
    actor: { userId: string; role: string },
    installmentId: string,
  ): Promise<DeliveryEntity[]> {
    const installment = await this.repo.getInstallment(installmentId);
    if (!installment) throw new DeliveryHttpError(404, "구간을 찾을 수 없습니다.");
    const contract = await this.repo.getContract(installment.contractId);
    if (!contract) throw new DeliveryHttpError(404, "계약을 찾을 수 없습니다.");
    await this.assertParty(actor, contract);
    return this.repo.listDeliveries(installmentId);
  }

  async getDelivery(actor: { userId: string; role: string }, deliveryId: string): Promise<DeliveryEntity> {
    const delivery = await this.repo.getDelivery(deliveryId);
    if (!delivery) throw new DeliveryHttpError(404, "납품을 찾을 수 없습니다.");
    const installment = await this.repo.getInstallment(delivery.installmentId);
    if (!installment) throw new DeliveryHttpError(404, "구간을 찾을 수 없습니다.");
    const contract = await this.repo.getContract(installment.contractId);
    if (!contract) throw new DeliveryHttpError(404, "계약을 찾을 수 없습니다.");
    await this.assertParty(actor, contract);
    return delivery;
  }

  /** `GET /contracts/{id}/inspection-summary`: 계약 단위 검수 진행 요약. */
  async getInspectionSummary(
    actor: { userId: string; role: string },
    contractId: string,
  ): Promise<InspectionSummary> {
    const contract = await this.repo.getContract(contractId);
    if (!contract) throw new DeliveryHttpError(404, "계약을 찾을 수 없습니다.");
    await this.assertParty(actor, contract);

    const installments = await this.repo.listInstallments(contractId);
    const summaryInstallments: InspectionSummary["installments"] = [];
    let totalItems = 0;
    let approvedItems = 0;
    let openInspectionItems = 0;
    let escalatedItems = 0;

    for (const installment of installments) {
      const items = (await this.repo.listContractItemsByContractId(contractId)).filter(
        (item) => item.stage === installment.stage,
      );
      const deliveries = await this.repo.listDeliveries(installment.id);
      const latest = deliveries[deliveries.length - 1];
      const summaryItems: InspectionSummaryItem[] = [];
      for (const item of items) {
        const inspections = await this.repo.listInspectionRequestsByItem(item.id);
        const open = inspections.filter((row) => row.status === "OPEN").length;
        const escalated = inspections.filter((row) => row.status === "ESCALATED").length;
        totalItems += 1;
        if (item.approvedAt !== null) approvedItems += 1;
        if (open > 0) openInspectionItems += 1;
        if (escalated > 0) escalatedItems += 1;
        summaryItems.push({
          contractItemId: item.id,
          title: item.title,
          stage: item.stage,
          approved: item.approvedAt !== null,
          autoApproved: item.autoApproved,
          latestDeliveryStatus: latest?.status ?? null,
          openInspectionCount: open,
          escalatedCount: escalated,
        });
      }
      summaryInstallments.push({
        installmentId: installment.id,
        stage: installment.stage,
        status: installment.status,
        items: summaryItems,
      });
    }

    return {
      contractId,
      totalItems,
      approvedItems,
      pendingItems: totalItems - approvedItems,
      openInspectionItems,
      escalatedItems,
      installments: summaryInstallments,
    };
  }

  async listReworkRequests(
    actor: { userId: string; role: string },
    contractItemId: string,
  ): Promise<InspectionRequestEntity[]> {
    const item = await this.repo.getContractItem(contractItemId);
    if (!item) throw new DeliveryHttpError(404, "계약 항목을 찾을 수 없습니다.");
    const contract = await this.repo.getContract(item.contractId);
    if (!contract) throw new DeliveryHttpError(404, "계약을 찾을 수 없습니다.");
    await this.assertParty(actor, contract);
    return this.repo.listInspectionRequestsByItem(contractItemId);
  }

  async submitDelivery(
    actor: { userId: string; role: string },
    input: { installmentId: string; items: DeliveryItemPayload[]; summary?: string },
  ): Promise<DeliveryEntity> {
    const installment = await this.repo.getInstallment(input.installmentId);
    if (!installment) throw new DeliveryHttpError(404, "구간을 찾을 수 없습니다.");

    const contract = await this.repo.getContract(installment.contractId);
    if (!contract) throw new DeliveryHttpError(404, "계약을 찾을 수 없습니다.");

    if (actor.role !== "SUPPLIER" || actor.userId !== contract.supplierUserId) {
      throw new DeliveryHttpError(403, "공급자만 납품을 제출할 수 있습니다.");
    }

    if (
      contract.status !== "ACTIVE" ||
      (contract.paymentStatus !== "DEPOSITED" && contract.paymentStatus !== "PARTIALLY_RELEASED")
    ) {
      throw new DeliveryHttpError(409, "예치 완료된 계약만 납품할 수 있습니다.");
    }

    // 구간 상태 전이: PENDING/REWORK_REQUESTED -> DELIVERED
    if (installment.status !== "PENDING" && installment.status !== "REWORK_REQUESTED") {
      throw new DeliveryHttpError(409, "납품 가능한 구간 상태가 아닙니다.");
    }

    if (!input.items || input.items.length === 0) {
      throw new DeliveryHttpError(400, "납품 항목이 최소 1개 이상 필요합니다.");
    }

    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    for (const item of input.items) {
      for (const file of item.files) {
        if (file.size > MAX_FILE_SIZE) {
          throw new DeliveryHttpError(400, `파일 크기가 50MB를 초과합니다: ${file.name}`);
        }
      }
    }

    const contractItems = await this.repo.listContractItemsByContractId(contract.id);
    const contractItemMap = new Map(contractItems.map((i) => [i.id, i]));

    for (const item of input.items) {
      const found = contractItemMap.get(item.contractItemId);
      if (!found || found.stage !== installment.stage) {
        throw new DeliveryHttpError(400, `해당 구간의 계약 항목이 아닙니다: ${item.contractItemId}`);
      }
    }

    const previousDeliveries = await this.repo.listDeliveries(installment.id);
    const attemptNo = previousDeliveries.length + 1;

    if (attemptNo > 1) {
      for (const item of input.items) {
        const cItem = contractItemMap.get(item.contractItemId);
        if (cItem?.approvedAt) {
          throw new DeliveryHttpError(400, "보완 요청된 미승인 항목만 재제출할 수 있습니다.");
        }
        const inspections = await this.repo.listInspectionRequestsByItem(item.contractItemId);
        const hasReworkRequest = inspections.some((i) => i.status === "OPEN");
        if (!hasReworkRequest) {
          throw new DeliveryHttpError(400, "보완 요청된 미승인 항목만 재제출할 수 있습니다.");
        }
      }
    }

    const submittedAt = this.clock.now();
    const inspectionDueAt = endOfKstDayPlus(submittedAt, 7);

    const created = await this.repo.createDelivery({
      installmentId: installment.id,
      attemptNo,
      items: input.items,
      summary: input.summary ?? null,
      status: "SUBMITTED",
      submittedAt,
      inspectionDueAt,
      reviewedAt: null,
    });

    await this.repo.updateInstallment(installment.id, { status: "DELIVERED" });

    // 재납품한 항목의 이전 OPEN 보완 요청은 해소되어 자동 승인을 영구 차단하지 않는다.
    if (attemptNo > 1) {
      for (const item of input.items) {
        const inspections = await this.repo.listInspectionRequestsByItem(item.contractItemId);
        for (const insp of inspections) {
          if (insp.status === "OPEN") {
            await this.repo.updateInspectionRequest(insp.id, {
              status: "RESOLVED",
              resolvedAt: submittedAt,
            });
          }
        }
      }
    }

    return created;
  }

  async approveItem(
    actor: { userId: string; role: string },
    input: { contractItemId: string; deliveryId: string },
  ): Promise<ContractItemEntity> {
    const item = await this.repo.getContractItem(input.contractItemId);
    if (!item) throw new DeliveryHttpError(404, "계약 항목을 찾을 수 없습니다.");

    const contract = await this.repo.getContract(item.contractId);
    if (!contract) throw new DeliveryHttpError(404, "계약을 찾을 수 없습니다.");

    this.assertContractActive(contract, "항목을 승인할");

    if (actor.role !== "CLIENT" || actor.userId !== contract.clientUserId) {
      throw new DeliveryHttpError(403, "의뢰인만 항목을 승인할 수 있습니다.");
    }

    const delivery = await this.repo.getDelivery(input.deliveryId);
    if (!delivery || delivery.items.some((row) => row.contractItemId === item.id) === false) {
      throw new DeliveryHttpError(404, "해당 납품의 항목이 아닙니다.");
    }

    if (item.approvedAt) {
      return item;
    }

    // 마지막 항목이면 구간 승인 조건을 먼저 확인한다. 항목 승인 뒤에 실패하면 부분 쓰기가 남는다.
    const stageItemsBefore = (await this.repo.listContractItemsByContractId(contract.id)).filter(
      (i) => i.stage === item.stage,
    );
    const wouldBeAllApproved = stageItemsBefore.every(
      (i) => i.id === item.id || i.approvedAt !== null,
    );
    if (wouldBeAllApproved) {
      await this.settlementPort?.assertApprovable?.({
        contractId: contract.id,
        installmentId: delivery.installmentId,
        assumingApprovedItemId: item.id,
      });
    }

    const updated = await this.repo.updateContractItem(item.id, {
      approvedAt: this.clock.now(),
      autoApproved: false,
    });

    const inspections = await this.repo.listInspectionRequestsByItem(item.id);
    for (const insp of inspections) {
      if (insp.status === "OPEN") {
        await this.repo.updateInspectionRequest(insp.id, {
          status: "RESOLVED",
          resolvedAt: this.clock.now(),
        });
      }
    }

    const itemsInStage = (await this.repo.listContractItemsByContractId(contract.id)).filter(
      (i) => i.stage === item.stage,
    );
    const allApproved = itemsInStage.every((i) => i.id === item.id || i.approvedAt !== null);
    await this.repo.updateDelivery(delivery.id, {
      status: allApproved ? "APPROVED" : "PARTIALLY_APPROVED",
      reviewedAt: this.clock.now(),
    });
    if (allApproved && this.settlementPort) {
      await this.settlementPort.approveInstallment({
        contractId: contract.id,
        installmentId: delivery.installmentId,
      });
    }

    return updated;
  }

  async requestRework(
    actor: { userId: string; role: string },
    input: {
      deliveryId: string;
      contractItemId: string;
      reason: InspectionReason;
      conditionKey?: string;
      note?: string;
    },
  ): Promise<InspectionRequestEntity> {
    const item = await this.repo.getContractItem(input.contractItemId);
    if (!item) throw new DeliveryHttpError(404, "계약 항목을 찾을 수 없습니다.");

    const contract = await this.repo.getContract(item.contractId);
    if (!contract) throw new DeliveryHttpError(404, "계약을 찾을 수 없습니다.");

    if (actor.role !== "CLIENT" || actor.userId !== contract.clientUserId) {
      throw new DeliveryHttpError(403, "의뢰인만 보완을 요청할 수 있습니다.");
    }

    this.assertContractActive(contract, "보완을 요청할");

    if (!INSPECTION_REASONS.includes(input.reason)) {
      throw new DeliveryHttpError(400, "보완 사유는 CONDITION_MISMATCH|NOT_WORKING|MISSING_PART|OTHER 중 하나여야 합니다.");
    }
    if (!input.note || input.note.trim().length === 0) {
      throw new DeliveryHttpError(400, "보완 사유 설명은 필수입니다.");
    }

    if (item.approvedAt) {
      throw new DeliveryHttpError(409, "이미 승인된 항목은 보완 요청할 수 없습니다.");
    }

    const delivery = await this.repo.getDelivery(input.deliveryId);
    if (!delivery) throw new DeliveryHttpError(404, "납품을 찾을 수 없습니다.");
    if (!delivery.items.some((row) => row.contractItemId === item.id)) {
      throw new DeliveryHttpError(404, "해당 납품의 항목이 아닙니다.");
    }

    if (input.reason === "CONDITION_MISMATCH") {
      if (!input.conditionKey) {
        throw new DeliveryHttpError(400, "조건 불일치 사유는 어느 조건인지 지정해야 합니다.");
      }
      const condition = item.conditions.find((c) => c.key === input.conditionKey);
      if (!condition || condition.state !== "DECIDED") {
        throw new DeliveryHttpError(
          422,
          "DECIDED 조건만 상세 검수 기준입니다. PROPOSED 또는 UNDECIDED 조건은 계약서에 정하지 않음으로 남으며 보완 근거가 되지 않습니다.",
        );
      }
    } else if (input.conditionKey) {
      const condition = item.conditions.find((c) => c.key === input.conditionKey);
      if (!condition) {
        throw new DeliveryHttpError(422, "해당 계약 항목에 없는 조건 키입니다.");
      }
    }

    const created = await this.repo.createInspectionRequest({
      deliveryId: delivery.id,
      contractItemId: item.id,
      reason: input.reason,
      conditionKey: input.conditionKey ?? null,
      note: input.note ?? null,
      status: "OPEN",
      escalatedAt: null,
      resolvedAt: null,
      createdAt: this.clock.now(),
    });

    await this.repo.updateDelivery(delivery.id, {
      status: "REWORK_REQUESTED",
      reviewedAt: this.clock.now(),
    });
    await this.repo.updateInstallment(delivery.installmentId, { status: "REWORK_REQUESTED" });

    let result = created;
    const inspections = await this.repo.listInspectionRequestsByItem(item.id);
    if (inspections.length >= 3) {
      result = await applyAutoEscalation(this.repo, this.clock, item.id, created.id);
      if (result.status === "ESCALATED") {
        await this.announceEscalation(contract.id, result.id, "동일 항목 보완 요청 3회 누적");
      }
    }

    return result;
  }

  async escalateInspection(
    actor: { userId: string; role: string },
    inspectionRequestId: string,
    input: {
      reason: string;
      what: string;
      claims?: { client: string; supplier: string };
      evidence?: unknown;
    },
  ): Promise<InspectionRequestEntity> {
    const inspection = await this.repo.getInspectionRequest(inspectionRequestId);
    if (!inspection) throw new DeliveryHttpError(404, "보완 요청을 찾을 수 없습니다.");

    const delivery = await this.repo.getDelivery(inspection.deliveryId);
    if (!delivery) throw new DeliveryHttpError(404, "납품을 찾을 수 없습니다.");
    const installment = await this.repo.getInstallment(delivery.installmentId);
    if (!installment) throw new DeliveryHttpError(404, "구간을 찾을 수 없습니다.");
    const contract = await this.repo.getContract(installment.contractId);
    if (!contract) throw new DeliveryHttpError(404, "계약을 찾을 수 없습니다.");

    await this.assertParty(actor, contract);
    if (!input.reason || input.reason.trim().length === 0) {
      throw new DeliveryHttpError(400, "도움 요청 사유는 필수입니다.");
    }
    if (!input.what || input.what.trim().length === 0) {
      throw new DeliveryHttpError(400, "도움 요청 내용은 필수입니다.");
    }
    if (inspection.status === "ESCALATED") return inspection;
    if (inspection.status !== "OPEN") {
      throw new DeliveryHttpError(409, "진행 중(OPEN) 보완 요청만 이견 개입할 수 있습니다.");
    }

    const updated = await this.repo.updateInspectionRequest(inspection.id, {
      status: "ESCALATED",
      escalatedAt: this.clock.now(),
      escalation: {
        requestedBy: actor.userId,
        reason: input.reason,
        what: input.what,
        claims: input.claims ?? null,
        evidence: input.evidence ?? null,
      },
    });
    await this.announceEscalation(contract.id, updated.id, input.reason);
    return updated;
  }
}

export interface InspectionBatchOptions {
  repo: DeliveryRepository;
  notificationPorts: NotificationPorts;
  clock?: { now(): Date };
  settlementPort?: SettlementApprovalPort;
  opsPorts?: InspectionOpsPorts;
  /** 기한 알림 묶음을 계약 단위 트랜잭션으로 실행한다. */
  transactionRunner?: { run<T>(work: (tx: unknown) => Promise<T>): Promise<T> };
}

export class InspectionBatchService {
  private readonly repo: DeliveryRepository;
  private readonly notificationPorts: NotificationPorts;
  private readonly clock: { now(): Date };
  private readonly settlementPort?: SettlementApprovalPort;
  private readonly opsPorts?: InspectionOpsPorts;
  private readonly transactionRunner?: InspectionBatchOptions["transactionRunner"];

  constructor(options: InspectionBatchOptions) {
    this.repo = options.repo;
    this.notificationPorts = options.notificationPorts;
    this.clock = options.clock ?? { now: () => new Date() };
    this.settlementPort = options.settlementPort;
    this.opsPorts = options.opsPorts;
    this.transactionRunner = options.transactionRunner;
  }

  private async announceDecision(
    contractId: string,
    targetId: string,
    decisionLabel: string,
    reason: string,
  ): Promise<void> {
    await this.opsPorts?.createSystemMessage?.({
      contractId,
      targetId,
      type: "DISPUTE_DECIDED",
      body: `운영자 판정(${decisionLabel}): ${reason}`,
    });
    await this.opsPorts?.recordEvent?.({
      actionType: "DISPUTE_DECIDED",
      targetType: "INSPECTION",
      targetId,
      reason,
      payload: { decision: decisionLabel },
    });
  }

  /**
   * D-39: 검수 기한(7일) 경과는 자동 승인·자동 지급이 아니다.
   *
   * 기한 안내는 `sendDueNotifications`가 담당하고, 실제 승인·지급은 의뢰인의
   * 명시적 항목 승인 또는 운영자 판정으로만 진행한다. 기존 배치 인터페이스는
   * 호출부·job target과의 호환을 위해 유지하되 아무 상태도 바꾸지 않는다.
   */
  async processAutoApproval(_deliveryId: string, _now: Date): Promise<{ autoApprovedCount: number }> {
    return { autoApprovedCount: 0 };
  }

  async checkAndEscalateItem(
    contractItemId: string,
    inspectionRequestId: string,
  ): Promise<InspectionRequestEntity> {
    return applyAutoEscalation(this.repo, this.clock, contractItemId, inspectionRequestId);
  }

  async decideDispute(input: {
    inspectionRequestId: string;
    decision: DisputeDecision;
    reason: string;
    decisionNotes: { client: string; supplier: string };
  }): Promise<InspectionRequestEntity> {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new DeliveryHttpError(400, "운영자 판정 사유는 필수입니다.");
    }
    if (!input.decisionNotes?.client?.trim() || !input.decisionNotes?.supplier?.trim()) {
      throw new DeliveryHttpError(400, "의뢰인·공급자에게 보일 판정 문구가 모두 필요합니다.");
    }

    const inspReq = await this.repo.getInspectionRequest(input.inspectionRequestId);
    if (!inspReq) throw new DeliveryHttpError(404, "보완 요청을 찾을 수 없습니다.");
    if (inspReq.status !== "ESCALATED") {
      throw new DeliveryHttpError(409, "운영자 이견 개입(ESCALATED) 상태만 판정할 수 있습니다.");
    }

    const delivery = await this.repo.getDelivery(inspReq.deliveryId);
    if (!delivery) throw new DeliveryHttpError(404, "납품을 찾을 수 없습니다.");
    const installment = await this.repo.getInstallment(delivery.installmentId);
    if (!installment) throw new DeliveryHttpError(404, "구간을 찾을 수 없습니다.");
    const contract = await this.repo.getContract(installment.contractId);
    if (!contract) throw new DeliveryHttpError(404, "계약을 찾을 수 없습니다.");

    const now = this.clock.now();
    const decisionLabel: Record<DisputeDecision, string> = {
      REWORK_VALID: "보완",
      APPROVE: "승인",
      UNDECIDED_CONDITION: "정하지 않은 조건",
    };

    if (input.decision === "REWORK_VALID") {
      const updated = await this.repo.updateInspectionRequest(inspReq.id, {
        status: "OPEN",
        decision: "REWORK_VALID",
        decisionNotes: input.decisionNotes,
        resolvedAt: null,
      });
      await this.repo.updateDelivery(delivery.id, { status: "REWORK_REQUESTED" });
      await this.repo.updateInstallment(installment.id, { status: "REWORK_REQUESTED" });
      await this.announceDecision(contract.id, inspReq.id, decisionLabel.REWORK_VALID, input.reason);
      return updated;
    }

    await this.repo.updateContractItem(inspReq.contractItemId, {
      approvedAt: now,
      autoApproved: false,
    });
    const updated = await this.repo.updateInspectionRequest(inspReq.id, {
      status: "RESOLVED",
      decision: input.decision,
      decisionNotes: input.decisionNotes,
      resolvedAt: now,
    });

    const itemsInStage = (await this.repo.listContractItemsByContractId(contract.id)).filter(
      (i) => i.stage === installment.stage,
    );
    if (itemsInStage.every((i) => i.approvedAt !== null)) {
      await this.repo.updateDelivery(delivery.id, { status: "APPROVED", reviewedAt: now });
      await this.settlementPort?.approveInstallment({
        contractId: contract.id,
        installmentId: installment.id,
      });
    } else {
      await this.repo.updateDelivery(delivery.id, { status: "PARTIALLY_APPROVED", reviewedAt: now });
    }

    await this.announceDecision(contract.id, inspReq.id, decisionLabel[input.decision], input.reason);
    return updated;
  }

  async sendDueNotifications(contractId: string, now: Date): Promise<void> {
    if (this.transactionRunner === undefined) {
      return this.sendDueNotificationsInTransaction(contractId, now);
    }
    // 계약 단위 트랜잭션: 알림 하나가 실패하면 같은 계약의 기한 알림이 모두 롤백된다.
    return this.transactionRunner.run((tx) => this.sendDueNotificationsInTransaction(contractId, now, tx));
  }

  private async sendDueNotificationsInTransaction(contractId: string, now: Date, tx?: unknown): Promise<void> {
    const contract = await this.repo.getContract(contractId);
    if (!contract || contract.status !== "ACTIVE") return;

    const oneDayMs = 24 * 60 * 60 * 1000;
    const installments = await this.repo.listInstallments(contract.id);

    // 예치 완료 뒤에는 예치 기한 안내를 보내지 않는다.
    if (contract.paymentStatus === "PENDING" && contract.depositDeadline) {
      const diffMs = contract.depositDeadline.getTime() - now.getTime();
      if (diffMs > 0 && diffMs <= oneDayMs) {
        await this.notificationPorts.createOnce({
          userId: contract.clientUserId,
          type: "DEPOSIT_DUE",
          targetId: contract.id,
          dueAt: contract.depositDeadline,
        }, tx);
      }
    }

    // 검수 기한 하루 전: 각 구간의 가장 최근 납품 기준, 미승인 항목이 남아 있을 때만.
    for (const installment of installments) {
      if (["APPROVED", "RELEASED", "REFUNDED"].includes(installment.status)) continue;
      const deliveries = await this.repo.listDeliveries(installment.id);
      const latest = deliveries[deliveries.length - 1];
      if (!latest) continue;

      const diffMs = latest.inspectionDueAt.getTime() - now.getTime();
      if (diffMs <= 0 || diffMs > oneDayMs) continue;

      let pendingItem = false;
      for (const row of latest.items) {
        const item = await this.repo.getContractItem(row.contractItemId);
        if (!item || item.approvedAt === null) {
          pendingItem = true;
          break;
        }
      }
      if (!pendingItem) continue;

      await this.notificationPorts.createOnce({
        userId: contract.clientUserId,
        type: "INSPECTION_DUE",
        targetId: latest.id,
        dueAt: latest.inspectionDueAt,
      }, tx);
    }

    const finalInstallment = installments.find((i) => i.stage === "FINAL");
    const finalStageStatus = finalInstallment?.status ?? "PENDING";
    const finalDone = ["DELIVERED", "APPROVED", "RELEASED", "REFUNDED"].includes(finalStageStatus);
    if (contract.workDueAt) {
      const diffMs = contract.workDueAt.getTime() - now.getTime();
      if (diffMs > 0 && diffMs <= oneDayMs) {
        if (!finalDone) {
          await this.notificationPorts.createOnce({
            userId: contract.supplierUserId,
            type: "WORK_DUE",
            targetId: contract.id,
            dueAt: contract.workDueAt,
          }, tx);
        }
      } else if (
        this.isWorkOverdue({
          workDueAt: contract.workDueAt,
          finalStageStatus,
          now,
        })
      ) {
        await this.notificationPorts.createOnce({
          userId: contract.clientUserId,
          type: "WORK_OVERDUE",
          targetId: contract.id,
          dueAt: contract.workDueAt,
        }, tx);
        await this.notificationPorts.createOnce({
          userId: contract.supplierUserId,
          type: "WORK_OVERDUE",
          targetId: contract.id,
          dueAt: contract.workDueAt,
        }, tx);
      }
    }
  }

  isWorkOverdue(input: { workDueAt: Date; finalStageStatus: string; now: Date }): boolean {
    if (["DELIVERED", "APPROVED", "RELEASED", "REFUNDED"].includes(input.finalStageStatus)) {
      return false;
    }
    return input.now.getTime() > input.workDueAt.getTime();
  }
}
