const KRW_INT_MAX = 2_147_483_647;

export class MoneyError extends Error {
  readonly code: "NON_POSITIVE" | "NOT_INTEGER" | "OVERFLOW" | "RATIO" | "EXCEEDS";

  constructor(code: MoneyError["code"]) {
    super(code);
    this.name = "MoneyError";
    this.code = code;
  }
}

export class AdapterMissingError extends Error {
  constructor() {
    super("ADAPTER_MISSING");
    this.name = "AdapterMissingError";
  }
}

export class PortError extends Error {
  readonly code: "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";

  constructor(code: PortError["code"]) {
    super(code);
    this.name = "PortError";
    this.code = code;
  }
}

export class ContractTermsError extends Error {
  readonly code: "MISSING_INTERIM_RATIO" | "MISSING_DURATION_DAYS";

  constructor(code: ContractTermsError["code"]) {
    super(code);
    this.name = "ContractTermsError";
    this.code = code;
  }
}

export interface ContractTerms {
  interimRatio: number;
  durationDays: number;
}

export interface ClientDeposit {
  principal: number;
  clientFee: number;
  depositAmount: number;
}

export interface InstallmentSplit {
  interimAmount: number;
  finalAmount: number;
}

export interface SupplierRelease {
  supplierFee: number;
  withholdingTax: number;
  releaseAmount: number;
}

export type SupplierKind = "INDIVIDUAL" | "BUSINESS";

export interface CancelSettlement {
  supplierFee: number;
  clientFeeKept: number;
  clientFeeRefund: number;
  refundAmount: number;
  settledAmount: number;
}

export type ContractStatus = "PENDING_CONSENT" | "ACTIVE" | "CANCEL_REQUESTED" | "COMPLETED" | "CANCELLED";
export type PaymentStatus = "PENDING" | "DEPOSITED" | "PARTIALLY_RELEASED" | "RELEASED" | "REFUNDED";

export interface Clock {
  now(): Date;
}

export interface ContractSnapshot {
  id: string;
  status: ContractStatus;
  paymentStatus: PaymentStatus;
  agreedAmount: number;
  clientFee: number;
  interimRatio: number;
  durationDays: number;
}

export type ContractPortSeed = Omit<ContractSnapshot, "interimRatio" | "durationDays"> & {
  interimRatio?: number | null;
  durationDays?: number | null;
};

export interface ContractPorts {
  getDepositable(contractId: string): Promise<ContractSnapshot>;
}

export interface AccountPorts {
  requireVerifiedPayoutAccount(supplierUserId: string): Promise<boolean>;
  isSuspended(userId: string): Promise<boolean>;
}

export interface NotificationPorts {
  createOnce(input: {
    userId: string;
    type: string;
    targetId: string;
    targetUrl?: string;
    /** 기한 알림(DEPOSIT_DUE/INSPECTION_DUE/WORK_DUE/WORK_OVERDUE)은 dueAt을 payload로 넘긴다. */
    dueAt?: Date;
    /** B bridge가 tx-scoped NotificationTx로 변환할 때 쓰는 트랜잭션 핸들. */
    tx?: unknown;
  }, tx?: unknown): Promise<{ created: boolean }>;
}

export interface TossSandboxAdapter {
  readPayment(orderId: string): Promise<{ status: "UNKNOWN" }>;
}

export interface StorageAdapter {
  signRead(objectKey: string): Promise<{ url: string; expiresInSec: number }>;
}

export interface PayoutVerificationAdapter {
  check(supplierUserId: string): Promise<{ verified: false; mode: "MOCK" }>;
}

export interface ExternalAdapters {
  toss: TossSandboxAdapter;
  storage: StorageAdapter;
  payout: PayoutVerificationAdapter;
}

function assertPositiveKrw(amount: number): void {
  if (typeof amount !== "number" || Number.isInteger(amount) === false) {
    throw new MoneyError("NOT_INTEGER");
  }
  if (amount <= 0) {
    throw new MoneyError("NON_POSITIVE");
  }
  if (amount > KRW_INT_MAX) {
    throw new MoneyError("OVERFLOW");
  }
}

function assertKrwAllowZero(amount: number): void {
  if (typeof amount !== "number" || Number.isInteger(amount) === false) {
    throw new MoneyError("NOT_INTEGER");
  }
  if (amount < 0) {
    throw new MoneyError("NON_POSITIVE");
  }
  if (amount > KRW_INT_MAX) {
    throw new MoneyError("OVERFLOW");
  }
}

function floorPart(amount: number, numerator: number, denominator: number): number {
  return Math.floor((amount * numerator) / denominator);
}

export function calculateClientDeposit(principal: number): ClientDeposit {
  assertPositiveKrw(principal);
  const clientFee = floorPart(principal, 5, 100);
  const depositAmount = principal + clientFee;
  if (depositAmount > KRW_INT_MAX) {
    throw new MoneyError("OVERFLOW");
  }
  return { principal, clientFee, depositAmount };
}

function assertInterimRatio(interimRatio: number): void {
  if (
    typeof interimRatio !== "number" ||
    Number.isInteger(interimRatio) === false ||
    interimRatio < 10 ||
    interimRatio > 90
  ) {
    throw new MoneyError("RATIO");
  }
}

export function splitInstallments(principal: number, interimRatio: number): InstallmentSplit {
  assertPositiveKrw(principal);
  assertInterimRatio(interimRatio);
  const interimAmount = floorPart(principal, interimRatio, 100);
  return { interimAmount, finalAmount: principal - interimAmount };
}

export function calculateSupplierRelease(input: { amount: number; kind: SupplierKind }): SupplierRelease {
  assertPositiveKrw(input.amount);
  const supplierFee = floorPart(input.amount, 5, 100);
  const withholdingTax = withholdingOf(input.amount, input.kind);
  return {
    supplierFee,
    withholdingTax,
    releaseAmount: input.amount - supplierFee - withholdingTax,
  };
}

function withholdingOf(amount: number, kind: SupplierKind): number {
  if (kind === "BUSINESS") {
    return 0;
  }
  if (kind === "INDIVIDUAL") {
    return floorPart(amount, 33, 1000);
  }
  return rejectKind(kind);
}

function rejectKind(kind: never): never {
  throw new MoneyError("NOT_INTEGER");
}

export function calculateCancelSettlement(input: {
  principal: number;
  clientFee: number;
  compensationPrincipal: number;
}): CancelSettlement {
  assertPositiveKrw(input.principal);
  assertKrwAllowZero(input.clientFee);
  assertKrwAllowZero(input.compensationPrincipal);
  if (input.compensationPrincipal > input.principal) {
    throw new MoneyError("EXCEEDS");
  }
  const supplierFee = floorPart(input.compensationPrincipal, 5, 100);
  const clientFeeKept = supplierFee < input.clientFee ? supplierFee : input.clientFee;
  const clientFeeRefund = input.clientFee - clientFeeKept;
  const refundAmount = input.principal - input.compensationPrincipal + clientFeeRefund;
  const settledAmount = input.compensationPrincipal - supplierFee;
  if (refundAmount > KRW_INT_MAX || settledAmount > KRW_INT_MAX) {
    throw new MoneyError("OVERFLOW");
  }
  return { supplierFee, clientFeeKept, clientFeeRefund, refundAmount, settledAmount };
}

export function assertCompensationRate(cause: "CLIENT" | "SUPPLIER" | "MUTUAL", rate: number): void {
  if (typeof rate !== "number" || Number.isInteger(rate) === false || rate < 0 || rate > 100) {
    throw new MoneyError("RATIO");
  }
  if (cause === "CLIENT" && rate < 50) {
    throw new MoneyError("RATIO");
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function isClientFullRefund(input: {
  cause: string | null;
  depositedAt: Date | null;
  requestedAt: Date;
  installmentStatuses: readonly string[];
}): boolean {
  if (input.cause !== "CLIENT" || input.depositedAt === null) return false;
  const elapsed = input.requestedAt.getTime() - input.depositedAt.getTime();
  if (elapsed < 0 || elapsed > DAY_MS) return false;
  return input.installmentStatuses.every((status) => status === "PENDING");
}

export function canOpenDeposit(status: ContractStatus, paymentStatus: PaymentStatus): boolean {
  return status === "ACTIVE" && paymentStatus === "PENDING";
}

export function competingRejectOnSign(): false {
  return false;
}

export function onDepositCompleted(): {
  contractStatus: "ACTIVE";
  paymentStatus: "DEPOSITED";
  depositStatus: "COMPLETED";
  rejectCompetingApplications: true;
} {
  return {
    contractStatus: "ACTIVE",
    paymentStatus: "DEPOSITED",
    depositStatus: "COMPLETED",
    rejectCompetingApplications: true,
  };
}

export function blocksDepositDeadlineCancel(openDeposit: "PENDING" | "HELD" | null): boolean {
  return openDeposit === "PENDING" || openDeposit === "HELD";
}

export function approvalGate(
  allApproved: boolean,
  payoutVerified: boolean,
): "NOT_APPROVED" | "HOLD_APPROVED" | "READY_TO_RELEASE" {
  if (allApproved === false) {
    return "NOT_APPROVED";
  }
  if (payoutVerified === false) {
    return "HOLD_APPROVED";
  }
  return "READY_TO_RELEASE";
}

export function isInspectionBasis(state: "DECIDED" | "PROPOSED" | "UNDECIDED"): boolean {
  return state === "DECIDED";
}

export function fixedClock(epochMs: number): Clock {
  return {
    now() {
      return new Date(epochMs);
    },
  };
}

// ponytail: KST is a fixed UTC+9. Swap in a timezone database if Korea adopts daylight saving.
export function endOfKstDayPlus(anchor: Date, days: number): Date {
  if (Number.isInteger(days) === false || days < 0) {
    throw new MoneyError("RATIO");
  }
  const local = new Date(anchor.getTime() + KST_OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, 23, 59, 59, 999) - KST_OFFSET_MS,
  );
}

function assertDurationDays(durationDays: number): void {
  if (typeof durationDays !== "number" || Number.isInteger(durationDays) === false || durationDays < 0) {
    throw new MoneyError("RATIO");
  }
}

export function requireDepositContractTerms(input: {
  interimRatio?: number | null;
  durationDays?: number | null;
}): ContractTerms {
  if (input.interimRatio === undefined || input.interimRatio === null) {
    throw new ContractTermsError("MISSING_INTERIM_RATIO");
  }
  if (input.durationDays === undefined || input.durationDays === null) {
    throw new ContractTermsError("MISSING_DURATION_DAYS");
  }
  assertDurationDays(input.durationDays);
  assertInterimRatio(input.interimRatio);
  return { interimRatio: input.interimRatio, durationDays: input.durationDays };
}

export function freezeAgreementTerms(input: {
  interimRatio?: number | null;
  durationDays?: number | null;
}): ContractTerms {
  if (input.durationDays === undefined || input.durationDays === null) {
    throw new ContractTermsError("MISSING_DURATION_DAYS");
  }
  assertDurationDays(input.durationDays);
  const interimRatio = input.interimRatio === undefined || input.interimRatio === null ? 50 : input.interimRatio;
  assertInterimRatio(interimRatio);
  return { interimRatio, durationDays: input.durationDays };
}

export function createMemoryContractPorts(rows: readonly ContractPortSeed[]): ContractPorts {
  return {
    async getDepositable(contractId) {
      const row = rows.find((item) => item.id === contractId);
      if (row === undefined) {
        throw new PortError("NOT_FOUND");
      }
      if (canOpenDeposit(row.status, row.paymentStatus) === false) {
        throw new PortError("CONFLICT");
      }
      const terms = requireDepositContractTerms(row);
      return {
        id: row.id,
        status: row.status,
        paymentStatus: row.paymentStatus,
        agreedAmount: row.agreedAmount,
        clientFee: row.clientFee,
        interimRatio: terms.interimRatio,
        durationDays: terms.durationDays,
      };
    },
  };
}

export function createMemoryAccounts(
  verified: Readonly<Record<string, boolean>>,
  suspended: Readonly<Record<string, boolean>>,
): AccountPorts {
  return {
    async requireVerifiedPayoutAccount(supplierUserId) {
      const value = verified[supplierUserId];
      if (value === undefined) {
        throw new PortError("UNAVAILABLE");
      }
      return value;
    },
    async isSuspended(userId) {
      const value = suspended[userId];
      if (value === undefined) {
        throw new PortError("UNAVAILABLE");
      }
      return value;
    },
  };
}

export function createMemoryNotifications(): NotificationPorts {
  const seen = new Set<string>();
  return {
    async createOnce(input, _tx) {
      const key = `${input.userId}\u0000${input.type}\u0000${input.targetId}`;
      if (seen.has(key)) {
        return { created: false };
      }
      seen.add(key);
      return { created: true };
    },
  };
}

export function requireExternalAdapters(adapters: Partial<ExternalAdapters> | undefined): ExternalAdapters {
  if (
    adapters === undefined ||
    adapters.toss === undefined ||
    adapters.storage === undefined ||
    adapters.payout === undefined
  ) {
    throw new AdapterMissingError();
  }
  return { toss: adapters.toss, storage: adapters.storage, payout: adapters.payout };
}

export function createMockToss(): TossSandboxAdapter {
  return {
    async readPayment() {
      return { status: "UNKNOWN" };
    },
  };
}

export function createMockStorage(): StorageAdapter {
  return {
    async signRead(objectKey) {
      return { url: `mock:${objectKey}`, expiresInSec: 60 };
    },
  };
}

export function createMockPayout(): PayoutVerificationAdapter {
  return {
    async check() {
      return { verified: false, mode: "MOCK" };
    },
  };
}

export class SettlementHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SettlementHttpError";
    this.status = status;
  }
}

export type InstallmentStage = "INTERIM" | "FINAL";
export type InstallmentStatus = "PENDING" | "DELIVERED" | "REWORK_REQUESTED" | "APPROVED" | "RELEASED" | "REFUNDED";

export interface SettlementInstallmentEntity {
  id: string;
  contractId: string;
  stage: InstallmentStage;
  ratio: number;
  amount: number;
  supplierFee: number;
  withholdingTax: number;
  releaseAmount: number;
  status: InstallmentStatus;
  approvedAt: Date | null;
  releasedAt: Date | null;
  taxInvoiceIssuedAt: Date | null;
  holdReason?: string | null;
}

export interface SettlementContractItemEntity {
  id: string;
  contractId: string;
  stage: InstallmentStage;
  title: string;
  approvedAt: Date | null;
}

export interface SettlementContractInfo {
  id: string;
  clientUserId: string;
  supplierUserId: string;
  status: string;
  paymentStatus: string;
  agreedAmount: number;
  clientFee: number;
  totalDeposited: number;
  interimRatio: number;
  supplierKind: SupplierKind;
  payoutVerifiedAt: Date | null;
  payoutAccountNo?: string;
  completedAt?: Date | null;
}

export interface SettlementRepository {
  seedContract(contract: SettlementContractInfo): void;
  seedInstallments(installments: SettlementInstallmentEntity[]): void;
  seedContractItems(items: SettlementContractItemEntity[]): void;
  getContract(contractId: string): Promise<SettlementContractInfo | null>;
  updateContract(contractId: string, patch: Partial<SettlementContractInfo>): Promise<SettlementContractInfo>;
  listContractsForUser(userId: string): Promise<SettlementContractInfo[]>;
  getInstallment(installmentId: string): Promise<SettlementInstallmentEntity | null>;
  listInstallments(contractId: string): Promise<SettlementInstallmentEntity[]>;
  updateInstallment(
    installmentId: string,
    patch: Partial<SettlementInstallmentEntity>,
  ): Promise<SettlementInstallmentEntity>;
  listContractItems(contractId: string): Promise<SettlementContractItemEntity[]>;
  updateContractItem(
    itemId: string,
    patch: Partial<SettlementContractItemEntity>,
  ): Promise<SettlementContractItemEntity>;
}

export function createInMemorySettlementRepository(): SettlementRepository {
  const contracts = new Map<string, SettlementContractInfo>();
  const installments = new Map<string, SettlementInstallmentEntity>();
  const contractItems = new Map<string, SettlementContractItemEntity>();

  return {
    seedContract(contract) {
      contracts.set(contract.id, { ...contract });
    },
    seedInstallments(items) {
      for (const item of items) {
        installments.set(item.id, { ...item });
      }
    },
    seedContractItems(items) {
      for (const item of items) {
        contractItems.set(item.id, { ...item });
      }
    },
    async getContract(id) {
      return contracts.get(id) ?? null;
    },
    async updateContract(id, patch) {
      const c = contracts.get(id);
      if (!c) throw new SettlementHttpError(404, "계약을 찾을 수 없습니다.");
      const updated = { ...c, ...patch };
      contracts.set(id, updated);
      return updated;
    },
    async listContractsForUser(userId) {
      return Array.from(contracts.values()).filter(
        (c) => c.clientUserId === userId || c.supplierUserId === userId,
      );
    },
    async getInstallment(id) {
      return installments.get(id) ?? null;
    },
    async listInstallments(contractId) {
      return Array.from(installments.values()).filter((i) => i.contractId === contractId);
    },
    async updateInstallment(id, patch) {
      const inst = installments.get(id);
      if (!inst) throw new SettlementHttpError(404, "구간을 찾을 수 없습니다.");
      const updated = { ...inst, ...patch };
      installments.set(id, updated);
      return updated;
    },
    async listContractItems(contractId) {
      return Array.from(contractItems.values()).filter((i) => i.contractId === contractId);
    },
    async updateContractItem(id, patch) {
      const item = contractItems.get(id);
      if (!item) throw new SettlementHttpError(404, "계약 항목을 찾을 수 없습니다.");
      const updated = { ...item, ...patch };
      contractItems.set(id, updated);
      return updated;
    },
  };
}

export interface SettlementServiceOptions {
  repo: SettlementRepository;
  clock?: { now(): Date };
}

export interface ClientStatementView {
  simulated: true;
  transferNote: string;
  contractId: string;
  totalDeposited: number;
  paidToSupplier: number;
  remainingDeposit: number;
  clientFeePaid: number;
  installments: Array<{
    stage: InstallmentStage;
    amount: number;
    status: InstallmentStatus;
    releasedAt: Date | null;
  }>;
}

export interface SupplierStatementView {
  simulated: true;
  transferNote: string;
  contractId: string;
  totalAgreed: number;
  totalReceived: number;
  expectedToReceive: number;
  supplierFeePaid: number;
  withholdingTaxTotal: number;
  installments: Array<{
    stage: InstallmentStage;
    amount: number;
    releaseAmount: number;
    supplierFee: number;
    withholdingTax: number;
    status: InstallmentStatus;
    taxInvoiceIssuedAt: Date | null;
    releasedAt: Date | null;
  }>;
}

const SIMULATED_TRANSFER_NOTE = "실제 이체가 아닌 시뮬레이션/수동 처리 기록입니다.";

export class SettlementService {
  private readonly repo: SettlementRepository;
  private readonly clock: { now(): Date };

  constructor(options: SettlementServiceOptions) {
    this.repo = options.repo;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  private assertNotCancelled(contract: SettlementContractInfo, action: string): void {
    if (contract.status === "CANCEL_REQUESTED" || contract.status === "CANCELLED") {
      throw new SettlementHttpError(409, `취소 중에는 ${action} 수 없습니다.`);
    }
  }

  /**
   * 승인 쓰기 전에 막을 수 있는 조건을 먼저 검사한다.
   * 납품 항목 승인과 구간 승인이 다른 저장소라, 실패를 항목 승인 뒤에 발견하면 부분 쓰기가 남는다.
   */
  async assertApprovable(input: {
    contractId: string;
    installmentId: string;
    assumingApprovedItemId?: string;
  }): Promise<void> {
    const contract = await this.repo.getContract(input.contractId);
    if (!contract) throw new SettlementHttpError(404, "계약을 찾을 수 없습니다.");

    const installment = await this.repo.getInstallment(input.installmentId);
    if (!installment || installment.contractId !== contract.id) {
      throw new SettlementHttpError(404, "구간을 찾을 수 없습니다.");
    }

    this.assertNotCancelled(contract, "구간을 승인할");
    if (installment.status === "APPROVED" || installment.status === "RELEASED") return;

    await this.assertStageApprovable(contract, installment, input.assumingApprovedItemId);
  }

  private async assertStageApprovable(
    contract: SettlementContractInfo,
    installment: SettlementInstallmentEntity,
    assumingApprovedItemId?: string,
  ): Promise<void> {
    if (contract.status !== "ACTIVE") {
      throw new SettlementHttpError(409, "진행 중(ACTIVE) 계약만 구간을 승인할 수 있습니다.");
    }

    const items = await this.repo.listContractItems(contract.id);
    const stageItems = items.filter((i) => i.stage === installment.stage);
    const unapproved = stageItems.some(
      (i) => i.approvedAt === null && i.id !== assumingApprovedItemId,
    );

    if (unapproved) {
      throw new SettlementHttpError(
        400,
        "해당 구간의 모든 계약 항목이 승인되어야 지급 승인 상태로 진입할 수 있습니다.",
      );
    }

    if (installment.stage === "FINAL") {
      const allInstallments = await this.repo.listInstallments(contract.id);
      const interim = allInstallments.find((i) => i.stage === "INTERIM");
      if (!interim || interim.status !== "RELEASED") {
        throw new SettlementHttpError(400, "중간 구간이 먼저 지급되어야 합니다.");
      }
    }
  }

  async approveInstallment(input: {
    contractId: string;
    installmentId: string;
  }): Promise<SettlementInstallmentEntity> {
    const contract = await this.repo.getContract(input.contractId);
    if (!contract) throw new SettlementHttpError(404, "계약을 찾을 수 없습니다.");

    const installment = await this.repo.getInstallment(input.installmentId);
    if (!installment || installment.contractId !== contract.id) {
      throw new SettlementHttpError(404, "구간을 찾을 수 없습니다.");
    }

    this.assertNotCancelled(contract, "구간을 승인할");
    if (installment.status === "APPROVED" || installment.status === "RELEASED") {
      return installment;
    }

    await this.assertStageApprovable(contract, installment);

    const now = this.clock.now();
    if (!contract.payoutVerifiedAt) {
      return this.repo.updateInstallment(installment.id, {
        status: "APPROVED",
        approvedAt: now,
        holdReason: "PAYOUT_ACCOUNT_UNVERIFIED",
      });
    }

    return this.repo.updateInstallment(installment.id, {
      status: "APPROVED",
      approvedAt: now,
      holdReason: null,
    });
  }

  async releaseInstallment(input: { installmentId: string }): Promise<SettlementInstallmentEntity> {
    const installment = await this.repo.getInstallment(input.installmentId);
    if (!installment) throw new SettlementHttpError(404, "구간을 찾을 수 없습니다.");

    const contract = await this.repo.getContract(installment.contractId);
    if (!contract) throw new SettlementHttpError(404, "계약을 찾을 수 없습니다.");

    this.assertNotCancelled(contract, "지급할");

    if (!contract.payoutVerifiedAt) {
      throw new SettlementHttpError(
        400,
        "정산 계좌가 인증되지 않았습니다. 계좌 인증 전에는 지급할 수 없습니다.",
      );
    }

    if (installment.status !== "APPROVED") {
      throw new SettlementHttpError(400, "승인 완료된 구간만 지급할 수 있습니다.");
    }

    if (installment.stage === "FINAL") {
      const allInstallments = await this.repo.listInstallments(contract.id);
      const interim = allInstallments.find((i) => i.stage === "INTERIM");
      if (!interim || interim.status !== "RELEASED") {
        throw new SettlementHttpError(400, "중간 구간이 먼저 지급되어야 합니다.");
      }
    }

    const calculation = calculateSupplierRelease({
      amount: installment.amount,
      kind: contract.supplierKind,
    });

    const now = this.clock.now();
    const updated = await this.repo.updateInstallment(installment.id, {
      status: "RELEASED",
      releasedAt: now,
      supplierFee: calculation.supplierFee,
      withholdingTax: calculation.withholdingTax,
      releaseAmount: calculation.releaseAmount,
      holdReason: null,
    });

    const allInstallments = await this.repo.listInstallments(contract.id);
    const allReleased = allInstallments.every((i) => i.id === updated.id || i.status === "RELEASED");

    if (allReleased) {
      await this.repo.updateContract(contract.id, {
        paymentStatus: "RELEASED",
        status: "COMPLETED",
        completedAt: now,
      });
    } else {
      await this.repo.updateContract(contract.id, {
        paymentStatus: "PARTIALLY_RELEASED",
      });
    }

    return updated;
  }

  async markTaxInvoiceIssued(
    actor: { userId: string; role: string },
    input: { installmentId: string },
  ): Promise<SettlementInstallmentEntity> {
    const installment = await this.repo.getInstallment(input.installmentId);
    if (!installment) throw new SettlementHttpError(404, "구간을 찾을 수 없습니다.");

    const contract = await this.repo.getContract(installment.contractId);
    if (!contract) throw new SettlementHttpError(404, "계약을 찾을 수 없습니다.");

    if (actor.role !== "SUPPLIER" || actor.userId !== contract.supplierUserId) {
      throw new SettlementHttpError(403, "공급자 본인만 세금계산서 발행 완료를 표시할 수 있습니다.");
    }

    if (contract.supplierKind !== "BUSINESS") {
      throw new SettlementHttpError(400, "사업자 공급자만 세금계산서를 발행할 수 있습니다.");
    }

    this.assertNotCancelled(contract, "세금계산서 발행을 표시할");
    if (installment.taxInvoiceIssuedAt) return installment;
    if (installment.status !== "APPROVED" && installment.status !== "RELEASED") {
      throw new SettlementHttpError(409, "승인 또는 지급 완료된 구간만 세금계산서 발행을 표시할 수 있습니다.");
    }

    return this.repo.updateInstallment(installment.id, {
      taxInvoiceIssuedAt: this.clock.now(),
    });
  }

  async getContractStatement(
    actor: { userId: string; role: string },
    contractId: string,
  ): Promise<ClientStatementView | SupplierStatementView> {
    const contract = await this.repo.getContract(contractId);
    if (!contract) throw new SettlementHttpError(404, "계약을 찾을 수 없습니다.");

    const isClient = actor.role === "CLIENT" && actor.userId === contract.clientUserId;
    const isSupplier = actor.role === "SUPPLIER" && actor.userId === contract.supplierUserId;
    const isAdmin = actor.role === "ADMIN";

    if (!isClient && !isSupplier && !isAdmin) {
      throw new SettlementHttpError(403, "계약 당사자만 정산 내역을 조회할 수 있습니다.");
    }

    const installments = await this.repo.listInstallments(contract.id);

    if (isClient) {
      const paidToSupplier = installments
        .filter((i) => i.status === "RELEASED")
        .reduce((sum, i) => sum + i.amount, 0);

      return {
        simulated: true,
        transferNote: SIMULATED_TRANSFER_NOTE,
        contractId: contract.id,
        totalDeposited: contract.totalDeposited,
        paidToSupplier,
        remainingDeposit: contract.totalDeposited - contract.clientFee - paidToSupplier,
        clientFeePaid: contract.clientFee,
        installments: installments.map((i) => ({
          stage: i.stage,
          amount: i.amount,
          status: i.status,
          releasedAt: i.releasedAt,
        })),
      };
    }

    // 지급 전 구간도 같은 5% 수수료·개인 3.3% 원천징수 정책으로 예상 실수령액을 계산한다.
    const priced = installments.map((installment) => ({
      installment,
      ...calculateSupplierRelease({ amount: installment.amount, kind: contract.supplierKind }),
    }));
    const releasedList = priced.filter((row) => row.installment.status === "RELEASED");
    const totalReceived = releasedList.reduce((sum, row) => sum + row.releaseAmount, 0);
    const expectedToReceive = priced.reduce((sum, row) => sum + row.releaseAmount, 0);
    const supplierFeePaid = releasedList.reduce((sum, row) => sum + row.supplierFee, 0);
    const withholdingTaxTotal = releasedList.reduce((sum, row) => sum + row.withholdingTax, 0);

    return {
      simulated: true,
      transferNote: SIMULATED_TRANSFER_NOTE,
      contractId: contract.id,
      totalAgreed: contract.agreedAmount,
      totalReceived,
      expectedToReceive,
      supplierFeePaid,
      withholdingTaxTotal,
      installments: priced.map(({ installment, supplierFee, withholdingTax, releaseAmount }) => ({
        stage: installment.stage,
        amount: installment.amount,
        releaseAmount,
        supplierFee,
        withholdingTax,
        status: installment.status,
        taxInvoiceIssuedAt: installment.taxInvoiceIssuedAt,
        releasedAt: installment.releasedAt,
      })),
    };
  }

  async listInstallments(
    actor: { userId: string; role: string },
    contractId: string,
  ): Promise<{
    simulated: true;
    transferNote: string;
    installments: Array<{
      id: string;
      stage: InstallmentStage;
      ratio: number;
      amount: number;
      status: InstallmentStatus;
      approvedAt: Date | null;
      releasedAt: Date | null;
      holdReason: string | null;
    }>;
  }> {
    const contract = await this.repo.getContract(contractId);
    if (!contract) throw new SettlementHttpError(404, "계약을 찾을 수 없습니다.");
    await this.getContractStatement(actor, contractId);

    const installments = await this.repo.listInstallments(contract.id);
    return {
      simulated: true,
      transferNote: SIMULATED_TRANSFER_NOTE,
      installments: installments.map((i) => ({
        id: i.id,
        stage: i.stage,
        ratio: i.ratio,
        amount: i.amount,
        status: i.status,
        approvedAt: i.approvedAt,
        releasedAt: i.releasedAt,
        holdReason: i.holdReason ?? null,
      })),
    };
  }

  async getMyPaymentStatements(actor: { userId: string; role: string }): Promise<{
    simulated: true;
    transferNote: string;
    statements: Array<ClientStatementView | SupplierStatementView>;
  }> {
    if (actor.role !== "CLIENT" && actor.role !== "SUPPLIER") {
      throw new SettlementHttpError(403, "의뢰인 또는 공급자만 본인 정산 내역을 조회할 수 있습니다.");
    }
    const contracts = await this.repo.listContractsForUser(actor.userId);
    const statements: Array<ClientStatementView | SupplierStatementView> = [];
    for (const contract of contracts) {
      statements.push(await this.getContractStatement(actor, contract.id));
    }
    return { simulated: true, transferNote: SIMULATED_TRANSFER_NOTE, statements };
  }

  /** `GET /me/settlements/summary`: 계약별 문장을 합산한 전체 합계. */
  async getMySettlementSummary(actor: { userId: string; role: string }): Promise<{
    simulated: true;
    transferNote: string;
    role: "CLIENT" | "SUPPLIER";
    contractCount: number;
    totals:
      | {
          totalDeposited: number;
          paidToSupplier: number;
          remainingDeposit: number;
          clientFeePaid: number;
        }
      | {
          totalAgreed: number;
          totalReceived: number;
          expectedToReceive: number;
          supplierFeePaid: number;
          withholdingTaxTotal: number;
        };
  }> {
    const { statements } = await this.getMyPaymentStatements(actor);
    if (actor.role === "CLIENT") {
      const totals = { totalDeposited: 0, paidToSupplier: 0, remainingDeposit: 0, clientFeePaid: 0 };
      for (const statement of statements) {
        if (!("totalDeposited" in statement)) continue;
        totals.totalDeposited += statement.totalDeposited;
        totals.paidToSupplier += statement.paidToSupplier;
        totals.remainingDeposit += statement.remainingDeposit;
        totals.clientFeePaid += statement.clientFeePaid;
      }
      return {
        simulated: true,
        transferNote: SIMULATED_TRANSFER_NOTE,
        role: "CLIENT",
        contractCount: statements.length,
        totals,
      };
    }

    const totals = {
      totalAgreed: 0,
      totalReceived: 0,
      expectedToReceive: 0,
      supplierFeePaid: 0,
      withholdingTaxTotal: 0,
    };
    for (const statement of statements) {
      if (!("totalAgreed" in statement)) continue;
      totals.totalAgreed += statement.totalAgreed;
      totals.totalReceived += statement.totalReceived;
      totals.expectedToReceive += statement.expectedToReceive;
      totals.supplierFeePaid += statement.supplierFeePaid;
      totals.withholdingTaxTotal += statement.withholdingTaxTotal;
    }
    return {
      simulated: true,
      transferNote: SIMULATED_TRANSFER_NOTE,
      role: "SUPPLIER",
      contractCount: statements.length,
      totals,
    };
  }

  /**
   * 계좌 인증 완료 후 `APPROVED(HOLD)` 구간의 보류만 해제한다.
   * 호출 트리거(A 이벤트 vs runDueJobs)는 Gate 0에서 정하기 전까지 이 메서드에 고정하지 않는다.
   */
  async resumeHeldInstallments(contractId: string): Promise<{ resumed: number }> {
    const contract = await this.repo.getContract(contractId);
    if (!contract) throw new SettlementHttpError(404, "계약을 찾을 수 없습니다.");
    if (contract.status === "CANCEL_REQUESTED" || contract.status === "CANCELLED") {
      return { resumed: 0 };
    }
    if (!contract.payoutVerifiedAt) return { resumed: 0 };

    const installments = await this.repo.listInstallments(contractId);
    let resumed = 0;
    for (const installment of installments) {
      if (installment.status === "APPROVED" && installment.holdReason === "PAYOUT_ACCOUNT_UNVERIFIED") {
        await this.repo.updateInstallment(installment.id, { holdReason: null });
        resumed += 1;
      }
    }
    return { resumed };
  }
}
