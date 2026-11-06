/**
 * Gate 2: A가 호출하는 B Port 어댑터.
 *
 * A는 자기 트랜잭션(`ProjectTx`)을 넘기므로, B 도메인에 그 tx의 delegate를
 * 구조적으로 연결한다. A 코드는 import하지 않는다.
 */
import type {
  ProjectCandidatePort,
  ProjectSearchPort,
  ProjectSort,
  RecruitmentStatusFilter,
} from '../modules/market/project-search.js';
import type { ProjectStatus } from '../modules/market/public-project.js';
import { hopeBudgetRange } from '../modules/project/policy.js';
import {
  recordProjectDetailView,
  type ProjectViewPort,
} from '../modules/market/project-detail.js';
import {
  markApplicationsStaleInTransaction,
  createApplicationNotificationPort,
  type ApplicationTx,
} from '../modules/application/submission.js';
import { toApplicationRevision, type ApplicationRow } from '../modules/application/prisma-adapter.js';
import {
  createPrismaNotificationTx,
  type NotificationDbClient,
} from '../modules/notification/prisma-adapter.js';

export interface AProjectSearchQuery {
  readonly filters: {
    readonly industryCode?: string;
    readonly skill?: string;
    readonly status?: string;
    readonly minBudget?: number;
    readonly maxBudget?: number;
    readonly deadlineBefore?: Date;
    readonly keyword?: string;
  };
  readonly sort?: ProjectSort;
  readonly page: number;
  readonly pageSize: number;
}

export interface AProjectSearchPort {
  searchPublicProjects(query: AProjectSearchQuery): Promise<{
    projectIds: string[];
    total: number;
  }>;
}

function statusFilter(status: string | undefined): RecruitmentStatusFilter | undefined {
  if (status === undefined) return undefined;
  return status === 'RECRUITING' ? 'OPEN' : 'CLOSED';
}

/** A 검색 쿼리를 B 검색 Port로 옮긴다. A는 id 목록만 받아 자기 DB에서 다시 읽는다. */
export function createAProjectSearchPort(search: ProjectSearchPort): AProjectSearchPort {
  return {
    async searchPublicProjects(query) {
      const page = await search.searchPublicProjects({
        filters: {
          ...(query.filters.industryCode === undefined
            ? {}
            : { industryCode: query.filters.industryCode }),
          ...(query.filters.skill === undefined
            ? {}
            : { requiredSkills: [query.filters.skill] }),
          ...(query.filters.minBudget === undefined
            ? {}
            : { minBudgetKrw: query.filters.minBudget }),
          ...(query.filters.maxBudget === undefined
            ? {}
            : { maxBudgetKrw: query.filters.maxBudget }),
          ...(query.filters.deadlineBefore === undefined
            ? {}
            : { deadlineBefore: query.filters.deadlineBefore }),
          ...(query.filters.keyword === undefined
            ? {}
            : { keyword: query.filters.keyword }),
          ...(statusFilter(query.filters.status) === undefined
            ? {}
            : { recruitmentStatus: statusFilter(query.filters.status) }),
        },
        ...(query.sort === undefined ? {} : { sort: query.sort }),
        page: query.page,
      });
      return { projectIds: page.items.map((item) => item.id), total: page.meta.total };
    },
  };
}

/**
 * A가 B 검색 Port(`createProjectSearchPort`)에 넘기는 공개 후보 목록.
 *
 * 정확 예산은 노출하지 않고 A에서 승인한 `hopeBudgetRange`(구간 경계)로만 변환한다.
 * 삭제된 프로젝트와 비공개 상태는 제외한다(전체 공개 대상: 모집/선택/마감).
 */
export interface CandidateProjectRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly industryCode: string;
  readonly requiredSkills: readonly string[];
  readonly hopeBudget: number | null;
  readonly deadline: Date | null;
  readonly publishedAt: Date | null;
  readonly currentVersion: number;
  readonly status: ProjectStatus;
  readonly items: readonly { readonly title: string; readonly versionNo: number }[];
}

export interface ProjectCandidateDb {
  readonly project: {
    findMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly include: {
        readonly items: {
          readonly where: Readonly<Record<string, unknown>>;
          readonly select: { readonly title: true; readonly versionNo: true };
        };
      };
    }): Promise<readonly CandidateProjectRow[]>;
  };
}

const PUBLIC_CANDIDATE_STATUSES = ['RECRUITING', 'SELECTING', 'EXPIRED'] as const;

export function createProjectCandidatePort(db: ProjectCandidateDb): ProjectCandidatePort {
  return {
    async listPublicProjectCandidates() {
      const rows = await db.project.findMany({
        where: { deletedAt: null, status: { in: [...PUBLIC_CANDIDATE_STATUSES] } },
        include: { items: { where: { status: 'INCLUDED' }, select: { title: true, versionNo: true } } },
      });
      return rows.map((row) => {
        const current = row.items.filter((item) => item.versionNo === row.currentVersion);
        return {
          id: row.id,
          title: row.title,
          summary: row.summary,
          industryCode: row.industryCode,
          requiredSkills: [...row.requiredSkills],
          hopeBudgetRange: hopeBudgetRange(row.hopeBudget),
          deadline: row.deadline,
          status: row.status,
          publishedAt: row.publishedAt,
          currentSpecVersion: row.currentVersion,
          specItemCount: current.length,
          specItemTitles: current.map((item) => item.title),
        };
      });
    },
  };
}

export interface AProjectDb {
  readonly application: {
    findMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly include: {
        readonly items: true;
        readonly project: { readonly select: { readonly draft: { readonly select: { readonly clientId: true } } } };
      };
    }): Promise<readonly ApplicationRow[]>;
    updateMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<{ readonly count: number }>;
    count(input: { readonly where: Readonly<Record<string, unknown>> }): Promise<number>;
  };
  readonly eventLog: {
    create(input: { readonly data: Readonly<Record<string, unknown>> }): Promise<unknown>;
    findFirst(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly orderBy: Readonly<Record<string, 'asc' | 'desc'>>;
      readonly select: { readonly occurredAt: true };
    }): Promise<{ readonly occurredAt: Date } | null>;
  };
  readonly notification: NotificationDbClient['notification'];
}

const INCLUDE = {
  items: true,
  project: { select: { draft: { select: { clientId: true } } } },
} as const;

function applicationDelegates(
  tx: AProjectDb,
): Pick<ApplicationTx, 'listByProject' | 'updateStatus' | 'notifications'> {
  return {
    async listByProject(projectId) {
      const rows = await tx.application.findMany({ where: { projectId }, include: INCLUDE });
      return rows.map(toApplicationRevision);
    },
    async updateStatus(input) {
      const result = await tx.application.updateMany({
        where: { id: input.applicationId, status: { in: input.from } },
        data: { status: input.to },
      });
      return result.count > 0;
    },
    notifications: createApplicationNotificationPort(createPrismaNotificationTx(tx)),
  };
}

/** A `ProjectViewPort.recordFirstView` 구현. 상세 열람을 EventLog에 남긴다. */
export function createAProjectViewPort(db: AProjectDb): {
  recordFirstView(input: {
    readonly projectId: string;
    readonly supplierId: string;
    readonly at: Date;
  }): Promise<void>;
} {
  const port: ProjectViewPort = {
    async findFirstViewedAt(input) {
      const row = await db.eventLog.findFirst({
        where: {
          type: 'SPEC_DETAIL_VIEWED',
          projectId: input.projectId,
          userId: input.supplierId,
        },
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
      });
      return row === null ? null : row.occurredAt;
    },
    async recordDetailView(input) {
      await db.eventLog.create({
        data: {
          userId: input.supplierId,
          type: 'SPEC_DETAIL_VIEWED',
          projectId: input.projectId,
          occurredAt: input.viewedAt,
        },
      });
    },
  };

  return {
    async recordFirstView(input) {
      await recordProjectDetailView(port, {
        projectId: input.projectId,
        supplierId: input.supplierId,
        viewedAt: input.at,
      });
    },
  };
}

/** A `ProjectApplicationPort` 구현. A의 명세/삭제 트랜잭션에 참여한다. */
export function createAProjectApplicationPort(db: AProjectDb): {
  countPending(tx: AProjectDb, projectId: string): Promise<number>;
  markSpecStale(
    tx: AProjectDb,
    input: { readonly projectId: string; readonly newVersionNo: number; readonly at: Date },
  ): Promise<number>;
  rejectPendingOnDelete(
    tx: AProjectDb,
    input: { readonly projectId: string; readonly at: Date },
  ): Promise<number>;
} {
  return {
    countPending(tx, projectId) {
      return tx.application.count({
        where: { projectId, status: { in: ['SUBMITTED', 'STALE'] } },
      });
    },

    markSpecStale(tx, input) {
      // ponytail: newVersionNo는 B가 저장하지 않는다. STALE 전환과 재견적 알림만 한다.
      return markApplicationsStaleInTransaction(applicationDelegates(tx), {
        projectId: input.projectId,
        now: input.at,
      });
    },

    async rejectPendingOnDelete(tx, input) {
      const result = await tx.application.updateMany({
        where: {
          projectId: input.projectId,
          status: { in: ['SUBMITTED', 'STALE'] },
        },
        data: { status: 'REJECTED' },
      });
      return result.count;
    },
  };
}
