import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TYPES,
  NotificationError,
  NotificationUniqueViolation,
  chatRoomTargetId,
  createChatNotificationPort,
  createNotificationOnceInTransaction,
  isDeadlineNotificationType,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notify,
  notifyFromContractEvent,
  notifyNewMessage,
  recipientsFor,
  type NewNotification,
  type NotificationParties,
  type NotificationRecord,
  type NotificationTx,
  type NotificationType,
  type NotificationUnitOfWork,
} from './notifications.ts';
import { FIXED_NOW } from '../../../tests/b/fixtures.ts';
import { createNotificationBridge } from './c-bridge.ts';
import {
  createPrismaNotificationUnitOfWork,
  type NotificationDbRow,
  type NotificationDelegate,
  type NotificationPrismaClient,
  type NotificationWhere,
} from './prisma-adapter.ts';

const CLIENT = 'client-1';
const SUPPLIER = 'supplier-1';

const PARTIES: NotificationParties = {
  clientUserId: CLIENT,
  supplierUserId: SUPPLIER,
  reporterUserId: 'reporter-1',
  inquiryAuthorUserId: 'author-1',
};

const DUE_AT = '2026-11-05T14:59:59.999Z';

function isNotificationError(status: number, code: string) {
  return (error: unknown): boolean =>
    error instanceof NotificationError && error.status === status && error.code === code;
}

class FakeNotificationTx implements NotificationTx {
  rows: NotificationRecord[] = [];
  private nextId = 1;

  async findByKey(input: {
    readonly userId: string;
    readonly type: NotificationType;
    readonly targetId: string;
  }): Promise<NotificationRecord | null> {
    return (
      this.rows.find(
        (row) =>
          row.userId === input.userId &&
          row.type === input.type &&
          row.targetId === input.targetId,
      ) ?? null
    );
  }

  async create(input: NewNotification): Promise<NotificationRecord> {
    const created: NotificationRecord = {
      ...input,
      id: `notification-${this.nextId}`,
      isRead: false,
    };
    this.nextId += 1;
    this.rows.push(created);
    return created;
  }

  async refreshBundled(input: {
    readonly id: string;
    readonly createdAt: Date;
  }): Promise<NotificationRecord> {
    const index = this.rows.findIndex((row) => row.id === input.id);
    const current = this.rows[index];
    if (index < 0 || current === undefined) throw new Error('missing notification');
    const updated: NotificationRecord = {
      ...current,
      createdAt: input.createdAt,
      isRead: false,
    };
    this.rows[index] = updated;
    return updated;
  }

  async listRecent(input: {
    readonly userId: string;
    readonly since: Date;
    readonly now: Date;
    readonly unreadOnly: boolean;
  }): Promise<readonly NotificationRecord[]> {
    return this.rows
      .filter(
        (row) =>
          row.userId === input.userId &&
          row.createdAt.getTime() >= input.since.getTime() &&
          row.createdAt.getTime() <= input.now.getTime() &&
          (!input.unreadOnly || !row.isRead),
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      );
  }

  async countUnread(input: {
    readonly userId: string;
    readonly since: Date;
    readonly now: Date;
  }): Promise<number> {
    return this.rows.filter(
      (row) =>
        row.userId === input.userId &&
        !row.isRead &&
        row.createdAt.getTime() >= input.since.getTime() &&
        row.createdAt.getTime() <= input.now.getTime(),
    ).length;
  }

  async markRead(input: {
    readonly notificationId: string;
    readonly userId: string;
    readonly now: Date;
  }): Promise<boolean> {
    const index = this.rows.findIndex(
      (row) => row.id === input.notificationId && row.userId === input.userId,
    );
    const current = this.rows[index];
    if (index < 0 || current === undefined) return false;
    this.rows[index] = { ...current, isRead: true };
    return true;
  }

  async markAllRead(input: {
    readonly userId: string;
    readonly since: Date;
    readonly now: Date;
  }): Promise<number> {
    let changed = 0;
    for (let index = 0; index < this.rows.length; index += 1) {
      const row = this.rows[index];
      if (row === undefined) continue;
      if (row.userId !== input.userId || row.isRead) continue;
      if (row.createdAt.getTime() < input.since.getTime()) continue;
      if (row.createdAt.getTime() > input.now.getTime()) continue;
      this.rows[index] = { ...row, isRead: true };
      changed += 1;
    }
    return changed;
  }
}

class FakeUnitOfWork implements NotificationUnitOfWork {
  readonly tx: FakeNotificationTx;

  constructor(tx: FakeNotificationTx = new FakeNotificationTx()) {
    this.tx = tx;
  }

  async run<T>(work: (tx: NotificationTx) => Promise<T>): Promise<T> {
    return work(this.tx);
  }
}

interface TypeCase {
  readonly type: NotificationType;
  readonly targetId: string;
  readonly userId: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly targetUrl: string;
}

const TYPE_CASES: readonly TypeCase[] = [
  {
    type: 'APPLICATION_RECEIVED',
    targetId: 'project-1',
    userId: CLIENT,
    targetUrl: '/projects/project-1/applications',
  },
  {
    type: 'APPLICATION_ACCEPTED',
    targetId: 'contract-1',
    userId: SUPPLIER,
    targetUrl: '/contracts/contract-1/sign',
  },
  {
    type: 'APPLICATION_AUTO_REJECTED',
    targetId: 'application-1',
    userId: SUPPLIER,
    targetUrl: '/applications/application-1',
  },
  {
    type: 'APPLICATION_REJECTED',
    targetId: 'application-2',
    userId: SUPPLIER,
    targetUrl: '/applications/application-2',
  },
  {
    type: 'PROJECT_CLOSED',
    targetId: 'project-2',
    userId: CLIENT,
    targetUrl: '/projects/project-2',
  },
  {
    type: 'REQUOTE_REQUESTED',
    targetId: 'application-3',
    userId: SUPPLIER,
    targetUrl: '/applications/application-3',
  },
  {
    type: 'NEW_MESSAGE',
    targetId: 'project-3:supplier-1',
    userId: SUPPLIER,
    targetUrl: '/chat/project-3:supplier-1',
  },
  {
    type: 'CONTRACT_BROKEN',
    targetId: 'contract-2',
    userId: CLIENT,
    payload: { reason: 'SIGN_REFUSED' },
    targetUrl: '/contracts/contract-2',
  },
  {
    type: 'DEPOSIT_DUE',
    targetId: 'contract-3',
    userId: CLIENT,
    payload: { dueAt: DUE_AT },
    targetUrl: '/contracts/contract-3/deposit',
  },
  {
    type: 'INSPECTION_DUE',
    targetId: 'contract-4',
    userId: CLIENT,
    payload: { dueAt: DUE_AT },
    targetUrl: '/contracts/contract-4/inspection',
  },
  {
    type: 'WORK_DUE',
    targetId: 'contract-5',
    userId: SUPPLIER,
    payload: { dueAt: DUE_AT },
    targetUrl: '/contracts/contract-5/delivery',
  },
  {
    type: 'WORK_OVERDUE',
    targetId: 'contract-6',
    userId: CLIENT,
    payload: { dueAt: DUE_AT },
    targetUrl: '/contracts/contract-6/delivery',
  },
  {
    type: 'AUTO_APPROVED',
    targetId: 'contract-7',
    userId: CLIENT,
    targetUrl: '/contracts/contract-7/settlement',
  },
  {
    type: 'REPORT_REVIEWED',
    targetId: 'report-1',
    userId: 'reporter-1',
    targetUrl: '/reports/report-1',
  },
  {
    type: 'INQUIRY_ANSWERED',
    targetId: 'inquiry-1',
    userId: 'author-1',
    targetUrl: '/help/inquiries/inquiry-1',
  },
];

function seed(
  tx: FakeNotificationTx,
  overrides: Partial<NotificationRecord> = {},
): NotificationRecord {
  const row: NotificationRecord = {
    id: `seed-${tx.rows.length + 1}`,
    userId: CLIENT,
    type: 'APPLICATION_RECEIVED',
    targetUrl: '/projects/project-1/applications',
    targetId: `seed-target-${tx.rows.length + 1}`,
    payload: null,
    isRead: false,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  };
  tx.rows.push(row);
  return row;
}

describe('B-06-T01 알림 15종 타입·payload·URL', () => {
  it('15종이 모집8·기한5·운영2로 나뉜다', () => {
    // 확인
    assert.equal(NOTIFICATION_TYPES.length, 15);
    assert.equal(NOTIFICATION_CATEGORIES.matching.length, 8);
    assert.equal(NOTIFICATION_CATEGORIES.deadline.length, 5);
    assert.equal(NOTIFICATION_CATEGORIES.operations.length, 2);

    for (const type of NOTIFICATION_CATEGORIES.deadline) {
      assert.equal(isDeadlineNotificationType(type), true);
    }
    assert.equal(isDeadlineNotificationType('NEW_MESSAGE'), false);
  });

  it('타입마다 고정 경로·targetId·읽지 않음으로 만든다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();

    // 실행
    for (const testCase of TYPE_CASES) {
      const row = await notify(uow, {
        type: testCase.type,
        userId: testCase.userId,
        targetId: testCase.targetId,
        payload: testCase.payload,
        now: FIXED_NOW,
      });

      // 확인
      assert.equal(row.type, testCase.type);
      assert.equal(row.userId, testCase.userId);
      assert.equal(row.targetId, testCase.targetId);
      assert.equal(row.targetUrl, testCase.targetUrl);
      assert.equal(row.isRead, false);
      assert.equal(row.createdAt.toISOString(), FIXED_NOW.toISOString());
      assert.deepEqual(row.payload, testCase.payload ?? null);
    }

    assert.equal(uow.tx.rows.length, 15);
  });

  it('알 수 없는 타입·위험한 targetId·잘못된 payload를 거부한다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();

    // 실행 및 확인
    await assert.rejects(
      notify(uow, {
        type: 'PAYMENT_DEPOSITED' as unknown as NotificationType,
        userId: CLIENT,
        targetId: 'contract-1',
        now: FIXED_NOW,
      }),
      isNotificationError(400, 'UNKNOWN_NOTIFICATION_TYPE'),
    );

    for (const targetId of ['../admin', 'a/b', 'a?b', 'http://evil.test', '', ' ']) {
      await assert.rejects(
        notify(uow, {
          type: 'PROJECT_CLOSED',
          userId: CLIENT,
          targetId,
          now: FIXED_NOW,
        }),
        isNotificationError(400, 'INVALID_TARGET'),
      );
    }

    await assert.rejects(
      notify(uow, {
        type: 'CONTRACT_BROKEN',
        userId: CLIENT,
        targetId: 'contract-1',
        now: FIXED_NOW,
      }),
      isNotificationError(400, 'INVALID_PAYLOAD'),
    );
    await assert.rejects(
      notify(uow, {
        type: 'CONTRACT_BROKEN',
        userId: CLIENT,
        targetId: 'contract-1',
        payload: { reason: 'BORED' },
        now: FIXED_NOW,
      }),
      isNotificationError(400, 'INVALID_PAYLOAD'),
    );
    await assert.rejects(
      notify(uow, {
        type: 'DEPOSIT_DUE',
        userId: CLIENT,
        targetId: 'contract-1',
        now: FIXED_NOW,
      }),
      isNotificationError(400, 'INVALID_PAYLOAD'),
    );
    await assert.rejects(
      notify(uow, {
        type: 'DEPOSIT_DUE',
        userId: CLIENT,
        targetId: 'contract-1',
        payload: { dueAt: 'not-a-date' },
        now: FIXED_NOW,
      }),
      isNotificationError(400, 'INVALID_PAYLOAD'),
    );

    // 확인
    assert.equal(uow.tx.rows.length, 0);
  });
});

describe('B-06-T02 수신자 규칙과 안전한 URL', () => {
  it('역할별 수신자를 정확히 고른다', () => {
    // 확인
    assert.deepEqual(recipientsFor('APPLICATION_RECEIVED', PARTIES), [CLIENT]);
    for (const type of [
      'APPLICATION_ACCEPTED',
      'APPLICATION_AUTO_REJECTED',
      'APPLICATION_REJECTED',
      'REQUOTE_REQUESTED',
    ] as const) {
      assert.deepEqual(recipientsFor(type, PARTIES), [SUPPLIER]);
    }
    for (const type of [
      'PROJECT_CLOSED',
      'CONTRACT_BROKEN',
      'WORK_DUE',
      'WORK_OVERDUE',
      'AUTO_APPROVED',
    ] as const) {
      assert.deepEqual(recipientsFor(type, PARTIES), [CLIENT, SUPPLIER]);
    }
    assert.deepEqual(recipientsFor('DEPOSIT_DUE', PARTIES), [CLIENT]);
    assert.deepEqual(recipientsFor('INSPECTION_DUE', PARTIES), [CLIENT]);
    assert.deepEqual(recipientsFor('REPORT_REVIEWED', PARTIES), ['reporter-1']);
    assert.deepEqual(recipientsFor('INQUIRY_ANSWERED', PARTIES), ['author-1']);

    assert.deepEqual(recipientsFor('NEW_MESSAGE', { ...PARTIES, senderId: CLIENT }), [
      SUPPLIER,
    ]);
    assert.deepEqual(recipientsFor('NEW_MESSAGE', { ...PARTIES, senderId: SUPPLIER }), [
      CLIENT,
    ]);
  });

  it('같은 사용자가 양쪽이면 중복 수신하지 않는다', () => {
    // 실행 및 확인
    assert.deepEqual(
      recipientsFor('PROJECT_CLOSED', {
        clientUserId: 'same-user',
        supplierUserId: 'same-user',
      }),
      ['same-user'],
    );
  });

  it('운영 알림에 대상자가 없으면 거부한다', () => {
    // 실행 및 확인
    assert.throws(
      () =>
        recipientsFor('REPORT_REVIEWED', {
          clientUserId: CLIENT,
          supplierUserId: SUPPLIER,
        }),
      isNotificationError(400, 'INVALID_RECIPIENT_CONTEXT'),
    );
  });

  it('모든 targetUrl은 내부 경로이고 URL 조작 문자가 없다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();

    // 실행
    for (const testCase of TYPE_CASES) {
      const row = await notify(uow, {
        type: testCase.type,
        userId: testCase.userId,
        targetId: testCase.targetId,
        payload: testCase.payload,
        now: FIXED_NOW,
      });

      // 확인
      assert.equal(row.targetUrl.startsWith('/'), true);
      for (const forbidden of ['http', '//', '?', '#', '..', '@']) {
        assert.equal(
          row.targetUrl.includes(forbidden),
          false,
          `${row.targetUrl} contains ${forbidden}`,
        );
      }
    }
  });

  it('채팅방 targetId는 프로젝트와 공급자를 함께 쓴다', () => {
    // 실행 및 확인
    assert.equal(chatRoomTargetId('project-1', 'supplier-1'), 'project-1:supplier-1');
    assert.throws(
      () => chatRoomTargetId('project/1', 'supplier-1'),
      isNotificationError(400, 'INVALID_TARGET'),
    );
  });
});

describe('B-06-T03 최근 30일 폴링과 읽음', () => {
  const now = FIXED_NOW;

  function seeded(): { tx: FakeNotificationTx; uow: FakeUnitOfWork } {
    const tx = new FakeNotificationTx();
    const old = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
    seed(tx, {
      userId: CLIENT,
      targetId: 'old-1',
      createdAt: old,
    });
    seed(tx, {
      userId: CLIENT,
      targetId: 'recent-1',
      createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    });
    seed(tx, {
      userId: CLIENT,
      targetId: 'recent-2',
      createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    });
    seed(tx, {
      userId: CLIENT,
      type: 'NEW_MESSAGE',
      targetId: 'project-9:supplier-1',
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      isRead: true,
    });
    seed(tx, {
      userId: SUPPLIER,
      targetId: 'supplier-1',
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    return { tx, uow: new FakeUnitOfWork(tx) };
  }

  it('30일 밖 알림은 빼고 최신순으로 폴링하며 안 읽은 수를 함께 준다', async () => {
    // 준비
    const { uow } = seeded();

    // 실행
    const list = await listNotifications(uow, { userId: CLIENT, now });
    // 확인
    assert.deepEqual(
      list.items.map((item) => item.targetId),
      ['project-9:supplier-1', 'recent-1', 'recent-2'],
    );
    assert.equal(list.unreadCount, 2);

    // 실행
    const unreadOnly = await listNotifications(uow, {
      userId: CLIENT,
      now,
      unreadOnly: true,
    });
    // 확인
    assert.deepEqual(
      unreadOnly.items.map((item) => item.targetId),
      ['recent-1', 'recent-2'],
    );
  });

  it('단건 읽음은 본인 알림만, 모두 읽음은 30일 안의 내 알림만 바꾼다', async () => {
    // 준비
    const { tx, uow } = seeded();
    const target = tx.rows.find((row) => row.targetId === 'recent-1');
    assert.ok(target);

    // 실행
    await markNotificationRead(uow, {
      notificationId: target.id,
      userId: CLIENT,
      now,
    });
    // 확인
    assert.equal(
      tx.rows.find((row) => row.id === target.id)?.isRead,
      true,
    );

    // 실행 및 확인
    await assert.rejects(
      markNotificationRead(uow, {
        notificationId: target.id,
        userId: SUPPLIER,
        now,
      }),
      isNotificationError(404, 'NOTIFICATION_NOT_FOUND'),
    );
    await assert.rejects(
      markNotificationRead(uow, {
        notificationId: 'missing',
        userId: CLIENT,
        now,
      }),
      isNotificationError(404, 'NOTIFICATION_NOT_FOUND'),
    );

    // 실행
    const changed = await markAllNotificationsRead(uow, { userId: CLIENT, now });

    // 확인
    assert.equal(changed, 1);
    assert.equal(
      tx.rows.filter(
        (row) =>
          row.userId === CLIENT &&
          !row.isRead &&
          row.createdAt.getTime() >= now.getTime() - 30 * 24 * 60 * 60 * 1000,
      ).length,
      0,
    );
    const oldRow = tx.rows.find((row) => row.targetId === 'old-1');
    assert.equal(oldRow?.isRead, false);
    assert.equal(
      tx.rows.find((row) => row.userId === SUPPLIER)?.isRead,
      false,
    );
    assert.equal(
      (await listNotifications(uow, { userId: CLIENT, now })).unreadCount,
      0,
    );
  });
});

describe('B-06-T04 새 메시지 방별 한 줄', () => {
  it('같은 방의 새 메시지는 한 줄을 최신으로 갱신한다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();
    const firstAt = new Date('2026-11-03T00:00:00.000Z');
    const secondAt = new Date('2026-11-03T00:05:00.000Z');

    // 실행
    const first = await notifyNewMessage(uow, {
      projectId: 'project-1',
      supplierId: 'supplier-1',
      clientUserId: CLIENT,
      supplierUserId: SUPPLIER,
      senderId: CLIENT,
      now: firstAt,
    });
    const second = await notifyNewMessage(uow, {
      projectId: 'project-1',
      supplierId: 'supplier-1',
      clientUserId: CLIENT,
      supplierUserId: SUPPLIER,
      senderId: CLIENT,
      now: secondAt,
    });

    // 확인
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0]?.id, second[0]?.id);
    assert.equal(second[0]?.createdAt.toISOString(), secondAt.toISOString());
    assert.equal(second[0]?.targetId, 'project-1:supplier-1');
    assert.equal(uow.tx.rows.length, 1);

    // 실행
    const list = await listNotifications(uow, { userId: SUPPLIER, now: secondAt });
    // 확인
    assert.equal(list.unreadCount, 1);
    assert.equal(list.items.length, 1);
  });

  it('보낸 사람에게는 알림을 만들지 않고 방이 다르면 따로 만든다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();

    // 실행
    await notifyNewMessage(uow, {
      projectId: 'project-1',
      supplierId: 'supplier-1',
      clientUserId: CLIENT,
      supplierUserId: SUPPLIER,
      senderId: CLIENT,
      now: FIXED_NOW,
    });
    // 확인
    assert.deepEqual(
      uow.tx.rows.map((row) => row.userId),
      [SUPPLIER],
    );

    // 실행
    await notifyNewMessage(uow, {
      projectId: 'project-2',
      supplierId: 'supplier-1',
      clientUserId: CLIENT,
      supplierUserId: SUPPLIER,
      senderId: CLIENT,
      now: FIXED_NOW,
    });
    // 확인
    assert.deepEqual(
      uow.tx.rows.map((row) => row.targetId),
      ['project-1:supplier-1', 'project-2:supplier-1'],
    );
  });

  it('읽은 뒤 새 메시지가 오면 같은 줄이 다시 안 읽음이 된다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();

    // 실행
    const created = await notifyNewMessage(uow, {
      projectId: 'project-1',
      supplierId: 'supplier-1',
      clientUserId: CLIENT,
      supplierUserId: SUPPLIER,
      senderId: CLIENT,
      now: new Date('2026-11-03T00:00:00.000Z'),
    });
    const row = created[0];
    // 확인
    assert.ok(row);

    // 실행
    await markNotificationRead(uow, {
      notificationId: row.id,
      userId: SUPPLIER,
      now: new Date('2026-11-03T00:01:00.000Z'),
    });
    // 확인
    const read = await listNotifications(uow, {
      userId: SUPPLIER,
      now: new Date('2026-11-03T00:02:00.000Z'),
    });
    assert.equal(read.unreadCount, 0);

    // 실행
    const bumped = await notifyNewMessage(uow, {
      projectId: 'project-1',
      supplierId: 'supplier-1',
      clientUserId: CLIENT,
      supplierUserId: SUPPLIER,
      senderId: SUPPLIER,
      now: new Date('2026-11-03T00:03:00.000Z'),
    });
    // 확인
    assert.equal(bumped[0]?.userId, CLIENT);
    assert.equal(uow.tx.rows.filter((candidate) => candidate.userId === SUPPLIER).length, 1);
  });
});

describe('B-06-T05 기한 알림 1회 보장', () => {
  it('C가 넘긴 트랜잭션에서 기한 알림 1회를 만들고 재호출은 no-op이다', async () => {
    // 준비
    const tx = new FakeNotificationTx();
    const input = {
      userId: SUPPLIER,
      type: 'WORK_DUE',
      targetId: 'contract-1',
      payload: { dueAt: DUE_AT },
      now: FIXED_NOW,
    };

    // 실행 및 확인
    assert.deepEqual(await createNotificationOnceInTransaction(tx, input), { created: true });
    assert.deepEqual(await createNotificationOnceInTransaction(tx, input), { created: false });
    assert.equal(tx.rows.length, 1);
    assert.deepEqual(tx.rows[0]?.payload, { dueAt: DUE_AT });

    assert.deepEqual(await createNotificationOnceInTransaction(tx, {
      userId: CLIENT, type: 'AUTO_APPROVED', targetId: 'contract-1', now: FIXED_NOW,
    }), { created: true });
    await assert.rejects(createNotificationOnceInTransaction(tx, {
      userId: CLIENT, type: 'PAYMENT_RELEASED', targetId: 'contract-1', now: FIXED_NOW,
    }), isNotificationError(400, 'UNKNOWN_NOTIFICATION_TYPE'));
    await assert.rejects(createNotificationOnceInTransaction(tx, {
      userId: CLIENT, type: 'WORK_DUE', targetId: 'contract-1', now: FIXED_NOW,
    }), isNotificationError(400, 'INVALID_PAYLOAD'));
  });

  it('배치를 다시 돌려도 같은 기한 알림은 한 번만 만든다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();
    const firstAt = new Date('2026-11-03T00:00:00.000Z');
    const secondAt = new Date('2026-11-03T00:01:00.000Z');

    // 실행
    const first = await notifyFromContractEvent(uow, {
      eventType: 'DEPOSIT_DUE',
      contractId: 'contract-1',
      parties: PARTIES,
      dueAt: new Date('2026-11-06T14:59:59.999Z'),
      now: firstAt,
    });
    const second = await notifyFromContractEvent(uow, {
      eventType: 'DEPOSIT_DUE',
      contractId: 'contract-1',
      parties: PARTIES,
      dueAt: new Date('2026-11-07T14:59:59.999Z'),
      now: secondAt,
    });

    // 확인
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0]?.id, second[0]?.id);
    assert.deepEqual(
      first[0]?.payload,
      { dueAt: '2026-11-06T14:59:59.999Z' },
    );
    assert.equal(first[0]?.createdAt.toISOString(), firstAt.toISOString());
    assert.equal(uow.tx.rows.length, 1);
  });

  it('계약·타입이 다르면 따로 만들고 AUTO_APPROVED는 dueAt이 없어도 된다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();
    const base = {
      parties: PARTIES,
      dueAt: new Date('2026-11-06T14:59:59.999Z'),
      now: FIXED_NOW,
    };

    // 실행
    await notifyFromContractEvent(uow, {
      ...base,
      eventType: 'DEPOSIT_DUE',
      contractId: 'contract-1',
    });
    await notifyFromContractEvent(uow, {
      ...base,
      eventType: 'DEPOSIT_DUE',
      contractId: 'contract-2',
    });
    await notifyFromContractEvent(uow, {
      ...base,
      eventType: 'INSPECTION_DUE',
      contractId: 'contract-1',
    });
    await notifyFromContractEvent(uow, {
      eventType: 'AUTO_APPROVED',
      contractId: 'contract-1',
      parties: PARTIES,
      now: FIXED_NOW,
    });

    // 확인
    assert.equal(uow.tx.rows.length, 5);
    assert.equal(
      uow.tx.rows.filter((row) => row.type === 'AUTO_APPROVED').length,
      2,
    );
  });

  it('수신자별로 따로 만들고 기한 이벤트에 dueAt이 없으면 거부한다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();

    // 실행
    await notifyFromContractEvent(uow, {
      eventType: 'WORK_OVERDUE',
      contractId: 'contract-1',
      parties: PARTIES,
      dueAt: new Date('2026-11-01T00:00:00.000Z'),
      now: FIXED_NOW,
    });

    // 확인
    assert.deepEqual(
      uow.tx.rows.map((row) => row.userId),
      [CLIENT, SUPPLIER],
    );
    assert.equal(
      uow.tx.rows.filter((row) => row.type === 'WORK_OVERDUE').length,
      2,
    );

    // 실행 및 확인
    await assert.rejects(
      notifyFromContractEvent(uow, {
        eventType: 'DEPOSIT_DUE',
        contractId: 'contract-2',
        parties: PARTIES,
        now: FIXED_NOW,
      }),
      isNotificationError(400, 'INVALID_PAYLOAD'),
    );
  });
});

describe('B-06-T06 계약 이후 불필요 알림 0', () => {
  it('결제·납품·검수·지급 이벤트는 알림을 만들지 않는다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();

    // 실행
    for (const eventType of [
      'PAYMENT_DEPOSITED',
      'DELIVERY_SUBMITTED',
      'INSPECTION_APPROVED',
      'PAYMENT_RELEASED',
      'CONTRACT_SIGNED',
      'REVIEW_WRITTEN',
      'MESSAGE_SENT',
    ]) {
      const created = await notifyFromContractEvent(uow, {
        eventType,
        contractId: 'contract-1',
        parties: PARTIES,
        dueAt: new Date('2026-11-06T14:59:59.999Z'),
        now: FIXED_NOW,
      });
      // 확인
      assert.deepEqual(created, []);
    }

    assert.equal(uow.tx.rows.length, 0);
  });

  it('알림을 만드는 계약 이벤트는 기한 5종뿐이다', () => {
    // 확인
    assert.deepEqual(
      [...NOTIFICATION_CATEGORIES.deadline],
      ['DEPOSIT_DUE', 'INSPECTION_DUE', 'WORK_DUE', 'WORK_OVERDUE', 'AUTO_APPROVED'],
    );
    assert.equal(
      (NOTIFICATION_TYPES as readonly string[]).includes('PAYMENT_DEPOSITED'),
      false,
    );
  });
});

describe('B-06-T07 채팅 발신에 붙는 방별 알림 Port', () => {
  it('같은 방의 연속 메시지는 상대에게 한 줄로 묶고 보낸 사람에게는 만들지 않는다', async () => {
    // 준비
    const uow = new FakeUnitOfWork();
    const port = createChatNotificationPort(uow);
    const first = new Date('2026-11-03T00:00:00.000Z');
    const second = new Date('2026-11-03T00:05:00.000Z');

    // 실행
    await port.notifyNewMessage({
      projectId: 'prj-1',
      supplierId: SUPPLIER,
      clientUserId: CLIENT,
      supplierUserId: SUPPLIER,
      senderId: CLIENT,
      now: first,
    });
    await port.notifyNewMessage({
      projectId: 'prj-1',
      supplierId: SUPPLIER,
      clientUserId: CLIENT,
      supplierUserId: SUPPLIER,
      senderId: CLIENT,
      now: second,
    });

    // 확인
    assert.equal(uow.tx.rows.length, 1);
    const row = uow.tx.rows[0];
    assert.equal(row?.userId, SUPPLIER);
    assert.equal(row?.type, 'NEW_MESSAGE');
    assert.equal(row?.targetId, 'prj-1:supplier-1');
    assert.equal(row?.targetUrl, '/chat/prj-1:supplier-1');
    assert.equal(row?.createdAt.getTime(), second.getTime());
    assert.equal(row?.isRead, false);
  });
});

function racedRow(
  type: NotificationType,
  targetId: string,
  createdAt: Date,
): NotificationRecord {
  return {
    id: 'notification-raced',
    userId: type === 'DEPOSIT_DUE' ? CLIENT : SUPPLIER,
    type,
    targetUrl: type === 'DEPOSIT_DUE' ? `/contracts/${targetId}/deposit` : `/chat/${targetId}`,
    targetId,
    payload: type === 'DEPOSIT_DUE' ? { dueAt: '2026-11-06T14:59:59.999Z' } : null,
    isRead: false,
    createdAt,
  };
}

/** 첫 조회는 null, create는 unique 위반, 재조회는 경쟁 행을 돌려주는 fake. */
class RacingNotificationTx extends FakeNotificationTx {
  readonly raced: NotificationRecord;
  private finds = 0;

  constructor(raced: NotificationRecord) {
    super();
    this.raced = raced;
    this.rows.push(raced);
  }

  override async findByKey(): Promise<NotificationRecord | null> {
    this.finds += 1;
    return this.finds === 1 ? null : this.raced;
  }

  override async create(): Promise<NotificationRecord> {
    throw new NotificationUniqueViolation();
  }
}

class AlwaysMissingNotificationTx extends FakeNotificationTx {
  override async findByKey(): Promise<NotificationRecord | null> {
    return null;
  }

  override async create(): Promise<NotificationRecord> {
    throw new NotificationUniqueViolation();
  }
}

describe('B-06-T08 동시 생성 unique 경쟁 재시도', () => {
  it('새 메시지는 경쟁에서 진 행을 한 줄로 갱신한다', async () => {
    // 준비
    const first = new Date('2026-11-03T00:00:00.000Z');
    const now = new Date('2026-11-03T00:05:00.000Z');
    const tx = new RacingNotificationTx(racedRow('NEW_MESSAGE', 'prj-1:supplier-1', first));

    // 실행
    const created = await notifyNewMessage(new FakeUnitOfWork(tx), {
      projectId: 'prj-1',
      supplierId: SUPPLIER,
      clientUserId: CLIENT,
      supplierUserId: SUPPLIER,
      senderId: CLIENT,
      now,
    });

    // 확인
    assert.equal(created.length, 1);
    assert.equal(created[0]?.id, 'notification-raced');
    assert.equal(created[0]?.createdAt.getTime(), now.getTime());
    assert.equal(created[0]?.isRead, false);
    assert.equal(tx.rows.length, 1);
  });

  it('기한 알림은 경쟁에서 진 행을 유지하고 created:false를 돌려준다', async () => {
    // 준비
    const tx = new RacingNotificationTx(
      racedRow('DEPOSIT_DUE', 'contract-1', FIXED_NOW),
    );

    // 실행
    const result = await createNotificationOnceInTransaction(tx, {
      userId: CLIENT,
      type: 'DEPOSIT_DUE',
      targetId: 'contract-1',
      payload: { dueAt: '2026-11-06T14:59:59.999Z' },
      now: new Date('2026-11-03T00:05:00.000Z'),
    });

    // 확인
    assert.deepEqual(result, { created: false });
    assert.equal(tx.rows.length, 1);
    assert.equal(tx.rows[0]?.createdAt.getTime(), FIXED_NOW.getTime());
  });

  it('재조회에서도 행이 없으면 unique 오류를 숨기지 않는다', async () => {
    // 준비
    const tx = new AlwaysMissingNotificationTx();

    // 실행 및 확인
    await assert.rejects(
      notify(new FakeUnitOfWork(tx), {
        type: 'PROJECT_CLOSED',
        userId: CLIENT,
        targetId: 'prj-1',
        now: FIXED_NOW,
      }),
      (error: unknown) => error instanceof NotificationUniqueViolation,
    );
    await assert.rejects(
      createNotificationOnceInTransaction(tx, {
        userId: CLIENT,
        type: 'INSPECTION_DUE',
        targetId: 'contract-1',
        payload: { dueAt: '2026-11-06T14:59:59.999Z' },
        now: FIXED_NOW,
      }),
      (error: unknown) => error instanceof NotificationUniqueViolation,
    );
  });
});

function matchesWhere(row: NotificationDbRow, where: NotificationWhere): boolean {
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.type !== undefined && row.type !== where.type) return false;
  if (where.targetId !== undefined && row.targetId !== where.targetId) return false;
  if (where.isRead !== undefined && row.isRead !== where.isRead) return false;
  if (
    where.createdAt?.gte !== undefined &&
    row.createdAt.getTime() < where.createdAt.gte.getTime()
  ) {
    return false;
  }
  if (
    where.createdAt?.lte !== undefined &&
    row.createdAt.getTime() > where.createdAt.lte.getTime()
  ) {
    return false;
  }
  return true;
}

/** Prisma delegate와 $transaction만 흉내 내는 in-memory DB. */
class FakeNotificationDb implements NotificationPrismaClient {
  rows: NotificationDbRow[] = [];
  competingOnCreate: NotificationDbRow | null = null;
  transactions = 0;
  private nextId = 1;

  readonly notification: NotificationDelegate = {
    findUnique: async ({ where }) => {
      const key = where.userId_type_targetId;
      return (
        this.rows.find(
          (row) =>
            row.userId === key.userId &&
            row.type === key.type &&
            row.targetId === key.targetId,
        ) ?? null
      );
    },
    create: async ({ data }) => {
      if (this.competingOnCreate !== null) {
        this.rows.push(this.competingOnCreate);
        this.competingOnCreate = null;
        throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
      }
      const created: NotificationDbRow = {
        ...data,
        id: `db-${this.nextId}`,
        isRead: false,
      };
      this.nextId += 1;
      this.rows.push(created);
      return created;
    },
    update: async ({ where, data }) => {
      const index = this.rows.findIndex((row) => row.id === where.id);
      const current = this.rows[index];
      if (current === undefined) throw new Error('missing notification');
      const updated: NotificationDbRow = { ...current, ...data };
      this.rows[index] = updated;
      return updated;
    },
    findMany: async ({ where }) =>
      this.rows
        .filter((row) => matchesWhere(row, where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    count: async ({ where }) =>
      this.rows.filter((row) => matchesWhere(row, where)).length,
    updateMany: async ({ where, data }) => {
      let count = 0;
      this.rows = this.rows.map((row) => {
        if (!matchesWhere(row, where)) return row;
        count += 1;
        return { ...row, ...data };
      });
      return { count };
    },
  };

  async $transaction<T>(
    work: (tx: { notification: NotificationDelegate }) => Promise<T>,
  ): Promise<T> {
    this.transactions += 1;
    return work({ notification: this.notification });
  }
}

describe('B-06-T09 Prisma 어댑터', () => {
  it('P2002를 도메인 경쟁으로 바꿔 새 메시지를 한 줄로 갱신한다', async () => {
    // 준비
    const db = new FakeNotificationDb();
    db.competingOnCreate = {
      id: 'db-raced',
      userId: SUPPLIER,
      type: 'NEW_MESSAGE',
      targetUrl: '/chat/prj-1:supplier-1',
      targetId: 'prj-1:supplier-1',
      payload: null,
      isRead: false,
      createdAt: new Date('2026-11-03T00:00:00.000Z'),
    };
    const uow = createPrismaNotificationUnitOfWork(db);
    const now = new Date('2026-11-03T00:05:00.000Z');

    // 실행
    const created = await notifyNewMessage(uow, {
      projectId: 'prj-1',
      supplierId: SUPPLIER,
      clientUserId: CLIENT,
      supplierUserId: SUPPLIER,
      senderId: CLIENT,
      now,
    });

    // 확인
    assert.equal(db.transactions, 1);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0]?.id, 'db-raced');
    assert.equal(db.rows[0]?.createdAt.getTime(), now.getTime());
    assert.equal(created[0]?.createdAt.getTime(), now.getTime());
  });

  it('기한 알림 P2002도 기존 행을 유지한다', async () => {
    // 준비
    const db = new FakeNotificationDb();
    db.competingOnCreate = {
      id: 'db-deadline',
      userId: CLIENT,
      type: 'DEPOSIT_DUE',
      targetUrl: '/contracts/contract-1/deposit',
      targetId: 'contract-1',
      payload: { dueAt: '2026-11-06T14:59:59.999Z' },
      isRead: false,
      createdAt: FIXED_NOW,
    };
    const uow = createPrismaNotificationUnitOfWork(db);

    // 실행
    const result = await notify(uow, {
      type: 'DEPOSIT_DUE',
      userId: CLIENT,
      targetId: 'contract-1',
      payload: { dueAt: '2026-11-06T14:59:59.999Z' },
      now: new Date('2026-11-03T00:05:00.000Z'),
    });

    // 확인
    assert.equal(db.rows.length, 1);
    assert.equal(result.id, 'db-deadline');
    assert.equal(db.rows[0]?.createdAt.getTime(), FIXED_NOW.getTime());
  });

  it('최근 목록·안 읽은 수·전체 읽음을 Prisma where로 위임한다', async () => {
    // 준비
    const db = new FakeNotificationDb();
    db.rows.push(
      {
        id: 'db-client',
        userId: CLIENT,
        type: 'NEW_MESSAGE',
        targetUrl: '/chat/prj-1:supplier-1',
        targetId: 'prj-1:supplier-1',
        payload: null,
        isRead: false,
        createdAt: new Date('2026-11-02T00:00:00.000Z'),
      },
      {
        id: 'db-unread',
        userId: SUPPLIER,
        type: 'NEW_MESSAGE',
        targetUrl: '/chat/prj-1:supplier-1',
        targetId: 'prj-1:supplier-1',
        payload: null,
        isRead: false,
        createdAt: new Date('2026-11-02T00:00:00.000Z'),
      },
      {
        id: 'db-read',
        userId: SUPPLIER,
        type: 'PROJECT_CLOSED',
        targetUrl: '/projects/prj-1',
        targetId: 'prj-1',
        payload: null,
        isRead: true,
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
      },
    );
    const uow = createPrismaNotificationUnitOfWork(db);

    // 실행
    const list = await listNotifications(uow, { userId: SUPPLIER, now: FIXED_NOW });
    // 확인
    assert.deepEqual(
      list.items.map((row) => row.id),
      ['db-unread', 'db-read'],
    );
    assert.equal(list.unreadCount, 1);

    // 실행
    assert.equal(await markAllNotificationsRead(uow, { userId: SUPPLIER, now: FIXED_NOW }), 1);
    // 확인
    assert.equal(
      (await listNotifications(uow, { userId: SUPPLIER, now: FIXED_NOW })).unreadCount,
      0,
    );
    assert.equal(
      (await listNotifications(uow, { userId: CLIENT, now: FIXED_NOW })).unreadCount,
      1,
    );
  });
});

describe('B-06-T10 C 알림 포트 bridge', () => {
  it('C createOnce를 같은 tx 멱등 함수로 연결하고 targetUrl은 B 고정 경로를 쓴다', async () => {
    // 준비
    const tx = new FakeNotificationTx();
    const bridge = createNotificationBridge(tx, { now: () => FIXED_NOW });

    // 실행
    const first = await bridge.createOnce({
      userId: CLIENT,
      type: 'AUTO_APPROVED',
      targetId: 'contract-1',
      targetUrl: 'https://evil.example/steal',
    });
    // 확인
    assert.deepEqual(first, { created: true });
    assert.equal(tx.rows.length, 1);
    assert.equal(tx.rows[0]?.targetUrl, '/contracts/contract-1/settlement');

    // 실행
    const second = await bridge.createOnce({
      userId: CLIENT,
      type: 'AUTO_APPROVED',
      targetId: 'contract-1',
    });
    // 확인
    assert.deepEqual(second, { created: false });
    assert.equal(tx.rows.length, 1);
  });

  it('알 수 없는 타입은 거부한다', async () => {
    // 준비
    const bridge = createNotificationBridge(new FakeNotificationTx(), { now: () => FIXED_NOW });

    // 실행 및 확인
    await assert.rejects(
      bridge.createOnce({ userId: CLIENT, type: 'NOT_A_TYPE', targetId: 'contract-1' }),
      (error: unknown) =>
        error instanceof NotificationError && error.code === 'UNKNOWN_NOTIFICATION_TYPE',
    );
  });

  it('dueAt이 필요한 기한 알림은 C 계약에 payload가 없어 생성되지 않는다', async () => {
    // 준비
    const bridge = createNotificationBridge(new FakeNotificationTx(), { now: () => FIXED_NOW });

    // 실행 및 확인
    await assert.rejects(
      bridge.createOnce({ userId: CLIENT, type: 'DEPOSIT_DUE', targetId: 'contract-1' }),
      (error: unknown) => error instanceof NotificationError && error.code === 'INVALID_PAYLOAD',
    );
  });
});
