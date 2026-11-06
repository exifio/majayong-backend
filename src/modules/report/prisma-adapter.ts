/**
 * B-07: 신고 Port의 Prisma 어댑터.
 *
 * 계정 제재(`applyAccountAction`)는 A 소유 User 쓰기이므로 주입받는다.
 * 신고 알림/이벤트는 같은 트랜잭션의 Notification/EventLog delegate로 남긴다.
 */
import {
  createNotificationOnceInTransaction,
  type NotificationTx,
} from '../notification/notifications.js';
import type {
  MyReportQueryPort,
  ReportActor,
  ReportAdminRecord,
  ReportReason,
  ReportRecord,
  ReportStatus,
  ReportUnitOfWork,
  ReportTx,
} from './reports.js';

export interface ReportRow {
  readonly id: string;
  readonly messageId: string;
  readonly reporterId: string;
  readonly targetUserId: string;
  readonly reason: ReportReason;
  readonly detail: string | null;
  readonly status: ReportStatus;
  readonly action: 'NONE' | 'WARNING' | 'CHAT_RESTRICT_7D' | 'SUSPEND' | null;
  readonly actionNote: string | null;
  readonly resolvedById: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  /** 관리자 목록 조회에서만 join으로 채운다. */
  readonly reporter?: ReportUserRow;
  readonly targetUser?: ReportUserRow;
  readonly message?: ReportContextMessageRow;
}

export interface ReportUserRow {
  readonly id: string;
  readonly role: 'CLIENT' | 'SUPPLIER' | 'ADMIN';
  readonly name: string | null;
  readonly clientProfile: { readonly businessName: string | null } | null;
  readonly supplierProfile: { readonly displayName: string } | null;
}

export interface ReportContextMessageRow {
  readonly body: string;
  readonly createdAt: Date;
  readonly application: {
    readonly project: { readonly id: string; readonly title: string };
  };
}

export interface ReportableMessageRow {
  readonly id: string;
  readonly senderId: string | null;
  readonly application: {
    readonly supplierId: string;
    readonly project: { readonly draft: { readonly clientId: string } };
  };
}

export interface ReportDbClient {
  readonly applicationMessage: {
    findUnique(input: {
      readonly where: { readonly id: string };
      readonly include: {
        readonly application: {
          readonly select: {
            readonly supplierId: true;
            readonly project: {
              readonly select: { readonly draft: { readonly select: { readonly clientId: true } } };
            };
          };
        };
      };
    }): Promise<ReportableMessageRow | null>;
  };
  readonly report: {
    findFirst(input: {
      readonly where: Readonly<Record<string, unknown>>;
    }): Promise<ReportRow | null>;
    findMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly orderBy?: readonly Readonly<Record<string, 'asc' | 'desc'>>[];
      readonly include?: unknown;
    }): Promise<readonly ReportRow[]>;
    findUnique(input: {
      readonly where: { readonly id: string };
    }): Promise<ReportRow | null>;
    create(input: { readonly data: Readonly<Record<string, unknown>> }): Promise<ReportRow>;
    update(input: {
      readonly where: { readonly id: string };
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<ReportRow>;
    count(input: { readonly where: Readonly<Record<string, unknown>> }): Promise<number>;
  };
  readonly eventLog: {
    create(input: { readonly data: Readonly<Record<string, unknown>> }): Promise<unknown>;
  };
  readonly notification: NotificationTx;
  readonly user?: {
    updateMany(input: { readonly where: Readonly<Record<string, unknown>>; readonly data: Readonly<Record<string, unknown>> }): Promise<{ readonly count: number }>;
  };
}

export interface ReportPrismaClient extends ReportDbClient {
  $transaction<T>(work: (tx: ReportDbClient) => Promise<T>): Promise<T>;
}

export interface ReportAccountActionPort {
  applyAccountAction(input: {
    readonly userId: string;
    readonly action: 'CHAT_RESTRICT_7D' | 'SUSPEND';
    readonly at: Date;
    readonly until: Date | null;
  }, tx?: { readonly user: NonNullable<ReportDbClient['user']> }): Promise<void>;
}

function toRecord(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    messageId: row.messageId,
    reporterId: row.reporterId,
    targetUserId: row.targetUserId,
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    action: row.action,
    actionNote: row.actionNote,
    resolvedById: row.resolvedById,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

function displayNameOf(user: ReportUserRow): string | null {
  if (user.role === 'CLIENT') return user.clientProfile?.businessName ?? user.name;
  if (user.role === 'SUPPLIER') return user.supplierProfile?.displayName ?? user.name;
  return user.name;
}

function toAdminRecord(row: ReportRow): ReportAdminRecord {
  const { reporter, targetUser, message } = row;
  if (reporter === undefined || targetUser === undefined || message === undefined) {
    throw new Error('Report admin list row is missing joined reporter, target or message context');
  }
  return {
    ...toRecord(row),
    reporter: { id: reporter.id, role: reporter.role, displayName: displayNameOf(reporter) },
    target: { id: targetUser.id, role: targetUser.role, displayName: displayNameOf(targetUser) },
    message: {
      body: message.body,
      createdAt: message.createdAt,
      projectId: message.application.project.id,
      projectTitle: message.application.project.title,
    },
  };
}

const REPORT_USER_INCLUDE = {
  select: {
    id: true,
    role: true,
    name: true,
    clientProfile: { select: { businessName: true } },
    supplierProfile: { select: { displayName: true } },
  },
} as const;

const REPORT_ADMIN_INCLUDE = {
  reporter: REPORT_USER_INCLUDE,
  targetUser: REPORT_USER_INCLUDE,
  message: {
    select: {
      body: true,
      createdAt: true,
      application: { select: { project: { select: { id: true, title: true } } } },
    },
  },
} as const;

export function createReportTx(
  db: ReportDbClient,
  accounts: ReportAccountActionPort,
  now: () => Date,
): ReportTx {
  return {
    async findReportableMessage(messageId) {
      const row = await db.applicationMessage.findUnique({
        where: { id: messageId },
        include: {
          application: {
            select: {
              supplierId: true,
              project: { select: { draft: { select: { clientId: true } } } },
            },
          },
        },
      });
      if (row === null) return null;
      return {
        id: row.id,
        senderId: row.senderId,
        participantIds: [row.application.project.draft.clientId, row.application.supplierId],
      };
    },

    async findOpenReport(input) {
      const row = await db.report.findFirst({
        where: { messageId: input.messageId, reporterId: input.reporterId, status: 'OPEN' },
      });
      return row === null ? null : toRecord(row);
    },

    async createReport(input) {
      return toRecord(
        await db.report.create({
          data: {
            messageId: input.messageId,
            reporterId: input.reporterId,
            targetUserId: input.targetUserId,
            reason: input.reason,
            detail: input.detail,
            createdAt: input.createdAt,
          },
        }),
      );
    },

    async listReports(input) {
      const rows = await db.report.findMany({
        where: input.status === undefined ? {} : { status: input.status },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: REPORT_ADMIN_INCLUDE,
      });
      return rows.map(toAdminRecord);
    },

    async findReport(reportId) {
      const row = await db.report.findUnique({ where: { id: reportId } });
      return row === null ? null : toRecord(row);
    },

    findWarningCount(targetUserId) {
      return db.report.count({ where: { targetUserId, action: 'WARNING' } });
    },

    async resolveReport(input) {
      const exists = await db.report.findUnique({ where: { id: input.reportId } });
      if (exists === null) return null;
      return toRecord(
        await db.report.update({
          where: { id: input.reportId },
          data: {
            status: 'RESOLVED',
            action: input.action,
            actionNote: input.actionNote,
            resolvedById: input.resolvedById,
            resolvedAt: input.resolvedAt,
          },
        }),
      );
    },

    applyAccountAction(input) {
      if (db.user === undefined) throw new Error('Report account action database delegate is missing');
      return accounts.applyAccountAction(input, { user: db.user });
    },

    async notifyReporter(input) {
      await createNotificationOnceInTransaction(db.notification, {
        userId: input.userId,
        type: 'REPORT_REVIEWED',
        targetId: input.reportId,
        now: now(),
      });
    },

    async logEvent(input) {
      await db.eventLog.create({
        data: {
          userId: input.userId,
          type: input.type,
          payload: input.payload,
        },
      });
    },
  };
}

export function createPrismaReportUnitOfWork(
  prisma: ReportPrismaClient,
  accounts: ReportAccountActionPort,
  now: () => Date,
): ReportUnitOfWork {
  return {
    run<T>(work: (tx: ReportTx) => Promise<T>): Promise<T> {
      return prisma.$transaction((tx) => work(createReportTx(tx, accounts, now)));
    },
  };
}

export function createPrismaMyReportQueryPort(db: ReportDbClient): MyReportQueryPort {
  return {
    async listByReporter(input) {
      const rows = await db.report.findMany({
        where:
          input.status === undefined
            ? { reporterId: input.reporterId }
            : { reporterId: input.reporterId, status: input.status },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      return rows.map(toRecord);
    },
  };
}

export type { ReportActor };
