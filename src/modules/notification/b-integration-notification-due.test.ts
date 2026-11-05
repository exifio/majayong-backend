import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createInMemoryDeliveryRepository, InspectionBatchService } from '../delivery/index.ts';
import { createNotificationBridge } from './c-bridge.ts';
import {
  createPrismaNotificationTx,
  type NotificationDbClient,
  type NotificationDbRow,
} from './prisma-adapter.ts';

// G2-04: C 기한 알림(DEPOSIT_DUE 등)은 B가 요구하는 dueAt payload가 있어야 생성된다.
// C가 dueAt을 넘기고 B bridge가 payload로 옮기는지, 실제 어댑터 경계에서 확인한다.
function fakeNotificationDb(): { db: NotificationDbClient; rows: NotificationDbRow[] } {
  const rows: NotificationDbRow[] = [];
  let seq = 0;
  const db: NotificationDbClient = {
    notification: {
      async findUnique(input) {
        const { userId, type, targetId } = input.where.userId_type_targetId;
        return rows.find((row) => row.userId === userId && row.type === type && row.targetId === targetId) ?? null;
      },
      async create(input) {
        const data = input.data;
        if (rows.some((row) => row.userId === data.userId && row.type === data.type && row.targetId === data.targetId)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row: NotificationDbRow = { id: `n-${(seq += 1)}`, isRead: false, ...data };
        rows.push(row);
        return row;
      },
      async update(input) {
        const row = rows.find((candidate) => candidate.id === input.where.id);
        assert.ok(row);
        Object.assign(row, input.data);
        return row;
      },
      async findMany() {
        return rows;
      },
      async count() {
        return rows.length;
      },
      async updateMany() {
        return { count: 0 };
      },
    },
  };
  return { db, rows };
}

describe('G2-04: C 기한 알림이 B dueAt payload로 생성된다', () => {
  it('예치 기한 1일 전 DEPOSIT_DUE가 dueAt과 함께 1건 생성된다', async () => {
    // 준비
    const { db, rows } = fakeNotificationDb();
    const baseTime = new Date('2026-11-06T14:59:59.000Z');
    const depositDeadline = new Date('2026-11-07T14:59:59.000Z');
    const notifications = createNotificationBridge(
      createPrismaNotificationTx(db),
      { now: () => baseTime },
    );

    const repo = createInMemoryDeliveryRepository();
    repo.seedContract({
      id: 'contract-g2-04',
      clientUserId: 'client-1',
      supplierUserId: 'supplier-1',
      status: 'ACTIVE',
      paymentStatus: 'PENDING',
      workDueAt: new Date('2026-12-16T10:00:00.000Z'),
      depositDeadline,
    });

    const batch = new InspectionBatchService({
      repo,
      notificationPorts: notifications,
      clock: { now: () => baseTime },
    });

    // 실행
    const oneDayBefore = new Date(depositDeadline.getTime() - 24 * 60 * 60 * 1000);
    await batch.sendDueNotifications('contract-g2-04', oneDayBefore);

    // 확인
    const created = rows.filter((row) => row.type === 'DEPOSIT_DUE');
    assert.equal(created.length, 1);
    assert.equal(created[0]?.userId, 'client-1');
    assert.deepEqual(created[0]?.payload, { dueAt: depositDeadline.toISOString() });
    assert.equal(created[0]?.targetUrl, '/contracts/contract-g2-04/deposit');
  });
});
