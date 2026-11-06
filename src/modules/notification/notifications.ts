/**
 * B-06: 인앱 알림 15종, 최근 30일 폴링·읽음, 방별 새 메시지 묶음, 기한 알림 멱등.
 *
 * - `targetUrl`은 타입별 고정 경로로만 만든다. 호출자가 URL을 넘기지 않는다.
 * - `(userId, type, targetId)`가 같으면 새 행을 만들지 않는다.
 *   기한 알림은 최초 1회만, `NEW_MESSAGE`는 방 단위 한 줄을 최신 시각으로 갱신한다.
 * - 결제 완료·납품·검수 결과·지급은 알림이 아니라 '내 계약' 상태로 보여 준다.
 */
import type { ChatNotificationPort } from '../chat/conversation.js';
export const NOTIFICATION_TYPES = [
  'APPLICATION_RECEIVED',
  'APPLICATION_ACCEPTED',
  'APPLICATION_AUTO_REJECTED',
  'APPLICATION_REJECTED',
  'PROJECT_CLOSED',
  'REQUOTE_REQUESTED',
  'NEW_MESSAGE',
  'CONTRACT_BROKEN',
  'DEPOSIT_DUE',
  'INSPECTION_DUE',
  'WORK_DUE',
  'WORK_OVERDUE',
  'AUTO_APPROVED',
  'REPORT_REVIEWED',
  'INQUIRY_ANSWERED',
] as const;

/** C-04 계약형 createOnce(tx, ...) 포트와 호환되는 enum guard. */
export function isNotificationType(value: unknown): value is NotificationType {
  return NOTIFICATION_TYPES.some((type) => type === value);
}

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** 기한 안내 5종. `(userId, type, targetId)`당 한 번만 만든다. */
export const DEADLINE_NOTIFICATION_TYPES = [
  'DEPOSIT_DUE',
  'INSPECTION_DUE',
  'WORK_DUE',
  'WORK_OVERDUE',
  'AUTO_APPROVED',
] as const;

export type DeadlineNotificationType = (typeof DEADLINE_NOTIFICATION_TYPES)[number];

const DUE_AT_TYPES: readonly DeadlineNotificationType[] = [
  'DEPOSIT_DUE',
  'INSPECTION_DUE',
  'WORK_DUE',
  'WORK_OVERDUE',
];

const BREAK_REASONS = [
  'CONSENT_TIMEOUT',
  'SIGN_REFUSED',
  'CLIENT_CANCELLED',
  'DEPOSIT_TIMEOUT',
] as const;

const MATCHING_TYPES: readonly NotificationType[] = [
  'APPLICATION_RECEIVED',
  'APPLICATION_ACCEPTED',
  'APPLICATION_AUTO_REJECTED',
  'APPLICATION_REJECTED',
  'PROJECT_CLOSED',
  'REQUOTE_REQUESTED',
  'NEW_MESSAGE',
  'CONTRACT_BROKEN',
];

const OPS_TYPES: readonly NotificationType[] = ['REPORT_REVIEWED', 'INQUIRY_ANSWERED'];

export const NOTIFICATION_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAFE_TARGET = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

export class NotificationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'NotificationError';
    this.status = status;
    this.code = code;
  }
}

/** DB unique 위반을 도메인 재조회 경로로 바꿀 때 쓴다. */
export class NotificationUniqueViolation extends Error {
  constructor() {
    super('notification unique violation');
    this.name = 'NotificationUniqueViolation';
  }
}

export interface NotificationRecord {
  readonly id: string;
  readonly userId: string;
  readonly type: NotificationType;
  readonly targetUrl: string;
  readonly targetId: string;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly isRead: boolean;
  readonly createdAt: Date;
}

export interface NewNotification {
  readonly userId: string;
  readonly type: NotificationType;
  readonly targetUrl: string;
  readonly targetId: string;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly createdAt: Date;
}

export interface NotificationTx {
  findByKey(input: {
    readonly userId: string;
    readonly type: NotificationType;
    readonly targetId: string;
  }): Promise<NotificationRecord | null>;
  create(input: NewNotification): Promise<NotificationRecord>;
  refreshBundled(input: {
    readonly id: string;
    readonly createdAt: Date;
  }): Promise<NotificationRecord>;
  listRecent(input: {
    readonly userId: string;
    readonly since: Date;
    readonly now: Date;
    readonly unreadOnly: boolean;
  }): Promise<readonly NotificationRecord[]>;
  countUnread(input: {
    readonly userId: string;
    readonly since: Date;
    readonly now: Date;
  }): Promise<number>;
  markRead(input: {
    readonly notificationId: string;
    readonly userId: string;
    readonly now: Date;
  }): Promise<boolean>;
  markAllRead(input: {
    readonly userId: string;
    readonly since: Date;
    readonly now: Date;
  }): Promise<number>;
}

export interface NotificationUnitOfWork {
  run<T>(work: (tx: NotificationTx) => Promise<T>): Promise<T>;
}

export interface NotificationParties {
  readonly clientUserId: string;
  readonly supplierUserId: string;
  readonly senderId?: string | null;
  readonly reporterUserId?: string | null;
  readonly inquiryAuthorUserId?: string | null;
}

export interface NotificationList {
  readonly items: readonly NotificationRecord[];
  readonly unreadCount: number;
}

function invalid(code: string, message: string): NotificationError {
  return new NotificationError(400, code, message);
}

export function isDeadlineNotificationType(
  value: NotificationType,
): value is DeadlineNotificationType {
  return DEADLINE_NOTIFICATION_TYPES.some((type) => type === value);
}

function requireIdentifier(value: string, code: string): string {
  if (value.trim().length === 0) {
    throw invalid(code, '알림 대상 식별자가 비어 있습니다.');
  }
  if (!SAFE_TARGET.test(value)) {
    throw invalid(code, '알림 대상 식별자에 허용되지 않는 문자가 있습니다.');
  }
  return value;
}

function normalizePayload(
  type: NotificationType,
  payload: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | null {
  if (payload === undefined) {
    if (
      type === 'CONTRACT_BROKEN' ||
      DUE_AT_TYPES.some((candidate) => candidate === type)
    ) {
      throw invalid('INVALID_PAYLOAD', '알림에 필요한 값이 없습니다.');
    }
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw invalid('INVALID_PAYLOAD', '알림 payload는 객체여야 합니다.');
  }

  if (type === 'CONTRACT_BROKEN') {
    const reason = payload.reason;
    if (!BREAK_REASONS.some((candidate) => candidate === reason)) {
      throw invalid('INVALID_PAYLOAD', '결렬 사유가 올바르지 않습니다.');
    }
  }

  if (DUE_AT_TYPES.some((candidate) => candidate === type)) {
    const dueAt = payload.dueAt;
    if (typeof dueAt !== 'string' || Number.isNaN(Date.parse(dueAt))) {
      throw invalid('INVALID_PAYLOAD', '기한 알림에는 유효한 dueAt이 필요합니다.');
    }
  }

  return { ...payload };
}

/** 타입별 고정 경로. support 어댑터처럼 알림을 직접 쓰는 곳도 같은 URL을 쓰도록 공개한다. */
export function notificationTargetUrl(type: NotificationType, targetId: string): string {
  switch (type) {
    case 'APPLICATION_RECEIVED':
      return `/projects/${targetId}/applications`;
    case 'APPLICATION_ACCEPTED':
      return `/contracts/${targetId}/sign`;
    case 'APPLICATION_AUTO_REJECTED':
    case 'APPLICATION_REJECTED':
    case 'REQUOTE_REQUESTED':
      return `/applications/${targetId}`;
    case 'PROJECT_CLOSED':
      return `/projects/${targetId}`;
    case 'NEW_MESSAGE':
      return `/chat/${targetId}`;
    case 'CONTRACT_BROKEN':
      return `/contracts/${targetId}`;
    case 'DEPOSIT_DUE':
      return `/contracts/${targetId}/deposit`;
    case 'INSPECTION_DUE':
      return `/contracts/${targetId}/inspection`;
    case 'WORK_DUE':
    case 'WORK_OVERDUE':
      return `/contracts/${targetId}/delivery`;
    case 'AUTO_APPROVED':
      return `/contracts/${targetId}/settlement`;
    case 'REPORT_REVIEWED':
      return `/reports/${targetId}`;
    case 'INQUIRY_ANSWERED':
      return `/help/inquiry?tab=my&id=${targetId}`;
  }
}

function requirePartyId(value: string | null | undefined, code: string): string {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw invalid(code, '알림 수신자를 확인할 수 없습니다.');
  }
  return value;
}

/** 역할별 수신자. 새 메시지는 보낸 사람을 뺀 나머지 한 명에게만 간다. */
export function recipientsFor(
  type: NotificationType,
  parties: NotificationParties,
): readonly string[] {
  let recipients: readonly string[];

  switch (type) {
    case 'APPLICATION_RECEIVED':
      recipients = [parties.clientUserId];
      break;
    case 'APPLICATION_ACCEPTED':
    case 'APPLICATION_AUTO_REJECTED':
    case 'APPLICATION_REJECTED':
    case 'REQUOTE_REQUESTED':
      recipients = [parties.supplierUserId];
      break;
    case 'PROJECT_CLOSED':
    case 'CONTRACT_BROKEN':
      recipients = [parties.clientUserId, parties.supplierUserId];
      break;
    case 'NEW_MESSAGE':
      recipients = [parties.clientUserId, parties.supplierUserId].filter(
        (userId) => userId !== parties.senderId,
      );
      break;
    case 'DEPOSIT_DUE':
    case 'INSPECTION_DUE':
      recipients = [parties.clientUserId];
      break;
    case 'WORK_DUE':
    case 'WORK_OVERDUE':
    case 'AUTO_APPROVED':
      recipients = [parties.clientUserId, parties.supplierUserId];
      break;
    case 'REPORT_REVIEWED':
      recipients = [
        requirePartyId(parties.reporterUserId, 'INVALID_RECIPIENT_CONTEXT'),
      ];
      break;
    case 'INQUIRY_ANSWERED':
      recipients = [
        requirePartyId(parties.inquiryAuthorUserId, 'INVALID_RECIPIENT_CONTEXT'),
      ];
      break;
  }

  return [...new Set(recipients.filter((userId) => userId.trim().length > 0))];
}

export function chatRoomTargetId(projectId: string, supplierId: string): string {
  requireIdentifier(projectId, 'INVALID_TARGET');
  requireIdentifier(supplierId, 'INVALID_TARGET');
  return `${projectId}:${supplierId}`;
}

function refreshOrKeep(
  tx: NotificationTx,
  existing: NotificationRecord,
  input: {
    readonly type: NotificationType;
    readonly now: Date;
  },
): Promise<NotificationRecord> {
  if (input.type === 'NEW_MESSAGE') {
    return tx.refreshBundled({ id: existing.id, createdAt: input.now });
  }
  return Promise.resolve(existing);
}

async function deliver(
  tx: NotificationTx,
  input: {
    readonly userId: string;
    readonly type: NotificationType;
    readonly targetId: string;
    readonly payload: Readonly<Record<string, unknown>> | null;
    readonly now: Date;
  },
): Promise<NotificationRecord> {
  const existing = await tx.findByKey({
    userId: input.userId,
    type: input.type,
    targetId: input.targetId,
  });
  if (existing !== null) return refreshOrKeep(tx, existing, input);

  try {
    return await tx.create({
      userId: input.userId,
      type: input.type,
      targetUrl: notificationTargetUrl(input.type, input.targetId),
      targetId: input.targetId,
      payload: input.payload,
      createdAt: input.now,
    });
  } catch (error) {
    if (!(error instanceof NotificationUniqueViolation)) throw error;

    // 다른 요청이 먼저 만들었다. 경쟁에서 진 쪽은 기존 행을 갱신/유지한다.
    const raced = await tx.findByKey({
      userId: input.userId,
      type: input.type,
      targetId: input.targetId,
    });
    if (raced === null) throw error;
    return refreshOrKeep(tx, raced, input);
  }
}

/** C/통합이 전달한 트랜잭션에 참여하는 1회성 기한 알림 Port. */
export async function createNotificationOnceInTransaction(
  tx: NotificationTx,
  input: {
    readonly userId: string;
    readonly type: string;
    readonly targetId: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly now: Date;
  },
): Promise<{ readonly created: boolean }> {
  if (!isNotificationType(input.type)) {
    throw invalid('UNKNOWN_NOTIFICATION_TYPE', '알 수 없는 알림 타입입니다.');
  }
  const userId = requireIdentifier(input.userId, 'INVALID_TARGET');
  const targetId = requireIdentifier(input.targetId, 'INVALID_TARGET');
  const payload = normalizePayload(input.type, input.payload);

  const existing = await tx.findByKey({ userId, type: input.type, targetId });
  if (existing !== null) return { created: false };

  try {
    await tx.create({
      userId,
      type: input.type,
      targetUrl: notificationTargetUrl(input.type, targetId),
      targetId,
      payload,
      createdAt: input.now,
    });
  } catch (error) {
    if (!(error instanceof NotificationUniqueViolation)) throw error;
    const raced = await tx.findByKey({ userId, type: input.type, targetId });
    if (raced === null) throw error;
    return { created: false };
  }
  return { created: true };
}

export async function notify(
  uow: NotificationUnitOfWork,
  input: {
    readonly type: NotificationType;
    readonly userId: string;
    readonly targetId: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly now: Date;
  },
): Promise<NotificationRecord> {
  if (!isNotificationType(input.type)) {
    throw invalid('UNKNOWN_NOTIFICATION_TYPE', '알 수 없는 알림 타입입니다.');
  }
  const userId = requireIdentifier(input.userId, 'INVALID_TARGET');
  const targetId = requireIdentifier(input.targetId, 'INVALID_TARGET');
  const payload = normalizePayload(input.type, input.payload);

  return uow.run((tx) =>
    deliver(tx, { userId, type: input.type, targetId, payload, now: input.now }),
  );
}

export function notifyRecipients(
  uow: NotificationUnitOfWork,
  input: {
    readonly type: NotificationType;
    readonly parties: NotificationParties;
    readonly targetId: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly now: Date;
  },
): Promise<readonly NotificationRecord[]> {
  return uow.run((tx) => notifyRecipientsInTransaction(tx, input));
}

/** Existing owner transaction version; callers keep notification writes atomic with their work. */
export async function notifyRecipientsInTransaction(
  tx: NotificationTx,
  input: {
    readonly type: NotificationType;
    readonly parties: NotificationParties;
    readonly targetId: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly now: Date;
  },
): Promise<readonly NotificationRecord[]> {
  if (!isNotificationType(input.type)) {
    throw invalid('UNKNOWN_NOTIFICATION_TYPE', '알 수 없는 알림 타입입니다.');
  }
  const targetId = requireIdentifier(input.targetId, 'INVALID_TARGET');
  const payload = normalizePayload(input.type, input.payload);
  const recipients = recipientsFor(input.type, input.parties);
  const created: NotificationRecord[] = [];
  for (const userId of recipients) {
    created.push(
      await deliver(tx, { userId, type: input.type, targetId, payload, now: input.now }),
    );
  }
  return created;
}

export async function notifyNewMessage(
  uow: NotificationUnitOfWork,
  input: {
    readonly projectId: string;
    readonly supplierId: string;
    readonly clientUserId: string;
    readonly supplierUserId: string;
    readonly senderId: string;
    readonly now: Date;
  },
): Promise<readonly NotificationRecord[]> {
  return notifyRecipients(uow, {
    type: 'NEW_MESSAGE',
    parties: {
      clientUserId: input.clientUserId,
      supplierUserId: input.supplierUserId,
      senderId: input.senderId,
    },
    targetId: chatRoomTargetId(input.projectId, input.supplierId),
    now: input.now,
  });
}

/** B-03 채팅 발신에 B-06의 방별 묶음 알림을 붙이는 어댑터. */
export function createChatNotificationPort(
  uow: NotificationUnitOfWork,
): ChatNotificationPort {
  return {
    async notifyNewMessage(input) {
      await notifyNewMessage(uow, input);
    },
  };
}

/** C가 보내는 계약 이후 이벤트 중 알림을 만드는 것은 기한 5종뿐이다. */
export async function notifyFromContractEvent(
  uow: NotificationUnitOfWork,
  input: {
    readonly eventType: string;
    readonly contractId: string;
    readonly parties: NotificationParties;
    readonly dueAt?: Date;
    readonly now: Date;
  },
): Promise<readonly NotificationRecord[]> {
  if (!isContractEventNotificationType(input.eventType)) return [];

  const payload =
    input.eventType === 'AUTO_APPROVED'
      ? undefined
      : { dueAt: requireDueAt(input.dueAt).toISOString() };

  return notifyRecipients(uow, {
    type: input.eventType,
    parties: input.parties,
    targetId: input.contractId,
    payload,
    now: input.now,
  });
}

function isContractEventNotificationType(
  value: string,
): value is DeadlineNotificationType {
  return DEADLINE_NOTIFICATION_TYPES.some((type) => type === value);
}

function requireDueAt(dueAt: Date | undefined): Date {
  if (dueAt === undefined || Number.isNaN(dueAt.getTime())) {
    throw invalid('INVALID_PAYLOAD', '기한 이벤트에는 유효한 dueAt이 필요합니다.');
  }
  return dueAt;
}

export async function listNotifications(
  uow: NotificationUnitOfWork,
  input: {
    readonly userId: string;
    readonly now: Date;
    readonly unreadOnly?: boolean;
  },
): Promise<NotificationList> {
  const userId = requireIdentifier(input.userId, 'INVALID_TARGET');
  const since = new Date(input.now.getTime() - NOTIFICATION_WINDOW_DAYS * DAY_MS);

  return uow.run(async (tx) => {
    const items = await tx.listRecent({
      userId,
      since,
      now: input.now,
      unreadOnly: input.unreadOnly === true,
    });
    const unreadCount = await tx.countUnread({ userId, since, now: input.now });
    return { items, unreadCount };
  });
}

export async function markNotificationRead(
  uow: NotificationUnitOfWork,
  input: {
    readonly notificationId: string;
    readonly userId: string;
    readonly now: Date;
  },
): Promise<void> {
  const notificationId = requireIdentifier(input.notificationId, 'INVALID_TARGET');
  const userId = requireIdentifier(input.userId, 'INVALID_TARGET');

  await uow.run(async (tx) => {
    const changed = await tx.markRead({ notificationId, userId, now: input.now });
    if (!changed) {
      throw new NotificationError(404, 'NOTIFICATION_NOT_FOUND', '알림을 찾을 수 없습니다.');
    }
  });
}

export async function markAllNotificationsRead(
  uow: NotificationUnitOfWork,
  input: { readonly userId: string; readonly now: Date },
): Promise<number> {
  const userId = requireIdentifier(input.userId, 'INVALID_TARGET');
  const since = new Date(input.now.getTime() - NOTIFICATION_WINDOW_DAYS * DAY_MS);

  return uow.run((tx) => tx.markAllRead({ userId, since, now: input.now }));
}

export const NOTIFICATION_CATEGORIES = {
  matching: MATCHING_TYPES,
  deadline: DEADLINE_NOTIFICATION_TYPES,
  operations: OPS_TYPES,
} as const;
