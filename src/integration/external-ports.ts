/**
 * Gate 2: A/C 소유 데이터를 읽어 B 라우터에 주입하는 어댑터.
 *
 * 읽기는 owner projection을 쓰고 쓰기는 전달받은 transaction에 참여한다. 아직 계약이 없는 Port는
 * 호출 시점에 503 `INTEGRATION_PENDING`으로 실패해 조용히 틀린 값을 만들지 않는다.
 */
import { HttpError } from '../http/envelope.js';
import type { ChatAccountState, ChatEventPort } from '../modules/chat/conversation.js';
import type { DepositAttemptPort } from '../modules/contract/prisma-adapter.js';
import type { ProjectStateReadPort } from '../modules/application/http.js';
import type { ContractItemSource } from '../modules/contract/lifecycle.js';
import type { ReportAccountActionPort } from '../modules/report/prisma-adapter.js';
import type { AgreementMessage, AgreementSpec } from '../modules/agreement/draft.js';
import type { ExternalPorts } from '../server.js';
import type { ProjectStatus } from '../modules/market/public-project.js';
import { toPublicProjectSummary, type PublicProjectSummary } from '../modules/market/public-project.js';
import type { ProjectCandidatePort, SupplierRecommendationProfile } from '../modules/market/project-search.js';
import type { SupplierProfileSummary } from '../modules/application/submission.js';
import { maskContacts } from '../modules/chat/masking.js';

interface ProjectRow {
  readonly id: string;
  readonly draft: { readonly clientId: string };
  readonly status: ProjectStatus;
  readonly currentVersion: number;
}

interface SpecItemRow {
  readonly id: string;
  readonly blockId: string;
  readonly description: string;
  readonly origin: ContractItemSource['origin'];
  readonly sortOrder: number;
}

interface UserStateRow {
  readonly suspendedAt: Date | null;
  readonly withdrawnAt: Date | null;
  readonly chatRestrictedUntil: Date | null;
}

export interface IntegrationDb {
  readonly project: {
    findUnique(input: {
      readonly where: { readonly id: string };
      readonly select: {
        readonly id: true;
        readonly draft: { readonly select: { readonly clientId: true } };
        readonly status: true;
        readonly currentVersion: true;
      };
    }): Promise<ProjectRow | null>;
  };
  readonly specItem: {
    findMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly select: {
        readonly id: true;
        readonly blockId: true;
        readonly description: true;
        readonly origin: true;
        readonly sortOrder: true;
      };
      readonly orderBy?: readonly Readonly<Record<string, 'asc' | 'desc'>>[];
    }): Promise<readonly SpecItemRow[]>;
    findAgreementItems?(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly select: { readonly id: true; readonly blockId: true; readonly title: true; readonly conditions: true; readonly sortOrder: true };
      readonly orderBy: readonly Readonly<Record<string, 'asc' | 'desc'>>[];
    }): Promise<readonly AgreementSpecItemRow[]>;
  };
  readonly applicationMessage?: {
    findMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly select: { readonly id: true; readonly senderId: true; readonly body: true; readonly createdAt: true };
      readonly orderBy: readonly Readonly<Record<string, 'asc' | 'desc'>>[];
    }): Promise<readonly AgreementMessage[]>;
  };
  readonly application: {
    findUnique(input: {
      readonly where: { readonly id: string };
      readonly select: { readonly projectId: true; readonly specVersionNo: true };
    }): Promise<{ readonly projectId: string; readonly specVersionNo: number } | null>;
    findMany?(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly select: { readonly projectId: true };
    }): Promise<readonly { readonly projectId: string }[]>;
  };
  readonly supplierProfile?: {
    findUnique(input: { readonly where: { readonly userId: string } }): Promise<{
      readonly userId: string;
      readonly industryCodes: readonly string[];
      readonly skills: readonly string[];
    } | null>;
  };
  readonly user: {
    findUnique(input: {
      readonly where: { readonly id: string };
      readonly select: {
        readonly suspendedAt: true;
        readonly withdrawnAt: true;
        readonly chatRestrictedUntil: true;
      };
    }): Promise<UserStateRow | null>;
    updateMany?(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<{ readonly count: number }>;
  };
  readonly escrowDeposit: {
    count(input: {
      readonly where: Readonly<Record<string, unknown>>;
    }): Promise<number>;
  };
  readonly eventLog: {
    findFirst(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly select: { readonly id: true };
    }): Promise<{ readonly id: string } | null>;
    create(input: { readonly data: Readonly<Record<string, unknown>> }): Promise<unknown>;
  };
  readonly $transaction?: <T>(work: (tx: IntegrationTransactionDb) => Promise<T>) => Promise<T>;
}

export interface PublicProfileDb extends IntegrationDb {
  readonly application: IntegrationDb['application'] & {
    findMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly select: { readonly projectId: true };
    }): Promise<readonly { readonly projectId: string }[]>;
  };
  readonly supplierProfile: {
    findUnique(input: { readonly where: { readonly userId: string } }): Promise<{
      readonly userId: string;
      readonly industryCodes: readonly string[];
      readonly skills: readonly string[];
    } | null>;
    findMany(input: {
      readonly where: { readonly userId: { readonly in: readonly string[] } };
      readonly select: {
        readonly userId: true;
        readonly careerYears: true;
        readonly ratingAvg: true;
        readonly reviewCount: true;
        readonly portfolioSummary: true;
        readonly portfolioSummaryStatus: true;
        readonly portfolioConsentAt: true;
        readonly user: { readonly select: { readonly withdrawnAt: true } };
        readonly applications: {
          readonly where: { readonly contract: { readonly is: { readonly status: 'COMPLETED' } } };
          readonly select: { readonly id: true };
        };
      };
    }): Promise<readonly {
      readonly userId: string;
      readonly careerYears: number | null;
      readonly ratingAvg: number | null;
      readonly reviewCount: number;
      readonly portfolioSummary: string | null;
      readonly portfolioSummaryStatus: string | null;
      readonly portfolioConsentAt: Date | null;
      readonly user: { readonly withdrawnAt: Date | null };
      readonly applications: readonly { readonly id: string }[];
    }[]>;
  };
}

export interface IntegrationTransactionDb {
  readonly eventLog: IntegrationDb['eventLog'];
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

interface AgreementSpecItemRow {
  readonly id: string;
  readonly blockId: string;
  readonly title: string;
  readonly conditions: unknown;
  readonly sortOrder: number;
}

const INCLUDED = { status: 'INCLUDED' } as const;
const OPEN_DEPOSIT_STATUSES = ['PENDING', 'HELD', 'COMPLETED'] as const;

function pendingPort(name: string): never {
  throw new HttpError(
    503,
    'INTEGRATION_PENDING',
    `${name} Port가 아직 연결되지 않았습니다.`,
  );
}

/** A의 Project/SpecItem 읽기. 지원 제출에 필요한 현재 버전과 포함 항목 ID를 만든다. */
export function createProjectStatePort(db: IntegrationDb): ProjectStateReadPort {
  return {
    async getForApplication(projectId) {
      const project = await db.project.findUnique({
        where: { id: projectId },
        select: { id: true, draft: { select: { clientId: true } }, status: true, currentVersion: true },
      });
      if (project === null) return null;
      const items = await db.specItem.findMany({
        where: { projectId, versionNo: project.currentVersion, ...INCLUDED },
        select: { id: true, blockId: true, description: true, origin: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      return {
        clientUserId: project.draft.clientId,
        status: project.status,
        currentVersion: project.currentVersion,
        specItemIds: items.map((item) => item.id),
      };
    },
  };
}

/** A SpecItem을 계약 항목 사본의 원천으로 읽는다. */
export function createContractItemSourcePort(db: IntegrationDb): {
  listSources(applicationId: string): Promise<readonly ContractItemSource[]>;
} {
  return {
    async listSources(applicationId) {
      const application = await db.application.findUnique({
        where: { id: applicationId },
        select: { projectId: true, specVersionNo: true },
      });
      if (application === null) return [];
      const items = await db.specItem.findMany({
        where: {
          projectId: application.projectId,
          versionNo: application.specVersionNo,
          ...INCLUDED,
        },
        select: { id: true, blockId: true, description: true, origin: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      return items.map((item) => ({
        blockId: item.blockId,
        description: item.description,
        origin: item.origin,
        sortOrder: item.sortOrder,
      }));
    },
  };
}

/** A User의 제재 상태 읽기. 쓰기는 A 소유라 하지 않는다. */
export function createChatAccountPort(db: IntegrationDb): {
  getAccountState(userId: string): Promise<ChatAccountState>;
} {
  return {
    async getAccountState(userId) {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { suspendedAt: true, withdrawnAt: true, chatRestrictedUntil: true },
      });
      if (user === null) {
        throw new HttpError(401, 'UNAUTHENTICATED', '계정을 찾을 수 없습니다.');
      }
      return {
        suspendedAt: user.suspendedAt,
        withdrawnAt: user.withdrawnAt,
        chatRestrictedUntil: user.chatRestrictedUntil,
      };
    },
  };
}

/** C 예치 시도 여부 읽기. 결렬 후보 제외에만 쓴다. */
export function createDepositAttemptPort(db: IntegrationDb): DepositAttemptPort {
  return {
    async hasDepositAttempt(contractId) {
      const count = await db.escrowDeposit.count({
        where: { contractId, status: { in: OPEN_DEPOSIT_STATUSES } },
      });
      return count > 0;
    },
  };
}

/** 같은 프로젝트 행을 잠그고 최초 문의 이벤트를 기록한다. */
export function createChatEventPort(db: IntegrationDb): ChatEventPort {
  return {
    async recordInquiryOpenedOnce(input) {
      if (db.$transaction === undefined) pendingPort('ChatEvent.Transaction');
      return db.$transaction(async (tx) => {
        // Lock the project row so concurrent opens serialize without a schema/index change.
        await tx.$queryRaw`SELECT id FROM projects WHERE id = ${input.projectId} FOR UPDATE`;
        const existing = await tx.eventLog.findFirst({
          where: { type: 'INQUIRY_OPENED', projectId: input.projectId },
          select: { id: true },
        });
        if (existing !== null) return false;
        await tx.eventLog.create({
          data: {
            userId: input.clientUserId,
            type: 'INQUIRY_OPENED',
            projectId: input.projectId,
            occurredAt: input.openedAt,
          },
        });
        return true;
      });
    },
  };
}

function specConditions(value: unknown): AgreementSpec['items'][number]['conditions'] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(503, 'AGREEMENT_SPEC_INVALID', '명세 조건을 읽을 수 없습니다.');
  return value.map((condition) => {
    if (typeof condition !== 'object' || condition === null ||
      typeof (condition as { key?: unknown }).key !== 'string' ||
      typeof (condition as { text?: unknown }).text !== 'string') {
      throw new HttpError(503, 'AGREEMENT_SPEC_INVALID', '명세 조건을 읽을 수 없습니다.');
    }
    return { key: (condition as { key: string }).key, text: (condition as { text: string }).text };
  });
}

export function createAgreementPreviewPort(db: IntegrationDb): NonNullable<IntegrationPortOptions['agreementPreview']> {
  return {
    async getSpec(applicationId) {
      if (db.specItem.findAgreementItems === undefined) pendingPort('AgreementSpec');
      const application = await db.application.findUnique({
        where: { id: applicationId },
        select: { projectId: true, specVersionNo: true },
      });
      if (application === null) return null;
      const rows = await db.specItem.findAgreementItems({
        where: { projectId: application.projectId, versionNo: application.specVersionNo, status: 'INCLUDED' },
        select: { id: true, blockId: true, title: true, conditions: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      // 끝수는 최종 구간(PRD 843) — 홀수 개수면 앞쪽 절반만 INTERIM.
      const interimCount = Math.floor(rows.length / 2);
      return {
        items: rows.map((row, index) => ({
          blockId: row.blockId,
          specItemId: row.id,
          title: row.title,
          stage: index < interimCount ? 'INTERIM' : 'FINAL',
          conditions: specConditions(row.conditions),
        })),
        defaultInterimRatio: 50,
      };
    },
    async getMessages(applicationId) {
      if (db.applicationMessage === undefined) pendingPort('AgreementMessage');
      const rows = await db.applicationMessage.findMany({
        where: { applicationId, kind: 'TEXT', senderId: { not: null } },
        select: { id: true, senderId: true, body: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map((row) => ({ ...row, body: maskContacts(row.body).text }));
    },
  };
}

export function createPublicProjectPorts(
  db: PublicProfileDb,
  candidates: ProjectCandidatePort,
): {
  readonly projects: ExternalPorts['projects'];
  readonly recommendations: ExternalPorts['recommendations'];
} {
  async function listPublicProjects(): Promise<readonly PublicProjectSummary[]> {
    const value = await candidates.listPublicProjectCandidates();
    if (!Array.isArray(value)) throw new HttpError(502, 'PUBLIC_PROJECT_CONTRACT_VIOLATION', '공개 프로젝트 응답이 올바르지 않습니다.');
    return value.map(toPublicProjectSummary);
  }

  return {
    projects: {
      async listPublicProjectsByIds(ids) {
        const wanted = new Set(ids);
        return (await listPublicProjects()).filter((project) => wanted.has(project.id));
      },
    },
    recommendations: {
      async getSupplier(userId): Promise<SupplierRecommendationProfile | null> {
        if (db.supplierProfile === undefined) pendingPort('SupplierRecommendation');
        const row = await db.supplierProfile.findUnique({ where: { userId } });
        return row === null ? null : { supplierId: row.userId, industryCodes: row.industryCodes, skills: row.skills };
      },
      async listOpenProjects() {
        return (await listPublicProjects()).filter((project) => project.status === 'RECRUITING');
      },
      async listAppliedProjectIds(supplierId) {
        if (db.application.findMany === undefined) pendingPort('Application');
        const rows = await db.application.findMany({ where: { supplierId }, select: { projectId: true } });
        return [...new Set(rows.map((row) => row.projectId))];
      },
    },
  };
}

export function createReportAccountActionPort(db: IntegrationDb): ReportAccountActionPort {
  return {
    async applyAccountAction(input, tx) {
      const user = tx?.user ?? db.user;
      const where = input.action === 'SUSPEND'
        ? { id: input.userId }
        : { id: input.userId, OR: [{ chatRestrictedUntil: null }, { chatRestrictedUntil: { lt: input.until } }] };
      const data = input.action === 'SUSPEND'
        ? { suspendedAt: input.at }
        : { chatRestrictedUntil: input.until };
      if (user.updateMany === undefined) pendingPort('AccountAction');
      await user.updateMany({ where, data });
    },
  };
}

export interface IntegrationPortOptions {
  /** A가 공개 목록 조회 Port를 제공할 때 연결한다. */
  readonly projects?: ExternalPorts['projects'];
  readonly recommendations?: ExternalPorts['recommendations'];
  readonly reportAccounts?: ReportAccountActionPort;
  readonly agreementPreview?: ExternalPorts['agreementPreview'];
  readonly contractViews?: ExternalPorts['contractViews'];
  readonly notificationSettings?: ExternalPorts['notificationSettings'];
  readonly agreementExtractor?: ExternalPorts['agreementExtractor'];
  readonly now: () => Date;
}

export function createIntegrationPorts(
  db: IntegrationDb,
  options: IntegrationPortOptions,
): ExternalPorts {
  return {
    projectState: createProjectStatePort(db),
    projects: options.projects ?? { listPublicProjectsByIds: async () => pendingPort('ProjectPublic') },
    recommendations: options.recommendations ?? {
      getSupplier: async () => pendingPort('SupplierRecommendation'),
      listOpenProjects: async () => pendingPort('ProjectPublic'),
      listAppliedProjectIds: async () => pendingPort('Application'),
    },
    chatAccounts: createChatAccountPort(db),
    chatEvents: createChatEventPort(db),
    reportAccounts: options.reportAccounts ?? createReportAccountActionPort(db),
    contractItems: createContractItemSourcePort(db),
    agreementPreview: options.agreementPreview ?? createAgreementPreviewPort(db),
    depositAttempts: createDepositAttemptPort(db),
    ...(options.contractViews === undefined ? {} : { contractViews: options.contractViews }),
    ...(options.notificationSettings === undefined ? {} : { notificationSettings: options.notificationSettings }),
    ...(options.agreementExtractor === undefined ? {} : { agreementExtractor: options.agreementExtractor }),
    now: options.now,
  };
}
