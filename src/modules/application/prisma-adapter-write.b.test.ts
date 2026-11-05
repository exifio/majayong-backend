import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApplicationUniqueViolation,
} from './submission.ts';
import type { NotificationDbRow } from '../notification/prisma-adapter.ts';
import {
  createApplicationTx,
  createPrismaApplicationUnitOfWork,
  type ApplicationDbClient,
  type ApplicationRow,
} from './prisma-adapter.ts';
import { FIXED_NOW } from '../../../tests/b/fixtures.ts';

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

function row(overrides: Partial<ApplicationRow> = {}): ApplicationRow {
  return {
    id: 'app-1',
    projectId: 'prj-1',
    supplierId: 'supplier-1',
    revisionNo: 1,
    specVersionNo: 1,
    status: 'SUBMITTED',
    totalAmount: 3_100_000,
    durationDays: 42,
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

function makeDb(initial: readonly ApplicationRow[]) {
  const rows = [...initial];
  const messages: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  let failCreate = false;

  const db: ApplicationDbClient = {
    $queryRaw: async <T = unknown>() => [] as T,
    application: {
      async findMany(input) {
        const where = input.where as {
          projectId?: string;
          supplierId?: string;
          project?: { clientId?: string };
        };
        const filtered = rows.filter((candidate) => {
          if (where.projectId !== undefined && candidate.projectId !== where.projectId) return false;
          if (where.supplierId !== undefined && candidate.supplierId !== where.supplierId) return false;
          return true;
        });
        return [...filtered].sort((a, b) => b.revisionNo - a.revisionNo);
      },
      async findUnique(input) {
        return rows.find((candidate) => candidate.id === input.where.id) ?? null;
      },
      async create(input) {
        if (failCreate) {
          const error = new Error('duplicate key');
          Object.assign(error, { code: 'P2002' });
          throw error;
        }
        const data = input.data as {
          projectId: string;
          supplierId: string;
          revisionNo: number;
          specVersionNo: number;
          totalAmount: number;
          durationDays: number;
          message: string | null;
          questions: readonly { text: string }[] | null;
          isMessageMasked: boolean;
          revisionReason: string | null;
          firstViewedAt: Date;
          submittedAt: Date;
          items: { create: readonly { specItemId: string; isAvailable: boolean }[] };
        };
        const created = row({
          id: `app-${rows.length + 1}`,
          projectId: data.projectId,
          supplierId: data.supplierId,
          revisionNo: data.revisionNo,
          specVersionNo: data.specVersionNo,
          totalAmount: data.totalAmount,
          durationDays: data.durationDays,
          message: data.message,
          questions: data.questions,
          isMessageMasked: data.isMessageMasked,
          revisionReason: data.revisionReason,
          firstViewedAt: data.firstViewedAt,
          submittedAt: data.submittedAt,
          items: [...data.items.create],
        });
        rows.push(created);
        return created;
      },
      async updateMany(input) {
        const where = input.where as {
          id: string;
          status: { in: readonly string[] };
        };
        const data = input.data as { status: string };
        const index = rows.findIndex(
          (candidate) => candidate.id === where.id && where.status.in.includes(candidate.status),
        );
        const current = rows[index];
        if (index < 0 || current === undefined) return { count: 0 };
        rows[index] = { ...current, status: data.status as ApplicationRow['status'] };
        return { count: 1 };
      },
    },
    project: {
      async findUnique() {
        return { currentVersion: 1, status: 'RECRUITING' };
      },
    },
    specItem: {
      async findMany() {
        return [{ id: 'spec-1' }, { id: 'spec-2' }];
      },
    },
    applicationMessage: {
      async create(input) {
        messages.push(input.data as Record<string, unknown>);
        return input.data;
      },
    },
    eventLog: {
      async findFirst() {
        return { occurredAt: new Date('2026-10-30T00:00:00.000Z') };
      },
    },
    notification: {
      findUnique: async () => null,
      async create(input) {
        notifications.push({ ...input.data });
        return { ...input.data, id: 'n1', isRead: false } satisfies NotificationDbRow;
      },
      update: unused,
      findMany: async () => [],
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
    },
  };

  return { db, rows, messages, notifications, failCreate: () => { failCreate = true; } };
}

describe('B-02 Prisma 쓰기 어댑터', () => {
  it('createRevision은 항목·질문을 저장하고 Project.clientId를 채운다', async () => {
    // 준비
    const fixture = makeDb([]);
    const tx = createApplicationTx(fixture.db);

    // 실행
    const created = await tx.createRevision({
      projectId: 'prj-1',
      clientUserId: 'client-1',
      supplierId: 'supplier-1',
      revisionNo: 1,
      specVersionNo: 1,
      totalAmount: 3_100_000,
      durationDays: 42,
      message: '안녕하세요',
      questions: [{ text: '질문 1' }],
      isMessageMasked: false,
      revisionReason: null,
      firstViewedAt: FIXED_NOW,
      submittedAt: FIXED_NOW,
      items: [{ specItemId: 'spec-1', isAvailable: true }],
    });

    // 확인
    assert.equal(created.clientUserId, 'client-1');
    assert.deepEqual(created.questions, [{ text: '질문 1' }]);
    assert.deepEqual(created.items, [{ specItemId: 'spec-1', isAvailable: true }]);
    assert.equal(fixture.rows.length, 1);
  });

  it('unique 위반은 ApplicationUniqueViolation으로 바꾼다', async () => {
    // 준비
    const fixture = makeDb([]);
    fixture.failCreate();
    const tx = createApplicationTx(fixture.db);

    // 실행 및 확인
    await assert.rejects(
      tx.createRevision({
        projectId: 'prj-1',
        clientUserId: 'client-1',
        supplierId: 'supplier-1',
        revisionNo: 1,
        specVersionNo: 1,
        totalAmount: 1,
        durationDays: 1,
        message: null,
        questions: [],
        isMessageMasked: false,
        revisionReason: null,
        firstViewedAt: FIXED_NOW,
        submittedAt: FIXED_NOW,
        items: [],
      }),
      (error: unknown) => error instanceof ApplicationUniqueViolation,
    );
  });

  it('updateStatus는 from 상태일 때만 1건을 바꾼다', async () => {
    // 준비
    const fixture = makeDb([row()]);
    const tx = createApplicationTx(fixture.db);

    // 실행 및 확인
    assert.equal(
      await tx.updateStatus({ applicationId: 'app-1', from: ['STALE'], to: 'SUPERSEDED' }),
      false,
    );
    assert.equal(
      await tx.updateStatus({ applicationId: 'app-1', from: ['SUBMITTED'], to: 'STALE' }),
      true,
    );
    // 확인
    assert.equal(fixture.rows[0]?.status, 'STALE');
  });

  it('상세 열람 최초 시각과 SYSTEM 메시지를 남긴다', async () => {
    // 준비
    const fixture = makeDb([]);
    const tx = createApplicationTx(fixture.db);

    // 실행 및 확인
    assert.equal(
      (await tx.findFirstDetailView({ projectId: 'prj-1', supplierId: 'supplier-1' }))?.toISOString(),
      '2026-10-30T00:00:00.000Z',
    );

    // 실행
    await tx.appendSystemMessage({ applicationId: 'app-1', body: '수정되었습니다.' });
    // 확인
    assert.deepEqual(fixture.messages[0], {
      applicationId: 'app-1',
      senderId: null,
      kind: 'SYSTEM',
      body: '수정되었습니다.',
      isMasked: false,
    });
  });

  it('같은 tx의 알림 Tx로 지원 접수 알림을 만든다', async () => {
    // 준비
    const fixture = makeDb([]);
    const tx = createApplicationTx(fixture.db);

    // 실행
    await tx.notifications.notifyApplication({
      type: 'APPLICATION_RECEIVED',
      clientUserId: 'client-1',
      supplierUserId: 'supplier-1',
      targetId: 'prj-1',
      now: FIXED_NOW,
    });

    // 확인
    assert.equal(fixture.notifications.length, 1);
    assert.equal(fixture.notifications[0]?.targetUrl, '/projects/prj-1/applications');
  });

  it('UnitOfWork는 $transaction 안에서 tx를 넘긴다', async () => {
    // 준비
    const fixture = makeDb([row()]);
    const uow = createPrismaApplicationUnitOfWork({
      ...fixture.db,
      $transaction: async (work) => work(fixture.db),
    });

    // 실행
    const latest = await uow.run((tx) =>
      tx.findLatestRevision({ projectId: 'prj-1', supplierId: 'supplier-1' }),
    );
    // 확인
    assert.equal(latest?.id, 'app-1');
  });

  it('지원 트랜잭션은 프로젝트를 잠그고 현재 버전의 포함 항목만 읽는다', async () => {
    // 준비
    const fixture = makeDb([]);
    const queries: string[] = [];
    const txDb: ApplicationDbClient = {
      ...fixture.db,
      $queryRaw: async <T = unknown>(strings: TemplateStringsArray) => {
        queries.push(strings.join('?'));
        return [] as T;
      },
      project: {
        async findUnique(input) {
          assert.deepEqual(input, {
            where: { id: 'prj-1' },
            select: { currentVersion: true, status: true },
          });
          return { currentVersion: 3, status: 'RECRUITING' };
        },
      },
      specItem: {
        async findMany(input) {
          assert.deepEqual(input, {
            where: { projectId: 'prj-1', versionNo: 3, status: 'INCLUDED' },
            select: { id: true },
          });
          return [{ id: 'spec-current' }];
        },
      },
    };

    // 실행 및 확인
    assert.deepEqual(await createApplicationTx(txDb).findProjectSpec('prj-1'), {
      currentVersion: 3,
      status: 'RECRUITING',
      specItemIds: ['spec-current'],
    });
    // 확인
    assert.deepEqual(queries, ['SELECT id FROM projects WHERE id = ? FOR UPDATE']);
  });
});
