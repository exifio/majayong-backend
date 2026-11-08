/**
 * B-05: 합의 완료 → 임시 계약 → 양측 서명 → 결렬.
 *
 * - 합의 완료는 최신 SUBMITTED 회차에서만, 프로젝트당 한 명만 가능하다.
 * - 임시 계약은 서명 기한 7일, 양측 서명으로 ACTIVE + 예치 기한(체결일 +3일 23:59 KST).
 * - 예치 전 결렬 4종만 다룬다. 예치 후 취소 정산은 C/F-26 소유다.
 * - 결렬 시 계약 CANCELLED, 지원 REJECTED, 프로젝트는 7.1 규칙으로 복귀한다.
 * - 실제 PG·PDF 생성은 하지 않고 C/통합이 구현할 Port만 둔다.
 */
import { createHash, randomUUID } from 'node:crypto';

import { emptyDraft, type AgreementCondition, type AgreementDraft, type AgreementSpec } from '../agreement/draft.js';
import { ApplicationError, type ApplicationRecord, type ApplicationStatus } from '../application/dto.js';
import type { PaymentStatus } from './display-status.js';
import type { ProjectStatus } from '../market/public-project.js';
import { CONTRACT_ARTICLES, CONTRACT_ARTICLES_VERSION, type ContractArticle } from './terms.js';
import { createNotificationOnceInTransaction, type NotificationTx } from '../notification/notifications.js';

export type ContractDbStatus =
  | 'PENDING_CONSENT'
  | 'ACTIVE'
  | 'CANCEL_REQUESTED'
  | 'COMPLETED'
  | 'CANCELLED';

export type BlockOrigin =
  | 'FIRST_SENTENCE'
  | 'CHAT'
  | 'RECOMMENDATION'
  | 'DEFAULT_DRAFT'
  | 'AGREEMENT';

export type InstallmentStage = 'INTERIM' | 'FINAL';

export type ContractBreakReason =
  | 'CONSENT_TIMEOUT'
  | 'SIGN_REFUSED'
  | 'CLIENT_CANCELLED'
  | 'DEPOSIT_TIMEOUT';

export type ContractEventType =
  | 'APPLICATION_ACCEPTED'
  | 'CONTRACT_SIGNED'
  | 'CONTRACT_AGREED'
  | 'CONTRACT_BROKEN';

export class ContractError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ContractError';
    this.status = status;
    this.code = code;
  }
}

export interface ContractActor {
  readonly userId: string;
  readonly role: 'CLIENT' | 'SUPPLIER' | 'ADMIN';
}

export interface ContractItemRecord {
  readonly id: string;
  readonly blockId: string;
  readonly title: string;
  readonly description: string;
  readonly origin: BlockOrigin;
  readonly stage: InstallmentStage;
  readonly sortOrder: number;
  readonly conditions: readonly AgreementCondition[];
}

export interface ContractRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly projectId: string;
  readonly clientUserId: string;
  readonly supplierId: string;
  readonly status: ContractDbStatus;
  readonly specVersionNo: number;
  readonly agreedAmount: number;
  readonly durationDays: number;
  readonly clientFee: number;
  readonly supplierFee: number;
  readonly interimRatio: number;
  readonly consentDeadline: Date;
  readonly contentHash: string;
  readonly clientSignedAt: Date | null;
  readonly supplierSignedAt: Date | null;
  readonly depositDeadline: Date | null;
  readonly paymentStatus: PaymentStatus;
  readonly totalDeposited: number;
  readonly items: readonly ContractItemRecord[];
}

/** 명세에서 계약 항목으로 복사할 때 명세 쪽이 제공해야 하는 필드. */
export interface ContractItemSource {
  readonly blockId: string;
  readonly description: string;
  readonly origin: BlockOrigin;
  readonly sortOrder: number;
}

export interface ProvisionalContractPlan {
  readonly applicationId: string;
  readonly projectId: string;
  readonly specVersionNo: number;
  readonly agreedAmount: number;
  readonly durationDays: number;
  readonly clientFee: number;
  readonly supplierFee: number;
  readonly interimRatio: number;
  readonly consentDeadline: Date;
  readonly contentHash: string;
  readonly items: readonly ContractItemRecord[];
}

export interface NewContractRecord extends ProvisionalContractPlan {
  readonly clientUserId: string;
  readonly supplierId: string;
}

export interface ContractProjectState {
  readonly id: string;
  readonly status: ProjectStatus;
  readonly deadline: Date | null;
}

export interface ContractTx {
  findLatestRevision(input: {
    readonly projectId: string;
    readonly supplierId: string;
  }): Promise<ApplicationRecord | null>;
  findProject(projectId: string): Promise<ContractProjectState | null>;
  findContract(contractId: string): Promise<ContractRecord | null>;
  listBreakCandidates(now: Date): Promise<readonly ContractRecord[]>;
  listProjectApplications(projectId: string): Promise<readonly ApplicationRecord[]>;
  findAgreementDraft(applicationId: string): Promise<AgreementDraft | null>;
  saveAgreementDraft(applicationId: string, draft: AgreementDraft): Promise<void>;
  updateApplicationStatus(input: {
    readonly applicationId: string;
    readonly from: readonly ApplicationStatus[];
    readonly to: ApplicationStatus;
  }): Promise<boolean>;
  updateProjectStatus(input: {
    readonly projectId: string;
    readonly from: readonly ProjectStatus[];
    readonly to: ProjectStatus;
    readonly selectionEndsAt: Date | null;
  }): Promise<boolean>;
  createContract(input: NewContractRecord): Promise<ContractRecord>;
  applySignature(input: {
    readonly contractId: string;
    readonly party: 'CLIENT' | 'SUPPLIER';
    readonly signedAt: Date;
    readonly activate: boolean;
    readonly depositDeadline: Date | null;
  }): Promise<ContractRecord | null>;
  cancelContract(input: {
    readonly contractId: string;
    readonly reason: ContractBreakReason;
  }): Promise<boolean>;
  appendSystemMessage(input: {
    readonly applicationId: string;
    readonly body: string;
  }): Promise<void>;
  notify(input: {
    readonly userId: string;
    readonly type: 'APPLICATION_ACCEPTED' | 'CONTRACT_BROKEN';
    readonly targetId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly now: Date;
  }): Promise<void>;
  logEvent(input: {
    readonly userId: string;
    readonly type: ContractEventType;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

export interface ContractUnitOfWork {
  run<T>(work: (tx: ContractTx) => Promise<T>): Promise<T>;
}

/** Structural bridge for an owner transaction; notification insert shares its tx. */
export function createContractNotificationPort(notificationTx: NotificationTx): {
  notify(input: {
    readonly userId: string;
    readonly type: 'APPLICATION_ACCEPTED' | 'CONTRACT_BROKEN';
    readonly targetId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly now: Date;
  }): Promise<void>;
} {
  return {
    async notify(input) {
      await createNotificationOnceInTransaction(notificationTx, {
        userId: input.userId,
        type: input.type,
        targetId: input.targetId,
        payload: input.payload,
        now: input.now,
      });
    },
  };
}

export const CLIENT_FEE_RATE = 5;
export const SUPPLIER_FEE_RATE = 5;
export const DEFAULT_INTERIM_RATIO = 50;
export const CONSENT_PERIOD_DAYS = 7;
export const DEPOSIT_PERIOD_DAYS = 3;
export const RESELECTION_PERIOD_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
/** 한국은 서머타임이 없어 고정 오프셋이 정확하다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const FROZEN_CONTRACT_STATUSES: readonly ContractDbStatus[] = [
  'PENDING_CONSENT',
  'ACTIVE',
  'CANCEL_REQUESTED',
];

function invalid(code: string, message: string): ContractError {
  return new ContractError(400, code, message);
}

export function calculateContractFees(agreedAmount: number): {
  readonly clientFee: number;
  readonly supplierFee: number;
} {
  if (!Number.isInteger(agreedAmount) || agreedAmount <= 0) {
    throw invalid('INVALID_AMOUNT', '합의 금액은 0보다 큰 정수여야 합니다.');
  }
  return {
    clientFee: Math.round((agreedAmount * CLIENT_FEE_RATE) / 100),
    supplierFee: Math.round((agreedAmount * SUPPLIER_FEE_RATE) / 100),
  };
}

export function consentDeadlineFrom(now: Date): Date {
  return new Date(now.getTime() + CONSENT_PERIOD_DAYS * DAY_MS);
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

/** 체결일(KST) + N일 23:59:59.999. */
export function endOfKstDayAfter(at: Date, days: number): Date {
  const kst = new Date(at.getTime() + KST_OFFSET_MS);
  return new Date(
    Date.UTC(
      kst.getUTCFullYear(),
      kst.getUTCMonth(),
      kst.getUTCDate() + days,
      23,
      59,
      59,
      999,
    ) - KST_OFFSET_MS,
  );
}

export function depositDeadlineFrom(agreedAt: Date): Date {
  return endOfKstDayAfter(agreedAt, DEPOSIT_PERIOD_DAYS);
}

export function resolveInterimRatio(agreement: AgreementDraft | null): number {
  if (agreement === null || agreement.ratioState !== 'DECIDED') {
    return DEFAULT_INTERIM_RATIO;
  }
  const ratio = agreement.interimRatio;
  if (!Number.isInteger(ratio) || ratio < 10 || ratio > 90) {
    throw invalid('INVALID_INTERIM_RATIO', '중간 지급 비율은 10~90 사이 정수여야 합니다.');
  }
  return ratio;
}

function assertApplicationContractable(application: ApplicationRecord): void {
  if (application.status !== 'SUBMITTED') {
    throw new ContractError(
      409,
      'APPLICATION_NOT_SUBMITTED',
      '현재 명세 기준 제출 회차만 계약할 수 있습니다.',
    );
  }
  if (!Number.isInteger(application.totalAmount) || application.totalAmount <= 0) {
    throw invalid('INVALID_AMOUNT', '견적 금액이 올바르지 않습니다.');
  }
  if (!Number.isInteger(application.durationDays) || application.durationDays <= 0) {
    throw invalid('INVALID_DURATION', '작업 기간이 올바르지 않습니다.');
  }
}

/** 합의 내용을 계약 항목으로 고정하고 문서 해시를 만든다. 여기서는 저장하지 않는다. */
export function prepareProvisionalContract(input: {
  readonly application: ApplicationRecord;
  readonly agreement: AgreementDraft | null;
  readonly items: readonly ContractItemSource[];
  readonly now: Date;
}): ProvisionalContractPlan {
  const application = input.application;
  assertApplicationContractable(application);

  const agreement = input.agreement;
  if (agreement === null || agreement.items.length === 0) {
    throw new ContractError(
      409,
      'AGREEMENT_REQUIRED',
      '최종 합의 내용이 없어 임시 계약을 만들 수 없습니다.',
    );
  }

  const sources = new Map<string, ContractItemSource>();
  for (const source of input.items) {
    if (sources.has(source.blockId)) {
      throw invalid('INVALID_CONTRACT_ITEM', '같은 블록을 두 번 넣을 수 없습니다.');
    }
    if (source.description.trim().length === 0) {
      throw invalid('INVALID_CONTRACT_ITEM', '계약 항목 설명이 비어 있습니다.');
    }
    sources.set(source.blockId, source);
  }

  const items: ContractItemRecord[] = agreement.items
    .map((agreementItem): ContractItemRecord => {
      const source = sources.get(agreementItem.blockId);
      if (source === undefined) {
        throw new ContractError(
          409,
          'UNKNOWN_CONTRACT_BLOCK',
          `명세에 없는 계약 항목입니다: ${agreementItem.blockId}`,
        );
      }
      return {
        id: randomUUID(),
        blockId: agreementItem.blockId,
        title: agreementItem.title,
        description: source.description,
        origin: source.origin,
        stage: agreementItem.stage,
        sortOrder: source.sortOrder,
        conditions: agreementItem.conditions.map((condition) => ({
          key: condition.key,
          text: condition.text,
          state: condition.state,
          evidenceMessageIds: [...condition.evidenceMessageIds],
        })),
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.blockId.localeCompare(b.blockId));

  if (items.length === 0) {
    throw new ContractError(
      409,
      'AGREEMENT_REQUIRED',
      '최종 합의 내용이 없어 임시 계약을 만들 수 없습니다.',
    );
  }

  const fees = calculateContractFees(application.totalAmount);
  const consentDeadline = consentDeadlineFrom(input.now);
  const interimRatio = resolveInterimRatio(agreement);

  return {
    applicationId: application.id,
    projectId: application.projectId,
    specVersionNo: application.specVersionNo,
    agreedAmount: application.totalAmount,
    durationDays: application.durationDays,
    clientFee: fees.clientFee,
    supplierFee: fees.supplierFee,
    interimRatio,
    consentDeadline,
    contentHash: hashContractContent({
      applicationId: application.id,
      specVersionNo: application.specVersionNo,
      agreedAmount: application.totalAmount,
      durationDays: application.durationDays,
      clientFee: fees.clientFee,
      supplierFee: fees.supplierFee,
      interimRatio,
      consentDeadline,
      items,
    }),
    items,
  };
}

function hashContractContent(input: {
  readonly applicationId: string;
  readonly specVersionNo: number;
  readonly agreedAmount: number;
  readonly durationDays: number;
  readonly clientFee: number;
  readonly supplierFee: number;
  readonly interimRatio: number;
  readonly consentDeadline: Date;
  readonly items: readonly ContractItemRecord[];
}): string {
  const canonical = JSON.stringify({
    applicationId: input.applicationId,
    specVersionNo: input.specVersionNo,
    agreedAmount: input.agreedAmount,
    durationDays: input.durationDays,
    clientFee: input.clientFee,
    supplierFee: input.supplierFee,
    interimRatio: input.interimRatio,
    consentDeadline: input.consentDeadline.toISOString(),
    items: input.items.map((item) => ({
      blockId: item.blockId,
      title: item.title,
      description: item.description,
      origin: item.origin,
      stage: item.stage,
      sortOrder: item.sortOrder,
      conditions: [...item.conditions]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((condition) => ({
          key: condition.key,
          text: condition.text,
          state: condition.state,
          evidenceMessageIds: [...condition.evidenceMessageIds],
        })),
    })),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function requireContractParty(contract: ContractRecord, actor: ContractActor): void {
  if (actor.userId !== contract.clientUserId && actor.userId !== contract.supplierId) {
    throw new ContractError(404, 'CONTRACT_NOT_FOUND', '계약을 찾을 수 없습니다.');
  }
}

export async function acceptAgreement(
  uow: ContractUnitOfWork,
  input: {
    readonly actor: ContractActor;
    readonly application: ApplicationRecord;
    /** 저장된 초안이 없을 때 결정론적 기본 초안을 만드는 데 쓴다. HTTP 경로는 preview.getSpec을 넘긴다. */
    readonly spec?: AgreementSpec;
    /** 기존 호출자 호환용. 트랜잭션에 저장된 초안이 있으면 그쪽이 우선한다. */
    readonly agreement?: AgreementDraft | null;
    readonly items: readonly ContractItemSource[];
    readonly now: Date;
  },
): Promise<{ readonly contract: ContractRecord; readonly plan: ProvisionalContractPlan }> {
  if (input.actor.role !== 'CLIENT') {
    throw new ContractError(403, 'CLIENT_ONLY', '의뢰인만 합의를 완료할 수 있습니다.');
  }
  if (input.actor.userId !== input.application.clientUserId) {
    throw new ContractError(404, 'APPLICATION_NOT_FOUND', '지원 정보를 찾을 수 없습니다.');
  }

  return uow.run(async (tx) => {
    const latest = await tx.findLatestRevision({
      projectId: input.application.projectId,
      supplierId: input.application.supplierId,
    });
    if (latest === null) {
      throw new ContractError(404, 'APPLICATION_NOT_FOUND', '지원 정보를 찾을 수 없습니다.');
    }
    if (latest.id !== input.application.id || latest.revisionNo !== input.application.revisionNo) {
      throw new ContractError(
        409,
        'APPLICATION_REVISION_SUPERSEDED',
        '합의 확인 중 견적이 수정되었습니다. 최신 회차로 다시 확인해 주세요.',
      );
    }
    if (latest.status !== 'SUBMITTED') {
      throw new ContractError(
        409,
        'APPLICATION_NOT_SUBMITTED',
        '현재 명세 기준 제출 회차만 계약할 수 있습니다.',
      );
    }

    const project = await tx.findProject(latest.projectId);
    if (project === null) {
      throw new ContractError(404, 'PROJECT_NOT_FOUND', '프로젝트를 찾을 수 없습니다.');
    }
    if (project.status !== 'RECRUITING' && project.status !== 'SELECTING') {
      throw new ContractError(
        409,
        'PROJECT_ALREADY_CONTRACTED',
        '이미 다른 공급자와 계약을 진행 중입니다.',
      );
    }

    // 저장된 유효 초안을 우선 사용하고, 없으면 현재 명세 기준 기본 초안을 같은 tx에서 만든다.
    let agreement = await tx.findAgreementDraft(latest.id);
    if (agreement === null) {
      agreement =
        input.agreement ??
        (input.spec === undefined ? null : emptyDraft(input.spec, input.now));
      if (agreement === null) {
        throw new ContractError(
          409,
          'AGREEMENT_REQUIRED',
          '최종 합의 내용이 없어 임시 계약을 만들 수 없습니다.',
        );
      }
      await tx.saveAgreementDraft(latest.id, agreement);
    }

    const plan = prepareProvisionalContract({
      application: latest,
      agreement,
      items: input.items,
      now: input.now,
    });

    const projectAccepted = await tx.updateProjectStatus({
      projectId: project.id,
      from: ['RECRUITING', 'SELECTING'],
      to: 'ACCEPTED',
      selectionEndsAt: null,
    });
    if (!projectAccepted) {
      throw new ContractError(
        409,
        'PROJECT_ALREADY_CONTRACTED',
        '이미 다른 공급자와 계약을 진행 중입니다.',
      );
    }

    const applicationAccepted = await tx.updateApplicationStatus({
      applicationId: plan.applicationId,
      from: ['SUBMITTED'],
      to: 'ACCEPTED',
    });
    if (!applicationAccepted) {
      throw new ContractError(
        409,
        'APPLICATION_STATE_CHANGED',
        '다른 요청으로 지원 상태가 바뀌었습니다.',
      );
    }

    const contract = await tx.createContract({
      ...plan,
      clientUserId: latest.clientUserId,
      supplierId: latest.supplierId,
    });

    await tx.appendSystemMessage({
      applicationId: plan.applicationId,
      body: '합의가 완료되어 임시 계약이 생성되었습니다. 서명 기한은 7일입니다.',
    });
    await tx.notify({
      userId: latest.supplierId,
      type: 'APPLICATION_ACCEPTED',
      targetId: contract.id,
      payload: { applicationId: plan.applicationId },
      now: input.now,
    });
    await tx.logEvent({
      userId: latest.clientUserId,
      type: 'APPLICATION_ACCEPTED',
      payload: {
        applicationId: plan.applicationId,
        contractId: contract.id,
        conditionCount: countConditions(plan.items),
        decidedCount: countConditions(plan.items, 'DECIDED'),
      },
    });

    return { contract, plan };
  });
}

function countConditions(
  items: readonly ContractItemRecord[],
  state?: AgreementCondition['state'],
): number {
  return items.reduce(
    (total, item) =>
      total +
      item.conditions.filter((condition) => state === undefined || condition.state === state)
        .length,
    0,
  );
}

export async function signContract(
  uow: ContractUnitOfWork,
  input: {
    readonly contractId: string;
    readonly actor: ContractActor;
    readonly expectedContentHash: string;
    readonly now: Date;
  },
): Promise<{ readonly contract: ContractRecord; readonly activated: boolean }> {
  return uow.run(async (tx) => {
    const contract = await tx.findContract(input.contractId);
    if (contract === null) {
      throw new ContractError(404, 'CONTRACT_NOT_FOUND', '계약을 찾을 수 없습니다.');
    }
    requireContractParty(contract, input.actor);

    if (contract.contentHash !== input.expectedContentHash) {
      throw new ContractError(
        409,
        'CONTRACT_HASH_MISMATCH',
        '계약서 내용이 바뀌었습니다. 새로 확인한 뒤 서명해 주세요.',
      );
    }
    if (contract.status !== 'PENDING_CONSENT') {
      throw new ContractError(
        409,
        'CONTRACT_NOT_SIGNABLE',
        '현재 상태에서는 서명할 수 없습니다.',
      );
    }
    if (input.now.getTime() >= contract.consentDeadline.getTime()) {
      throw new ContractError(409, 'CONSENT_EXPIRED', '서명 기한이 지났습니다.');
    }

    const isClient = input.actor.userId === contract.clientUserId;
    if (isClient ? contract.clientSignedAt !== null : contract.supplierSignedAt !== null) {
      throw new ContractError(409, 'ALREADY_SIGNED', '이미 서명했습니다.');
    }

    const otherSigned = isClient
      ? contract.supplierSignedAt !== null
      : contract.clientSignedAt !== null;
    const depositDeadline = otherSigned ? depositDeadlineFrom(input.now) : null;

    const updated = await tx.applySignature({
      contractId: contract.id,
      party: isClient ? 'CLIENT' : 'SUPPLIER',
      signedAt: input.now,
      activate: otherSigned,
      depositDeadline,
    });
    if (updated === null) {
      throw new ContractError(
        409,
        'SIGNATURE_RACE',
        '다른 요청으로 계약 상태가 바뀌었습니다. 다시 확인해 주세요.',
      );
    }

    if (!otherSigned) {
      await tx.logEvent({
        userId: input.actor.userId,
        type: 'CONTRACT_SIGNED',
        payload: { contractId: contract.id, party: isClient ? 'CLIENT' : 'SUPPLIER' },
      });
      return { contract: updated, activated: false };
    }

    const projectUpdated = await tx.updateProjectStatus({
      projectId: contract.projectId,
      from: ['ACCEPTED'],
      to: 'CONTRACTED',
      selectionEndsAt: null,
    });
    if (!projectUpdated) {
      throw new ContractError(
        409,
        'PROJECT_STATE_CHANGED',
        '프로젝트 상태가 바뀌어 계약을 체결할 수 없습니다.',
      );
    }

    for (const userId of [contract.clientUserId, contract.supplierId]) {
      await tx.logEvent({
        userId,
        type: 'CONTRACT_AGREED',
        payload: { contractId: contract.id },
      });
    }

    return { contract: updated, activated: true };
  });
}

export interface BreakContractResult {
  readonly broken: boolean;
  readonly contract: ContractRecord | null;
  readonly projectStatus: ProjectStatus | null;
}

export function resolveProjectAfterBreak(input: {
  readonly project: ContractProjectState;
  readonly hasWaitingApplications: boolean;
  readonly now: Date;
}): { readonly status: ProjectStatus; readonly selectionEndsAt: Date | null } {
  const afterDeadline =
    input.project.deadline !== null && input.now.getTime() > input.project.deadline.getTime();

  if (!afterDeadline) return { status: 'RECRUITING', selectionEndsAt: null };
  if (input.hasWaitingApplications) {
    return { status: 'SELECTING', selectionEndsAt: addDays(input.now, RESELECTION_PERIOD_DAYS) };
  }
  return { status: 'EXPIRED', selectionEndsAt: null };
}

function assertBreakActor(
  contract: ContractRecord,
  reason: ContractBreakReason,
  actor: ContractActor | undefined,
): void {
  if (reason === 'CONSENT_TIMEOUT' || reason === 'DEPOSIT_TIMEOUT') return;

  if (actor === undefined) {
    throw new ContractError(403, 'BREAK_ACTOR_REQUIRED', '결렬을 요청한 당사자를 확인할 수 없습니다.');
  }
  const expected = reason === 'SIGN_REFUSED' ? contract.supplierId : contract.clientUserId;
  if (actor.userId !== expected) {
    throw new ContractError(403, 'FORBIDDEN_BREAK_REASON', '이 사유로 결렬할 수 없습니다.');
  }
}

export async function breakContract(
  uow: ContractUnitOfWork,
  input: {
    readonly contractId: string;
    readonly reason: ContractBreakReason;
    readonly now: Date;
    readonly actor?: ContractActor;
  },
): Promise<BreakContractResult> {
  return uow.run(async (tx) => {
    const contract = await tx.findContract(input.contractId);
    if (contract === null) {
      throw new ContractError(404, 'CONTRACT_NOT_FOUND', '계약을 찾을 수 없습니다.');
    }
    assertBreakActor(contract, input.reason, input.actor);

    if (input.reason === 'DEPOSIT_TIMEOUT') {
      if (
        contract.status !== 'ACTIVE' ||
        contract.paymentStatus !== 'PENDING' ||
        contract.totalDeposited > 0
      ) {
        return { broken: false, contract: null, projectStatus: null };
      }
      if (
        contract.depositDeadline === null ||
        contract.depositDeadline.getTime() > input.now.getTime()
      ) {
        return { broken: false, contract: null, projectStatus: null };
      }
    } else if (contract.status !== 'PENDING_CONSENT') {
      throw new ContractError(
        409,
        'CONTRACT_NOT_BREAKABLE',
        '현재 상태에서는 결렬할 수 없습니다.',
      );
    } else if (input.reason === 'CONSENT_TIMEOUT') {
      if (contract.consentDeadline.getTime() > input.now.getTime()) {
        return { broken: false, contract: null, projectStatus: null };
      }
    }

    const cancelled = await tx.cancelContract({
      contractId: contract.id,
      reason: input.reason,
    });
    if (!cancelled) {
      return { broken: false, contract: null, projectStatus: null };
    }

    await tx.updateApplicationStatus({
      applicationId: contract.applicationId,
      from: ['ACCEPTED'],
      to: 'REJECTED',
    });

    const project = await tx.findProject(contract.projectId);
    let projectStatus: ProjectStatus | null = null;
    if (project !== null) {
      const applications = await tx.listProjectApplications(contract.projectId);
      const hasWaitingApplications = applications.some(
        (application) =>
          application.id !== contract.applicationId &&
          (application.status === 'SUBMITTED' || application.status === 'STALE'),
      );
      const target = resolveProjectAfterBreak({
        project,
        hasWaitingApplications,
        now: input.now,
      });
      const projectUpdated = await tx.updateProjectStatus({
        projectId: project.id,
        from: ['ACCEPTED', 'CONTRACTED'],
        to: target.status,
        selectionEndsAt: target.selectionEndsAt,
      });
      if (projectUpdated) projectStatus = target.status;
    }

    for (const userId of [contract.clientUserId, contract.supplierId]) {
      await tx.notify({
        userId,
        type: 'CONTRACT_BROKEN',
        targetId: contract.id,
        payload: { reason: input.reason },
        now: input.now,
      });
      await tx.logEvent({
        userId,
        type: 'CONTRACT_BROKEN',
        payload: { contractId: contract.id, reason: input.reason },
      });
    }

    return {
      broken: true,
      contract: { ...contract, status: 'CANCELLED' },
      projectStatus,
    };
  });
}

/** 서명 기한 배치와 예치 기한 배치. 입금 시도가 있는 계약은 Port가 후보에서 제외한다. */
export async function breakExpiredContracts(
  uow: ContractUnitOfWork,
  input: { readonly now: Date },
): Promise<number> {
  const candidates = await uow.run((tx) => tx.listBreakCandidates(input.now));
  let broken = 0;

  for (const candidate of candidates) {
    const reason: ContractBreakReason =
      candidate.status === 'PENDING_CONSENT' ? 'CONSENT_TIMEOUT' : 'DEPOSIT_TIMEOUT';
    const result = await breakContract(uow, {
      contractId: candidate.id,
      reason,
      now: input.now,
    }).catch((error: unknown) => {
      // 다른 워커가 먼저 결렬/서명/예치를 반영했으면 이 후보는 건너뛴다.
      if (error instanceof ContractError && error.code === 'CONTRACT_NOT_BREAKABLE') return null;
      throw error;
    });
    if (result?.broken) broken += 1;
  }

  return broken;
}

export interface ContractDocumentView {
  readonly contractId: string;
  readonly contentHash: string;
  readonly status: ContractDbStatus;
  readonly agreedAmount: number;
  readonly clientFee: number;
  readonly supplierFee: number;
  readonly interimRatio: number;
  readonly depositAmount: number;
  readonly supplierPayout: number;
  readonly items: readonly ContractItemRecord[];
  readonly articles: readonly ContractArticle[];
  readonly articlesVersion: string;
  /** 법률·세무 검토 전 초안임을 FE가 표시할 수 있게 한다. */
  readonly articlesDraft: true;
}

/**
 * C의 PDF 스토리지 Port에 넘길 문서 데이터. 당사자만 열 수 있고,
 * 이메일·전화·계좌 같은 개인정보는 포함하지 않는다.
 */
export function contractDocumentFor(
  contract: ContractRecord,
  actor: ContractActor,
): ContractDocumentView {
  requireContractParty(contract, actor);
  return {
    contractId: contract.id,
    contentHash: contract.contentHash,
    status: contract.status,
    agreedAmount: contract.agreedAmount,
    clientFee: contract.clientFee,
    supplierFee: contract.supplierFee,
    interimRatio: contract.interimRatio,
    depositAmount: contract.agreedAmount + contract.clientFee,
    supplierPayout: contract.agreedAmount - contract.supplierFee,
    items: contract.items,
    articles: CONTRACT_ARTICLES,
    articlesVersion: CONTRACT_ARTICLES_VERSION,
    articlesDraft: true,
  };
}

/** 임시 계약·계약 중에는 명세·견적·합의 내용을 바꿀 수 없다. */
export function assertScopeMutable(contract: ContractRecord | null): void {
  if (contract !== null && FROZEN_CONTRACT_STATUSES.includes(contract.status)) {
    throw new ContractError(
      409,
      'CONTRACT_SCOPE_FROZEN',
      '계약을 진행 중에는 명세나 합의 내용을 바꿀 수 없습니다.',
    );
  }
}

export { ApplicationError };
