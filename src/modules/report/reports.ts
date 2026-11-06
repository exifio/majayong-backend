/** B-07: 신고 접수·운영자 판정. 파일/HTTP/계정 저장은 Port 뒤에 둔다. */
export const REPORT_REASONS = ['CONTACT_OR_OFFSITE', 'ABUSE', 'FALSE_INFO', 'OTHER'] as const;
export const REPORT_ACTIONS = ['NONE', 'WARNING', 'CHAT_RESTRICT_7D', 'SUSPEND'] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportAction = (typeof REPORT_ACTIONS)[number];
export type ReportStatus = 'OPEN' | 'RESOLVED';

export interface ReportRecord {
  readonly id: string;
  readonly messageId: string;
  readonly reporterId: string;
  readonly targetUserId: string;
  readonly reason: ReportReason;
  readonly detail: string | null;
  readonly status: ReportStatus;
  readonly action: ReportAction | null;
  readonly actionNote: string | null;
  readonly resolvedById: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
}

/** 관리자 목록에서 신고자·대상·메시지 문맥을 함께 보여 주기 위한 값. */
export interface ReportParty {
  readonly id: string;
  readonly role: 'CLIENT' | 'SUPPLIER' | 'ADMIN';
  readonly displayName: string | null;
}

export interface ReportMessageContext {
  readonly body: string;
  readonly createdAt: Date;
  readonly projectId: string;
  readonly projectTitle: string;
}

/** `GET /admin/reports` 전용. 일반 신고 기록에 운영자 판단에 필요한 문맥을 더한다. */
export interface ReportAdminRecord extends ReportRecord {
  readonly reporter: ReportParty;
  readonly target: ReportParty;
  readonly message: ReportMessageContext;
}

export interface ReportTx {
  findReportableMessage(messageId: string): Promise<{
    readonly id: string;
    readonly senderId: string | null;
    readonly participantIds: readonly string[];
  } | null>;
  findOpenReport(input: { readonly messageId: string; readonly reporterId: string }): Promise<ReportRecord | null>;
  createReport(input: {
    readonly messageId: string;
    readonly reporterId: string;
    readonly targetUserId: string;
    readonly reason: ReportReason;
    readonly detail: string | null;
    readonly createdAt: Date;
  }): Promise<ReportRecord>;
  listReports(input: { readonly status?: ReportStatus }): Promise<readonly ReportAdminRecord[]>;
  findReport(reportId: string): Promise<ReportRecord | null>;
  findWarningCount(targetUserId: string): Promise<number>;
  resolveReport(input: {
    readonly reportId: string;
    readonly resolvedById: string;
    readonly action: ReportAction;
    readonly actionNote: string;
    readonly resolvedAt: Date;
  }): Promise<ReportRecord | null>;
  applyAccountAction(input: {
    readonly userId: string;
    readonly action: 'CHAT_RESTRICT_7D' | 'SUSPEND';
    readonly at: Date;
    readonly until: Date | null;
  }): Promise<void>;
  notifyReporter(input: { readonly userId: string; readonly reportId: string }): Promise<void>;
  logEvent(input: {
    readonly userId: string;
    readonly type: 'REPORT_SUBMITTED' | 'REPORT_RESOLVED';
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

export interface ReportUnitOfWork {
  run<T>(work: (tx: ReportTx) => Promise<T>): Promise<T>;
}

export class ReportError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ReportError';
    this.status = status;
    this.code = code;
  }
}

export class OpenReportUniqueViolation extends Error {
  constructor() {
    super('report_one_open_per_reporter violation');
    this.name = 'OpenReportUniqueViolation';
  }
}

export interface ReportActor {
  readonly userId: string;
  readonly role: 'CLIENT' | 'SUPPLIER' | 'ADMIN';
}

export interface SubmitReportInput {
  readonly actor: ReportActor;
  readonly messageId: string;
  readonly reason: ReportReason;
  readonly detail?: string;
  readonly now: Date;
}

export interface ResolveReportInput {
  readonly actor: ReportActor;
  readonly reportId: string;
  readonly action: ReportAction;
  readonly actionNote: string;
  readonly now: Date;
}

export interface ResolveReportResult {
  readonly report: ReportRecord;
  readonly warningReviewRecommended: boolean;
}

/** `GET /me/reports` 조회 Port. 신고자 본인 것만 돌려준다. */
export interface MyReportQueryPort {
  listByReporter(input: {
    readonly reporterId: string;
    readonly status?: ReportStatus;
  }): Promise<readonly ReportRecord[]>;
}

export async function listMyReports(
  port: MyReportQueryPort,
  input: { readonly actor: ReportActor; readonly status?: ReportStatus },
): Promise<readonly ReportRecord[]> {
  const rows = await port.listByReporter({
    reporterId: input.actor.userId,
    status: input.status,
  });
  return [...rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

export function submitReport(uow: ReportUnitOfWork, input: SubmitReportInput): Promise<ReportRecord> {
  return submitReportImpl(uow, input);
}

export function listReports(
  _uow: ReportUnitOfWork,
  _input: { readonly actor: ReportActor; readonly status?: ReportStatus },
): Promise<readonly ReportAdminRecord[]> {
  if (_input.actor.role !== 'ADMIN') {
    return Promise.reject(new ReportError(403, 'ADMIN_ONLY', '운영자만 신고 목록을 볼 수 있습니다.'));
  }
  return _uow.run((tx) => tx.listReports({ status: _input.status }));
}

export function resolveReport(uow: ReportUnitOfWork, input: ResolveReportInput): Promise<ResolveReportResult> {
  return resolveReportImpl(uow, input);
}

function invalid(code: string, message: string): ReportError {
  return new ReportError(400, code, message);
}

function validReason(value: unknown): value is ReportReason {
  return REPORT_REASONS.some((reason) => reason === value);
}

function validAction(value: unknown): value is ReportAction {
  return REPORT_ACTIONS.some((action) => action === value);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function submitReportImpl(uow: ReportUnitOfWork, input: SubmitReportInput): Promise<ReportRecord> {
  if (input.actor.role === 'ADMIN' || input.actor.userId.trim().length === 0) {
    throw new ReportError(403, 'REPORT_NOT_ALLOWED', '이 계정은 메시지를 신고할 수 없습니다.');
  }
  if (!validReason(input.reason)) throw invalid('INVALID_REPORT_REASON', '신고 사유가 올바르지 않습니다.');
  const detail = input.detail?.trim() ?? '';
  if (input.detail !== undefined && detail.length === 0) throw invalid('INVALID_REPORT_DETAIL', '설명을 입력하거나 비워 두세요.');

  return uow.run(async (tx) => {
    const message = await tx.findReportableMessage(input.messageId);
    if (message === null || !message.participantIds.includes(input.actor.userId)) {
      throw new ReportError(404, 'REPORT_TARGET_NOT_FOUND', '신고할 메시지를 찾을 수 없습니다.');
    }
    if (message.senderId === null || message.senderId === input.actor.userId) {
      throw invalid('REPORT_SELF_OR_SYSTEM_MESSAGE', '본인 또는 시스템 메시지는 신고할 수 없습니다.');
    }
    if (await tx.findOpenReport({ messageId: message.id, reporterId: input.actor.userId })) {
      throw new ReportError(409, 'REPORT_ALREADY_OPEN', '이미 처리 중인 신고가 있습니다.');
    }
    try {
      const report = await tx.createReport({
        messageId: message.id, reporterId: input.actor.userId, targetUserId: message.senderId,
        reason: input.reason, detail: detail.length === 0 ? null : detail, createdAt: input.now,
      });
      await tx.logEvent({
        userId: input.actor.userId, type: 'REPORT_SUBMITTED',
        payload: { reportId: report.id, messageId: report.messageId, reason: report.reason },
      });
      return report;
    } catch (error) {
      if (error instanceof OpenReportUniqueViolation) {
        throw new ReportError(409, 'REPORT_ALREADY_OPEN', '이미 처리 중인 신고가 있습니다.');
      }
      throw error;
    }
  });
}

async function resolveReportImpl(uow: ReportUnitOfWork, input: ResolveReportInput): Promise<ResolveReportResult> {
  if (input.actor.role !== 'ADMIN') throw new ReportError(403, 'ADMIN_ONLY', '운영자만 신고를 처리할 수 있습니다.');
  if (!validAction(input.action)) throw invalid('INVALID_REPORT_ACTION', '신고 조치가 올바르지 않습니다.');
  const actionNote = input.actionNote.trim();
  if (actionNote.length === 0) throw invalid('ACTION_NOTE_REQUIRED', '조치 사유를 입력해 주세요.');

  return uow.run(async (tx) => {
    const report = await tx.findReport(input.reportId);
    if (report === null) throw new ReportError(404, 'REPORT_NOT_FOUND', '신고를 찾을 수 없습니다.');
    if (report.status !== 'OPEN') throw new ReportError(409, 'REPORT_ALREADY_RESOLVED', '이미 처리된 신고입니다.');
    const warningsBefore = await tx.findWarningCount(report.targetUserId);
    const resolved = await tx.resolveReport({
      reportId: report.id, resolvedById: input.actor.userId, action: input.action,
      actionNote, resolvedAt: input.now,
    });
    if (resolved === null) throw new ReportError(409, 'REPORT_STATE_CHANGED', '신고 상태가 변경되었습니다.');

    if (input.action === 'CHAT_RESTRICT_7D' || input.action === 'SUSPEND') {
      await tx.applyAccountAction({
        userId: report.targetUserId, action: input.action, at: input.now,
        until: input.action === 'CHAT_RESTRICT_7D' ? new Date(input.now.getTime() + SEVEN_DAYS_MS) : null,
      });
    }
    const warningReviewRecommended = input.action === 'WARNING' && warningsBefore + 1 >= 2;
    await tx.notifyReporter({ userId: report.reporterId, reportId: report.id });
    await tx.logEvent({
      userId: input.actor.userId, type: 'REPORT_RESOLVED',
      payload: { reportId: report.id, action: input.action, warningReviewRecommended },
    });
    return { report: resolved, warningReviewRecommended };
  });
}
