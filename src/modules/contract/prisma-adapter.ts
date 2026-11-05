/**
 * B-05: 계약 Port의 Prisma 어댑터.
 *
 * `Contract`에는 projectId/clientUserId 컬럼이 없어 `Application`에서 가져온다.
 * 결렬 사유는 EventLog에 남기고, 취소 정산 컬럼은 C 소유라 건드리지 않는다.
 */
import type { AgreementCondition, AgreementDraft, ConditionState } from '../agreement/draft.js';
import { parseAgreementDraft } from '../agreement/prisma-adapter.js';
import type { ApplicationRecord } from '../application/dto.js';
import { toApplicationRevision, type ApplicationRow } from '../application/prisma-adapter.js';
import type { PaymentStatus } from './display-status.js';
import {
  createContractNotificationPort,
  type ContractItemRecord,
  type ContractProjectState,
  type ContractRecord,
  type ContractTx,
  type ContractUnitOfWork,
  type NewContractRecord,
} from './lifecycle.js';
import type { ContractReadPort } from './queries.js';
import type { ProjectStatus } from '../market/public-project.js';
import {
  createPrismaNotificationTx,
  type NotificationDbClient,
} from '../notification/prisma-adapter.js';

export type ContractStatusRow =
  | 'PENDING_CONSENT'
  | 'ACTIVE'
  | 'CANCEL_REQUESTED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface ContractItemRow {
  readonly blockId: string;
  readonly title: string;
  readonly description: string;
  readonly origin: ContractItemRecord['origin'];
  readonly stage: ContractItemRecord['stage'];
  readonly conditions: unknown;
  readonly sortOrder: number;
}

export interface ContractRow {
  readonly id: string;
  readonly applicationId: string;
  readonly status: ContractStatusRow;
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
  readonly items: readonly ContractItemRow[];
  readonly application: {
    readonly projectId: string;
    readonly supplierId: string;
    readonly project: { readonly draft: { readonly clientId: string } };
  };
}

const CONTRACT_INCLUDE = {
  items: true,
  application: {
    select: {
      projectId: true,
      supplierId: true,
      project: { select: { draft: { select: { clientId: true } } } },
    },
  },
} as const;

const STATES: readonly ConditionState[] = ['DECIDED', 'PROPOSED', 'UNDECIDED'];

function readConditions(value: unknown): readonly AgreementCondition[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('INVALID_CONTRACT_CONDITIONS');
  return value.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as { key?: unknown }).key !== 'string' ||
      typeof (item as { text?: unknown }).text !== 'string' ||
      !STATES.some((state) => state === (item as { state?: unknown }).state) ||
      !Array.isArray((item as { evidenceMessageIds?: unknown }).evidenceMessageIds)
    ) {
      throw new Error('INVALID_CONTRACT_CONDITIONS');
    }
    const record = item as {
      key: string;
      text: string;
      state: ConditionState;
      evidenceMessageIds: readonly string[];
    };
    if (!record.evidenceMessageIds.every((id) => typeof id === 'string')) {
      throw new Error('INVALID_CONTRACT_CONDITIONS');
    }
    return {
      key: record.key,
      text: record.text,
      state: record.state,
      evidenceMessageIds: [...record.evidenceMessageIds],
    };
  });
}

export function toContractRecord(row: ContractRow): ContractRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    projectId: row.application.projectId,
    clientUserId: row.application.project.draft.clientId,
    supplierId: row.application.supplierId,
    status: row.status,
    specVersionNo: row.specVersionNo,
    agreedAmount: row.agreedAmount,
    durationDays: row.durationDays,
    clientFee: row.clientFee,
    supplierFee: row.supplierFee,
    interimRatio: row.interimRatio,
    consentDeadline: row.consentDeadline,
    contentHash: row.contentHash,
    clientSignedAt: row.clientSignedAt,
    supplierSignedAt: row.supplierSignedAt,
    depositDeadline: row.depositDeadline,
    paymentStatus: row.paymentStatus,
    totalDeposited: row.totalDeposited,
    items: row.items.map((item) => ({
      blockId: item.blockId,
      title: item.title,
      description: item.description,
      origin: item.origin,
      stage: item.stage,
      sortOrder: item.sortOrder,
      conditions: readConditions(item.conditions),
    })),
  };
}

export interface ContractDbClient extends NotificationDbClient {
  readonly $queryRaw?: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  readonly contract: {
    findUnique(input: {
      readonly where: { readonly id: string };
      readonly include: typeof CONTRACT_INCLUDE;
    }): Promise<ContractRow | null>;
    findMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly include: typeof CONTRACT_INCLUDE;
      readonly orderBy?: readonly Readonly<Record<string, 'asc' | 'desc'>>[];
    }): Promise<readonly ContractRow[]>;
    create(input: {
      readonly data: Readonly<Record<string, unknown>>;
      readonly include: typeof CONTRACT_INCLUDE;
    }): Promise<ContractRow>;
    update(input: {
      readonly where: { readonly id: string };
      readonly data: Readonly<Record<string, unknown>>;
      readonly include: typeof CONTRACT_INCLUDE;
    }): Promise<ContractRow>;
    updateMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<{ readonly count: number }>;
  };
  readonly application: {
    findFirst(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly include: { readonly items: true; readonly project: { readonly select: { readonly draft: { readonly select: { readonly clientId: true } } } } };
      readonly orderBy?: readonly Readonly<Record<string, 'asc' | 'desc'>>[];
    }): Promise<ApplicationRow | null>;
    findMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly include: { readonly items: true; readonly project: { readonly select: { readonly draft: { readonly select: { readonly clientId: true } } } } };
    }): Promise<readonly ApplicationRow[]>;
    findUnique(input: {
      readonly where: { readonly id: string };
      readonly select: { readonly agreementDraft: true };
    }): Promise<{ readonly agreementDraft: unknown } | null>;
    update(input: {
      readonly where: { readonly id: string };
      readonly data: { readonly agreementDraft: unknown };
    }): Promise<unknown>;
    updateMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<{ readonly count: number }>;
  };
  readonly project: {
    findUnique(input: {
      readonly where: { readonly id: string };
      readonly select: { readonly id: true; readonly status: true; readonly deadline: true };
    }): Promise<{ readonly id: string; readonly status: ProjectStatus; readonly deadline: Date | null } | null>;
    updateMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<{ readonly count: number }>;
  };
  readonly applicationMessage: {
    create(input: { readonly data: Readonly<Record<string, unknown>> }): Promise<unknown>;
  };
  readonly eventLog: {
    create(input: { readonly data: Readonly<Record<string, unknown>> }): Promise<unknown>;
  };
}

/** Prisma interactive transaction 옵션(ms). */
export interface ContractTransactionOptions {
  readonly maxWait?: number;
  readonly timeout?: number;
}

export interface ContractPrismaClient extends ContractDbClient {
  $transaction<T>(
    work: (tx: ContractDbClient) => Promise<T>,
    options?: ContractTransactionOptions,
  ): Promise<T>;
}

/**
 * 합의 확정 트랜잭션 예산.
 *
 * 근거(2026-11-05 스테이징 실측): 해당 트랜잭션의 SQL 실행은 pg_stat_statements 기준
 * 최대 7ms였으나, 함수 리전(iad1)과 Supabase(ap-northeast-2)가 달라 왕복 지연이
 * 누적되고 기본값(maxWait 2s/timeout 5s)에서 간헐 P2028 → HTTP 500이 발생했다.
 * 확인된 이 트랜잭션에만 명시하고, 다른 경로의 트랜잭션은 건드리지 않는다.
 */
const CONTRACT_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/** C 소유 예치 테이블을 B가 직접 읽지 않도록 주입한다. */
export interface DepositAttemptPort {
  hasDepositAttempt(contractId: string): Promise<boolean>;
}

export function createContractTx(
  db: ContractDbClient,
  deposits: DepositAttemptPort,
): ContractTx {
  const notifications = createContractNotificationPort(createPrismaNotificationTx(db));

  return {
    async findLatestRevision(input) {
      const row = await db.application.findFirst({
        where: { projectId: input.projectId, supplierId: input.supplierId },
        include: { items: true, project: { select: { draft: { select: { clientId: true } } } } },
        orderBy: [{ revisionNo: 'desc' }],
      });
      return row === null ? null : toApplicationRevision(row);
    },

    async findProject(projectId): Promise<ContractProjectState | null> {
      return db.project.findUnique({
        where: { id: projectId },
        select: { id: true, status: true, deadline: true },
      });
    },

    async findContract(contractId) {
      if (db.$queryRaw !== undefined) {
        await db.$queryRaw`SELECT id FROM contracts WHERE id = ${contractId} FOR UPDATE`;
      }
      const row = await db.contract.findUnique({
        where: { id: contractId },
        include: CONTRACT_INCLUDE,
      });
      return row === null ? null : toContractRecord(row);
    },

    async listBreakCandidates(now) {
      const rows = await db.contract.findMany({
        where: {
          OR: [
            { status: 'PENDING_CONSENT', consentDeadline: { lte: now } },
            { status: 'ACTIVE', depositDeadline: { lte: now } },
          ],
        },
        include: CONTRACT_INCLUDE,
      });
      const candidates: ContractRecord[] = [];
      for (const row of rows) {
        if (await deposits.hasDepositAttempt(row.id)) continue;
        candidates.push(toContractRecord(row));
      }
      return candidates;
    },

    async listProjectApplications(projectId) {
      const rows = await db.application.findMany({
        where: { projectId },
        include: { items: true, project: { select: { draft: { select: { clientId: true } } } } },
      });
      return rows.map((row): ApplicationRecord => toApplicationRevision(row));
    },

    async findAgreementDraft(applicationId): Promise<AgreementDraft | null> {
      const row = await db.application.findUnique({
        where: { id: applicationId },
        select: { agreementDraft: true },
      });
      if (row === null || row.agreementDraft === null || row.agreementDraft === undefined) return null;
      try {
        return parseAgreementDraft(row.agreementDraft);
      } catch {
        // 손상된 캐시는 없는 것으로 보고 현재 명세 기준 기본 초안을 다시 만든다.
        return null;
      }
    },

    async saveAgreementDraft(applicationId, draft): Promise<void> {
      await db.application.update({
        where: { id: applicationId },
        data: { agreementDraft: JSON.parse(JSON.stringify(draft)) },
      });
    },

    async updateApplicationStatus(input) {
      const result = await db.application.updateMany({
        where: { id: input.applicationId, status: { in: input.from } },
        data: { status: input.to },
      });
      return result.count > 0;
    },

    async updateProjectStatus(input) {
      const result = await db.project.updateMany({
        where: { id: input.projectId, status: { in: input.from } },
        data: { status: input.to, selectionEndsAt: input.selectionEndsAt },
      });
      return result.count > 0;
    },

    async createContract(input: NewContractRecord) {
      const row = await db.contract.create({
        data: {
          applicationId: input.applicationId,
          status: 'PENDING_CONSENT',
          specVersionNo: input.specVersionNo,
          agreedAmount: input.agreedAmount,
          durationDays: input.durationDays,
          clientFee: input.clientFee,
          supplierFee: input.supplierFee,
          interimRatio: input.interimRatio,
          consentDeadline: input.consentDeadline,
          contentHash: input.contentHash,
          items: {
            create: input.items.map((item) => ({
              blockId: item.blockId,
              title: item.title,
              description: item.description,
              origin: item.origin,
              stage: item.stage,
              conditions: item.conditions.map((condition) => ({
                key: condition.key,
                text: condition.text,
                state: condition.state,
                evidenceMessageIds: [...condition.evidenceMessageIds],
              })),
              sortOrder: item.sortOrder,
            })),
          },
        },
        include: CONTRACT_INCLUDE,
      });
      return toContractRecord(row);
    },

    async applySignature(input) {
      const updated = await db.contract.updateMany({
        where: {
          id: input.contractId,
          status: 'PENDING_CONSENT',
          [input.party === 'CLIENT' ? 'clientSignedAt' : 'supplierSignedAt']: null,
        },
        data:
          input.party === 'CLIENT'
            ? {
                clientSignedAt: input.signedAt,
                ...(input.activate ? { status: 'ACTIVE' } : {}),
                ...(input.depositDeadline === null ? {} : { depositDeadline: input.depositDeadline }),
              }
            : {
                supplierSignedAt: input.signedAt,
                ...(input.activate ? { status: 'ACTIVE' } : {}),
                ...(input.depositDeadline === null ? {} : { depositDeadline: input.depositDeadline }),
              },
      });
      if (updated.count !== 1) return null;
      const row = await db.contract.findUnique({ where: { id: input.contractId }, include: CONTRACT_INCLUDE });
      return row === null ? null : toContractRecord(row);
    },

    async cancelContract(input) {
      const result = await db.contract.updateMany({
        where: { id: input.contractId, status: { in: ['PENDING_CONSENT', 'ACTIVE'] } },
        data: { status: 'CANCELLED' },
      });
      return result.count > 0;
    },

    async appendSystemMessage(input) {
      await db.applicationMessage.create({
        data: {
          applicationId: input.applicationId,
          senderId: null,
          kind: 'SYSTEM',
          body: input.body,
          isMasked: false,
        },
      });
    },

    notify: (input) => notifications.notify(input),

    async logEvent(input) {
      await db.eventLog.create({
        data: {
          userId: input.userId,
          type: input.type,
          contractId:
            typeof input.payload.contractId === 'string' ? input.payload.contractId : null,
          payload: input.payload,
        },
      });
    },
  };
}

export function createPrismaContractUnitOfWork(
  prisma: ContractPrismaClient,
  deposits: DepositAttemptPort,
): ContractUnitOfWork {
  return {
    run<T>(work: (tx: ContractTx) => Promise<T>): Promise<T> {
      const startedAt = Date.now();
      return prisma
        .$transaction((tx) => work(createContractTx(tx, deposits)), CONTRACT_TX_OPTIONS)
        .then((result) => {
          // 트랜잭션 예산(maxWait/timeout) 대비 실제 소요를 확인하기 위한 1줄 메트릭.
          console.info("contract transaction committed", {
            durationMs: Date.now() - startedAt,
          });
          return result;
        })
        .catch((error: unknown) => {
          // 원인 식별용 최소 메타데이터만 남긴다(PII·쿼리 값 없음).
          const name = error instanceof Error ? error.name : typeof error;
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code: unknown }).code)
              : "UNKNOWN";
          console.error("contract transaction failed", {
            durationMs: Date.now() - startedAt,
            name,
            code,
          });
          throw error;
        });
    },
  };
}

export function createPrismaContractReadPort(db: ContractDbClient): ContractReadPort {
  return {
    async listForUser(input) {
      const rows = await db.contract.findMany({
        where: {
          application: {
            is:
              input.role === 'CLIENT'
                ? { project: { is: { draft: { is: { clientId: input.userId } } } } }
                : { supplierId: input.userId },
          },
        },
        include: CONTRACT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      return rows.map(toContractRecord);
    },

    async findById(contractId) {
      const row = await db.contract.findUnique({
        where: { id: contractId },
        include: CONTRACT_INCLUDE,
      });
      return row === null ? null : toContractRecord(row);
    },
  };
}
