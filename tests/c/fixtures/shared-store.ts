import type { DepositContractInfo, DepositRepository } from "../../../src/modules/deposit/index.ts";
import type {
  DeliveryRepository,
  ContractItemEntity,
  ConditionLine,
} from "../../../src/modules/delivery/index.ts";
import type {
  SettlementRepository,
  SupplierKind,
} from "../../../src/modules/settlement/policy.ts";
import type { CancellationRepository } from "../../../src/modules/cancellation/index.ts";
import type { ReviewRepository } from "../../../src/modules/review/index.ts";
import type {
  AdminRepository,
  AdminBlock,
  AdminHeldDeposit,
  AdminEscalatedInspection,
  AdminEscalatedInspectionDetail,
  AdminCancellationContract,
  EventLogEntity,
} from "../../../src/modules/admin-ops/index.ts";

export interface SharedContractSeed {
  id: string;
  clientUserId: string;
  supplierUserId: string;
  status?: string;
  paymentStatus?: string;
  agreedAmount: number;
  clientFee: number;
  interimRatio?: number;
  durationDays?: number;
  projectId?: string;
  applicationId?: string;
  depositDeadline?: Date;
  workDueAt?: Date | null;
  depositedAt?: Date | null;
  supplierKind?: SupplierKind;
  payoutVerifiedAt?: Date | null;
  payoutAccountNo?: string;
  completedAt?: Date | null;
}

interface ContractRecord extends SharedContractSeed {
  status: string;
  paymentStatus: string;
  totalDeposited: number;
  interimRatio: number;
  durationDays: number;
  depositDeadline: Date;
  workDueAt: Date | null;
  depositedAt: Date | null;
  supplierKind: SupplierKind;
  payoutVerifiedAt: Date | null;
  completedAt: Date | null;
  cancelCause: string | null;
  cancelRequestedBy: string | null;
  cancelRequestedAt: Date | null;
  cancelNote: string | null;
  objectionNote: string | null;
  objectionRate: number | null;
  cancelEvidence: unknown | null;
  cancelEscalatedAt: Date | null;
  compensationRate: number | null;
  cancelResolution: string | null;
  cancelResolvedAt: Date | null;
  refundAmount: number | null;
  clientFeeRefund: number | null;
  settledAmount: number | null;
  refundReason: string | null;
  refundedAt: Date | null;
  cancelPayoutAt: Date | null;
}

interface InstallmentRecord {
  id: string;
  contractId: string;
  stage: "INTERIM" | "FINAL";
  ratio: number;
  amount: number;
  supplierFee: number;
  withholdingTax: number;
  releaseAmount: number;
  status: string;
  approvedAt: Date | null;
  releasedAt: Date | null;
  taxInvoiceIssuedAt: Date | null;
  holdReason: string | null;
}

interface DeliveryRecord {
  id: string;
  installmentId: string;
  attemptNo: number;
  items: Array<{ contractItemId: string; links: string[]; files: unknown[]; howToCheck: string }>;
  summary: string | null;
  status: string;
  submittedAt: Date;
  inspectionDueAt: Date;
  reviewedAt: Date | null;
}

interface InspectionRecord {
  id: string;
  deliveryId: string;
  contractItemId: string;
  reason: string;
  conditionKey: string | null;
  note: string | null;
  status: string;
  escalatedAt: Date | null;
  escalation?: unknown;
  decision?: string | null;
  decisionNotes?: { client: string; supplier: string } | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

interface DepositRecord {
  id: string;
  contractId: string;
  principal: number;
  clientFee: number;
  amount: number;
  method: string | null;
  status: string;
  idempotencyKey: string;
  pgKey: string | null;
  heldReason?: string | null;
  depositedAt: Date | null;
  createdAt: Date;
}

interface PaymentEventRecord {
  id: string;
  depositId: string;
  eventType: string;
  dedupKey: string | null;
  payload: unknown;
  resultNote: string | null;
  occurredAt: Date;
}

interface ReviewRecord {
  id: string;
  contractId: string;
  reviewerId: string;
  revieweeId: string;
  rating: number;
  comment: string | null;
  tags: string[];
  createdAt: Date;
}

export function createSharedStore(seed: SharedContractSeed) {
  let idCounter = 1;
  const nextId = (prefix: string) => `${prefix}-${idCounter++}`;

  const contracts = new Map<string, ContractRecord>();
  const contract = {
    status: "ACTIVE",
    paymentStatus: "PENDING",
    interimRatio: 50,
    durationDays: 42,
    totalDeposited: 0,
    depositDeadline: new Date("2099-01-01T14:59:59.999Z"),
    workDueAt: null,
    depositedAt: null,
    supplierKind: "INDIVIDUAL" as SupplierKind,
    payoutVerifiedAt: null,
    completedAt: null,
    cancelCause: null,
    cancelRequestedBy: null,
    cancelRequestedAt: null,
    cancelNote: null,
    objectionNote: null,
    objectionRate: null,
    cancelEvidence: null,
    cancelEscalatedAt: null,
    compensationRate: null,
    cancelResolution: null,
    cancelResolvedAt: null,
    refundAmount: null,
    clientFeeRefund: null,
    settledAmount: null,
    refundReason: null,
    refundedAt: null,
    cancelPayoutAt: null,
    ...seed,
  } as ContractRecord;
  contracts.set(contract.id, contract);

  const installments = new Map<string, InstallmentRecord>();
  const items = new Map<string, ContractItemEntity>();
  const deliveries = new Map<string, DeliveryRecord>();
  const inspections = new Map<string, InspectionRecord>();
  const deposits = new Map<string, DepositRecord>();
  const paymentEvents = new Map<string, PaymentEventRecord>();
  const reviews = new Map<string, ReviewRecord>();
  const eventLogs: EventLogEntity[] = [];
  const blocks = new Map<string, AdminBlock>();
  const heldDeposits = new Map<string, AdminHeldDeposit>();
  const adminInspections = new Map<string, AdminEscalatedInspectionDetail>();
  const cancellationQueue = new Map<string, AdminCancellationContract>();

  const getContract = async (id: string) => contracts.get(id) ?? null;
  const updateContract = async (id: string, patch: Partial<ContractRecord>) => {
    const existing = contracts.get(id);
    if (!existing) throw new Error(`contract not found: ${id}`);
    const updated = { ...existing, ...patch };
    contracts.set(id, updated);
    return updated;
  };

  const updateInstallment = async (id: string, patch: Partial<InstallmentRecord>) => {
    const existing = installments.get(id);
    if (!existing) throw new Error(`installment not found: ${id}`);
    const updated = { ...existing, ...patch };
    installments.set(id, updated);
    return updated;
  };

  function toDepositContract(record: ContractRecord): DepositContractInfo {
    return {
      id: record.id,
      projectId: record.projectId,
      applicationId: record.applicationId,
      clientUserId: record.clientUserId,
      supplierUserId: record.supplierUserId,
      status: record.status as DepositContractInfo["status"],
      paymentStatus: record.paymentStatus as DepositContractInfo["paymentStatus"],
      agreedAmount: record.agreedAmount,
      clientFee: record.clientFee,
      interimRatio: record.interimRatio,
      durationDays: record.durationDays,
      depositDeadline: record.depositDeadline,
      totalDeposited: record.totalDeposited,
      workDueAt: record.workDueAt,
    };
  }

  const depositRepository: DepositRepository = {
    async createDeposit(data) {
      const record: DepositRecord = { ...data, id: nextId("dep"), createdAt: new Date() };
      deposits.set(record.id, record);
      return record as never;
    },
    async findByIdempotencyKey(key) {
      for (const row of deposits.values()) if (row.idempotencyKey === key) return row as never;
      return null;
    },
    async findById(id) {
      return (deposits.get(id) ?? null) as never;
    },
    async findByContractId(contractId) {
      return Array.from(deposits.values()).filter((row) => row.contractId === contractId) as never;
    },
    async updateDeposit(id, patch) {
      const existing = deposits.get(id);
      if (!existing) throw new Error(`deposit not found: ${id}`);
      const updated = { ...existing, ...patch };
      deposits.set(id, updated);
      return updated as never;
    },
    async createPaymentEvent(data) {
      const record: PaymentEventRecord = { ...data, id: nextId("pe"), occurredAt: new Date() };
      paymentEvents.set(record.id, record);
      return record as never;
    },
    async findPaymentEventByDedupKey(depositId, dedupKey) {
      for (const row of paymentEvents.values()) {
        if (row.depositId === depositId && row.dedupKey === dedupKey) return row as never;
      }
      return null;
    },
    async listPaymentEvents(depositId) {
      return Array.from(paymentEvents.values()).filter((row) => row.depositId === depositId) as never;
    },
    async createInstallments(rows) {
      const created: InstallmentRecord[] = [];
      for (const row of rows) {
        let existing: InstallmentRecord | undefined;
        for (const value of installments.values()) {
          if (value.contractId === row.contractId && value.stage === row.stage) existing = value;
        }
        if (existing) {
          created.push(existing);
          continue;
        }
        const record: InstallmentRecord = {
          id: nextId("inst"),
          contractId: row.contractId,
          stage: row.stage,
          ratio: row.ratio,
          amount: row.amount,
          supplierFee: row.supplierFee,
          withholdingTax: row.withholdingTax,
          releaseAmount: row.releaseAmount,
          status: row.status,
          approvedAt: row.approvedAt,
          releasedAt: row.releasedAt,
          taxInvoiceIssuedAt: row.taxInvoiceIssuedAt,
          holdReason: null,
        };
        installments.set(record.id, record);
        created.push(record);
      }
      return created as never;
    },
    async listInstallments(contractId) {
      return Array.from(installments.values()).filter((row) => row.contractId === contractId) as never;
    },
    async deleteInstallments(contractId) {
      for (const [id, row] of installments.entries()) {
        if (row.contractId === contractId) installments.delete(id);
      }
    },
  };

  const deliveryRepository: DeliveryRepository = {
    seedContract(seedContract) {
      const existing = contracts.get(seedContract.id);
      contracts.set(seedContract.id, {
        ...(existing ?? contract),
        ...seedContract,
      } as ContractRecord);
    },
    seedInstallment(row) {
      installments.set(row.id, {
        id: row.id,
        contractId: row.contractId,
        stage: row.stage,
        ratio: 50,
        amount: 0,
        supplierFee: 0,
        withholdingTax: 0,
        releaseAmount: 0,
        status: row.status,
        approvedAt: null,
        releasedAt: null,
        taxInvoiceIssuedAt: null,
        holdReason: null,
      });
    },
    seedContractItems(rows) {
      for (const row of rows) items.set(row.id, { ...row });
    },
    async getContract(id) {
      const record = contracts.get(id);
      if (!record) return null;
      return {
        id: record.id,
        clientUserId: record.clientUserId,
        supplierUserId: record.supplierUserId,
        status: record.status,
        paymentStatus: record.paymentStatus,
        depositDeadline: record.depositDeadline,
        workDueAt: record.workDueAt ?? undefined,
      };
    },
    async getInstallment(id) {
      const row = installments.get(id);
      if (!row) return null;
      return { id: row.id, contractId: row.contractId, stage: row.stage, status: row.status };
    },
    async updateInstallment(id, patch) {
      await updateInstallment(id, patch);
      return (await this.getInstallment(id))!;
    },
    async getContractItem(id) {
      return items.get(id) ?? null;
    },
    async listContractItemsByContractId(contractId) {
      return Array.from(items.values()).filter((row) => row.contractId === contractId);
    },
    async updateContractItem(id, patch) {
      const existing = items.get(id);
      if (!existing) throw new Error(`item not found: ${id}`);
      const updated = { ...existing, ...patch };
      items.set(id, updated);
      return updated;
    },
    async createDelivery(data) {
      const record: DeliveryRecord = { ...data, id: nextId("del") };
      deliveries.set(record.id, record);
      return record as never;
    },
    async getDelivery(id) {
      return (deliveries.get(id) ?? null) as never;
    },
    async listDeliveries(installmentId) {
      return Array.from(deliveries.values())
        .filter((row) => row.installmentId === installmentId)
        .sort((a, b) => a.attemptNo - b.attemptNo) as never;
    },
    async updateDelivery(id, patch) {
      const existing = deliveries.get(id);
      if (!existing) throw new Error(`delivery not found: ${id}`);
      const updated = { ...existing, ...patch };
      deliveries.set(id, updated);
      return updated as never;
    },
    async createInspectionRequest(data) {
      const record: InspectionRecord = {
        ...data,
        id: nextId("insp"),
        note: data.note ?? null,
        resolvedAt: data.resolvedAt ?? null,
      };
      inspections.set(record.id, record);
      return record as never;
    },
    async getInspectionRequest(id) {
      return (inspections.get(id) ?? null) as never;
    },
    async listInspectionRequestsByItem(contractItemId) {
      return Array.from(inspections.values()).filter((row) => row.contractItemId === contractItemId) as never;
    },
    async listInspectionRequestsByDelivery(deliveryId) {
      return Array.from(inspections.values()).filter((row) => row.deliveryId === deliveryId) as never;
    },
    async updateInspectionRequest(id, patch) {
      const existing = inspections.get(id);
      if (!existing) throw new Error(`inspection not found: ${id}`);
      const updated = { ...existing, ...patch };
      inspections.set(id, updated);
      return updated as never;
    },
    async listInstallments(contractId) {
      return Array.from(installments.values())
        .filter((row) => row.contractId === contractId)
        .map((row) => ({ id: row.id, contractId: row.contractId, stage: row.stage, status: row.status }));
    },
  };

  const settlementRepository: SettlementRepository = {
    seedContract(seedContract) {
      deliveryRepository.seedContract(seedContract as never);
    },
    seedInstallments(rows) {
      for (const row of rows) installments.set(row.id, { ...row, holdReason: row.holdReason ?? null });
    },
    seedContractItems(rows) {
      for (const row of rows) {
        items.set(row.id, {
          id: row.id,
          contractId: row.contractId,
          stage: row.stage,
          title: row.title,
          description: "",
          conditions: [] as ConditionLine[],
          approvedAt: row.approvedAt,
          autoApproved: false,
        });
      }
    },
    async getContract(id) {
      const record = contracts.get(id);
      if (!record) return null;
      return {
        id: record.id,
        clientUserId: record.clientUserId,
        supplierUserId: record.supplierUserId,
        status: record.status,
        paymentStatus: record.paymentStatus,
        agreedAmount: record.agreedAmount,
        clientFee: record.clientFee,
        totalDeposited: record.totalDeposited,
        interimRatio: record.interimRatio,
        supplierKind: record.supplierKind,
        payoutVerifiedAt: record.payoutVerifiedAt,
        payoutAccountNo: record.payoutAccountNo,
        completedAt: record.completedAt,
      };
    },
    async updateContract(id, patch) {
      await updateContract(id, patch as never);
      return (await this.getContract(id))!;
    },
    async listContractsForUser(userId) {
      return Array.from(contracts.values())
        .filter((row) => row.clientUserId === userId || row.supplierUserId === userId)
        .map((row) => ({
          id: row.id,
          clientUserId: row.clientUserId,
          supplierUserId: row.supplierUserId,
          status: row.status,
          paymentStatus: row.paymentStatus,
          agreedAmount: row.agreedAmount,
          clientFee: row.clientFee,
          totalDeposited: row.totalDeposited,
          interimRatio: row.interimRatio,
          supplierKind: row.supplierKind,
          payoutVerifiedAt: row.payoutVerifiedAt,
        }));
    },
    async getInstallment(id) {
      return (installments.get(id) ?? null) as never;
    },
    async listInstallments(contractId) {
      return Array.from(installments.values()).filter((row) => row.contractId === contractId) as never;
    },
    async updateInstallment(id, patch) {
      const updated = await updateInstallment(id, patch as never);
      return updated as never;
    },
    async listContractItems(contractId) {
      return Array.from(items.values())
        .filter((row) => row.contractId === contractId)
        .map((row) => ({
          id: row.id,
          contractId: row.contractId,
          stage: row.stage,
          title: row.title,
          approvedAt: row.approvedAt,
        }));
    },
    async updateContractItem(id, patch) {
      const existing = items.get(id);
      if (!existing) throw new Error(`item not found: ${id}`);
      const updated = { ...existing, ...patch };
      items.set(id, updated);
      return {
        id: updated.id,
        contractId: updated.contractId,
        stage: updated.stage,
        title: updated.title,
        approvedAt: updated.approvedAt,
      };
    },
  };

  const cancellationRepository: CancellationRepository = {
    seedContract(seedContract) {
      const existing = contracts.get(seedContract.id);
      contracts.set(seedContract.id, { ...(existing ?? contract), ...seedContract } as ContractRecord);
    },
    seedInstallments(rows) {
      for (const row of rows) installments.set(row.id, { ...row } as InstallmentRecord);
    },
    async getContract(id) {
      const record = contracts.get(id);
      return (record ?? null) as never;
    },
    async updateContract(id, patch) {
      const updated = await updateContract(id, patch as never);
      return updated as never;
    },
    async listInstallments(contractId) {
      return Array.from(installments.values())
        .filter((row) => row.contractId === contractId)
        .map((row) => ({ id: row.id, contractId: row.contractId, stage: row.stage, amount: row.amount, status: row.status })) as never;
    },
    async updateInstallment(id, patch) {
      const updated = await updateInstallment(id, patch as never);
      return updated as never;
    },
  };

  const reviewRepository: ReviewRepository = {
    seedContract(seedContract) {
      const existing = contracts.get(seedContract.id);
      contracts.set(seedContract.id, { ...(existing ?? contract), ...seedContract } as ContractRecord);
    },
    async getContract(id) {
      const record = contracts.get(id);
      if (!record) return null;
      return {
        id: record.id,
        clientUserId: record.clientUserId,
        supplierUserId: record.supplierUserId,
        status: record.status,
      };
    },
    async createReview(data) {
      const record: ReviewRecord = { ...data, id: nextId("review") };
      reviews.set(record.id, record);
      return record as never;
    },
    async findReviewByContractAndReviewer(contractId, reviewerId) {
      for (const row of reviews.values()) {
        if (row.contractId === contractId && row.reviewerId === reviewerId) return row as never;
      }
      return null;
    },
    async listReviewsByContract(contractId) {
      return Array.from(reviews.values()).filter((row) => row.contractId === contractId) as never;
    },
    async listReviewsByReviewee(revieweeId) {
      return Array.from(reviews.values()).filter((row) => row.revieweeId === revieweeId) as never;
    },
  };

  const adminRepository: AdminRepository = {
    seedBlock(block) {
      blocks.set(block.id, { ...block });
    },
    seedHeldDeposit(deposit) {
      heldDeposits.set(deposit.id, { ...deposit });
    },
    seedEscalatedInspection(inspection) {
      adminInspections.set(inspection.id, {
        ...inspection,
        contractId: "",
        projectTitle: "",
        itemTitle: "",
        itemDescription: "",
        clientName: null,
        supplierName: null,
        agreedAmount: 0,
        clientFee: 0,
        interimRatio: 50,
        conditions: [],
        escalation: null,
        history: [],
        delivery: null,
        createdAt: new Date(0),
        resolvedAt: null,
      });
    },
    seedCancellationQueueContract(entry) {
      cancellationQueue.set(entry.id, { ...entry });
    },
    async listBlocks() {
      return Array.from(blocks.values());
    },
    async getBlock(id) {
      return blocks.get(id) ?? null;
    },
    async listHeldDeposits() {
      return Array.from(heldDeposits.values()).filter((row) => row.status === "HELD");
    },
    async getHeldDeposit(id) {
      return heldDeposits.get(id) ?? null;
    },
    async updateHeldDeposit(id, patch) {
      const existing = heldDeposits.get(id);
      if (!existing) throw new Error(`held deposit not found: ${id}`);
      const updated = { ...existing, ...patch };
      heldDeposits.set(id, updated);
      return updated;
    },
    async listEscalatedInspections() {
      return Array.from(adminInspections.values()).filter((row) => row.status === "ESCALATED");
    },
    async getInspection(id) {
      return adminInspections.get(id) ?? null;
    },
    async updateInspection(id, patch) {
      const existing = adminInspections.get(id);
      if (!existing) throw new Error(`inspection not found: ${id}`);
      const updated = { ...existing, ...patch };
      adminInspections.set(id, updated);
      return updated;
    },
    async listCancellationQueue() {
      return Array.from(cancellationQueue.values());
    },
    async getCancellationContract(id) {
      return cancellationQueue.get(id) ?? null;
    },
    async updateCancellationContract(id, patch) {
      const existing = cancellationQueue.get(id);
      if (!existing) throw new Error(`cancellation not found: ${id}`);
      const updated = { ...existing, ...patch };
      cancellationQueue.set(id, updated);
      return updated;
    },
    async recordEvent(data) {
      const record = { ...data, id: nextId("log") } as EventLogEntity;
      eventLogs.push(record);
      return record;
    },
    async listEventLogs() {
      return [...eventLogs].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    },
  };

  return {
    contract,
    contractsPort: { getContract: async (id: string) => {
      const record = await getContract(id);
      return record ? toDepositContract(record) : null;
    }, updateContract: async (id: string, patch: Partial<DepositContractInfo>) => {
      await updateContract(id, patch as never);
      return toDepositContract((await getContract(id))!);
    } },
    depositRepository,
    deliveryRepository,
    settlementRepository,
    cancellationRepository,
    reviewRepository,
    adminRepository,
    getContract: async (id: string) => getContract(id),
    updateContract,
    seedInstallment(row: {
      id: string;
      contractId: string;
      stage: "INTERIM" | "FINAL";
      amount: number;
      status: string;
      ratio?: number;
    }) {
      installments.set(row.id, {
        id: row.id,
        contractId: row.contractId,
        stage: row.stage,
        ratio: row.ratio ?? 50,
        amount: row.amount,
        supplierFee: 0,
        withholdingTax: 0,
        releaseAmount: row.amount,
        status: row.status,
        approvedAt: null,
        releasedAt: null,
        taxInvoiceIssuedAt: null,
        holdReason: null,
      });
    },
    seedContractItems(rows: ContractItemEntity[]) {
      for (const row of rows) items.set(row.id, { ...row });
    },
    setDepositTotals(totalDeposited: number) {
      contract.totalDeposited = totalDeposited;
    },
  };
}
