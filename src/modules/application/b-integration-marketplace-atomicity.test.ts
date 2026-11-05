import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMarketplaceAutoRejectPort } from './marketplace-port.ts';
import {
  createApplicationTx,
  type ApplicationDbClient,
  type ApplicationRow,
} from './prisma-adapter.ts';
import type { NewNotification } from '../notification/notifications.ts';
import type { ApplicationUnitOfWork } from './submission.ts';

const FIXED_NOW = new Date('2026-11-04T00:00:00.000Z');

function row(overrides: Partial<ApplicationRow> = {}): ApplicationRow {
  return {
    id: 'app-1',
    projectId: 'prj-1',
    supplierId: 'supplier-1',
    revisionNo: 1,
    specVersionNo: 1,
    status: 'SUBMITTED',
    totalAmount: 1_000_000,
    durationDays: 10,
    message: null,
    questions: null,
    isMessageMasked: false,
    revisionReason: null,
    firstViewedAt: FIXED_NOW,
    submittedAt: FIXED_NOW,
    items: [],
    project: { draft: { clientId: 'client-1' } },
    ...overrides,
  };
}

function fakeApplicationDb(rows: ApplicationRow[]): ApplicationDbClient {
  return {
    $queryRaw: async <T = unknown>() => [] as T,
    application: {
      async findMany() {
        return rows;
      },
      async findUnique() {
        return null;
      },
      async create() {
        throw new Error('unused');
      },
      async updateMany(input) {
        const where = input.where as { id?: string; status?: { in: readonly string[] } };
        let count = 0;
        rows.forEach((current, index) => {
          if (where.id !== undefined && current.id !== where.id) return;
          if (where.status?.in !== undefined && !where.status.in.includes(current.status)) return;
          rows[index] = { ...current, status: input.data.status as ApplicationRow['status'] };
          count += 1;
        });
        return { count };
      },
    },
    project: { findUnique: async () => null },
    specItem: { findMany: async () => [] },
    applicationMessage: { create: async () => ({}) },
    eventLog: { findFirst: async () => null },
    notification: {
      findUnique: async () => null,
      create: async (input: { readonly data: NewNotification }) =>
        ({
          ...input.data,
          id: 'notification-1',
          isRead: false,
        }) as never,
      update: async () => ({}) as never,
      findMany: async () => [],
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
    },
  };
}

describe('G2-03: 예치 완료 자동 거절이 C 예치 트랜잭션에 참여', () => {
  it('C가 넘긴 tx에 다른 지원 거절을 기록하고 별도 트랜잭션을 열지 않는다', async () => {
    // 준비
    const txRows = [
      row({ id: 'app-1', status: 'ACCEPTED' }),
      row({ id: 'app-2', supplierId: 'supplier-2', status: 'SUBMITTED' }),
      row({ id: 'app-3', supplierId: 'supplier-3', status: 'STALE' }),
    ];
    const txDb = fakeApplicationDb(txRows);

    // 별도 트랜잭션 경로가 호출되면 여기로 잡힌다. C가 tx를 넘기면 절대 호출되면 안 된다.
    const fallbackDb = fakeApplicationDb([row({ id: 'app-2', supplierId: 'supplier-2', status: 'SUBMITTED' })]);
    let fallbackRuns = 0;
    const uow: ApplicationUnitOfWork = {
      async run(work) {
        fallbackRuns += 1;
        return work(createApplicationTx(fallbackDb));
      },
    };

    const port = createMarketplaceAutoRejectPort(uow, (tx) =>
      createApplicationTx(tx as ApplicationDbClient),
    );

    // 실행
    const result = await port.autoRejectCompetingApplications(
      { projectId: 'prj-1', acceptedApplicationId: 'app-1', now: FIXED_NOW },
      txDb,
    );

    // 확인
    assert.deepEqual(result, { rejectedCount: 2 });
    assert.equal(fallbackRuns, 0, '예치 tx 대신 별도 트랜잭션을 열었다');
    assert.deepEqual(
      txRows.map((current) => [current.id, current.status]),
      [
        ['app-1', 'ACCEPTED'],
        ['app-2', 'AUTO_REJECTED'],
        ['app-3', 'AUTO_REJECTED'],
      ],
    );
  });
});
