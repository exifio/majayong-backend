import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAProjectApplicationPort,
  createAProjectSearchPort,
  createAProjectViewPort,
  type AProjectDb,
} from './a-ports.ts';
import type { ProjectSearchInput, ProjectSearchPort } from '../modules/market/project-search.ts';
import type { ApplicationRow } from '../modules/application/prisma-adapter.ts';
import { FIXED_NOW } from '../../tests/b/fixtures.ts';

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

function summary(id: string) {
  return {
    id,
    title: '예약 사이트',
    summary: '예약',
    industryCode: 'FOOD',
    requiredSkills: ['React'],
    hopeBudgetRange: null,
    deadline: null,
    status: 'RECRUITING' as const,
    publishedAt: FIXED_NOW,
    currentSpecVersion: 1,
    specItemCount: 1,
    specItemTitles: ['예약'],
  };
}

describe('A가 호출하는 B 검색 Port', () => {
  it('A 쿼리를 B 필터로 옮기고 id 목록과 총계를 돌려준다', async () => {
    // 준비
    const received: ProjectSearchInput[] = [];
    const search: ProjectSearchPort = {
      async searchPublicProjects(input) {
        received.push(input);
        return { items: [summary('prj-1'), summary('prj-2')], meta: { page: 2, pageSize: 10, total: 12, totalPages: 2 } };
      },
    };
    const port = createAProjectSearchPort(search);

    // 실행
    const result = await port.searchPublicProjects({
      filters: { industryCode: 'FOOD', skill: 'React', status: 'RECRUITING', minBudget: 100 },
      page: 2,
      pageSize: 10,
    });

    // 확인
    assert.deepEqual(result, { projectIds: ['prj-1', 'prj-2'], total: 12 });
    assert.deepEqual(received[0], {
      filters: {
        industryCode: 'FOOD',
        requiredSkills: ['React'],
        minBudgetKrw: 100,
        recruitmentStatus: 'OPEN',
      },
      page: 2,
    });
  });

  it('모집 중이 아닌 상태 필터는 CLOSED로 매핑한다', async () => {
    // 준비
    const received: ProjectSearchInput[] = [];
    const search: ProjectSearchPort = {
      async searchPublicProjects(input) {
        received.push(input);
        return { items: [], meta: { page: 1, pageSize: 10, total: 0, totalPages: 0 } };
      },
    };

    // 실행
    await createAProjectSearchPort(search).searchPublicProjects({
      filters: { status: 'CONTRACTED' },
      page: 1,
      pageSize: 10,
    });

    // 확인
    assert.equal(received[0]?.filters?.recruitmentStatus, 'CLOSED');
  });

  it('키워드와 정렬을 B 검색 입력으로 옮긴다', async () => {
    // 준비
    const received: ProjectSearchInput[] = [];
    const search: ProjectSearchPort = {
      async searchPublicProjects(input) {
        received.push(input);
        return { items: [], meta: { page: 1, pageSize: 10, total: 0, totalPages: 0 } };
      },
    };

    // 실행
    await createAProjectSearchPort(search).searchPublicProjects({
      filters: { keyword: '예약' },
      sort: 'DEADLINE_SOON',
      page: 1,
      pageSize: 10,
    });

    // 확인
    assert.deepEqual(received[0], { filters: { keyword: '예약' }, sort: 'DEADLINE_SOON', page: 1 });
  });
});

function applicationRow(overrides: Partial<ApplicationRow> = {}): ApplicationRow {
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

function makeDb(rows: ApplicationRow[]) {
  const events: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  const db: AProjectDb = {
    application: {
      async findMany() {
        return rows;
      },
      async updateMany(input) {
        const where = input.where as { id?: string; status?: { in: readonly string[] } };
        let count = 0;
        rows.forEach((row, index) => {
          if (where.id !== undefined && row.id !== where.id) return;
          if (where.status?.in !== undefined && !where.status.in.includes(row.status)) return;
          rows[index] = { ...row, status: (input.data as { status: ApplicationRow['status'] }).status };
          count += 1;
        });
        return { count };
      },
      async count() {
        return rows.filter((row) => row.status === 'SUBMITTED' || row.status === 'STALE').length;
      },
    },
    eventLog: {
      async create(input) {
        events.push(input.data as Record<string, unknown>);
        return input.data;
      },
      async findFirst() {
        return null;
      },
    },
    notification: {
      findUnique: async () => null,
      async create(input) {
        notifications.push({ ...input.data });
        return { ...input.data, id: 'n1', isRead: false };
      },
      update: unused,
      findMany: async () => [],
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
    },
  };
  return { db, events, notifications, rows };
}

describe('A가 호출하는 B 열람·지원 Port', () => {
  it('상세 열람을 EventLog에 남긴다', async () => {
    // 준비
    const fixture = makeDb([]);
    const port = createAProjectViewPort(fixture.db);

    // 실행
    await port.recordFirstView({ projectId: 'prj-1', supplierId: 'supplier-1', at: FIXED_NOW });

    // 확인
    assert.deepEqual(fixture.events[0], {
      userId: 'supplier-1',
      type: 'SPEC_DETAIL_VIEWED',
      projectId: 'prj-1',
      occurredAt: FIXED_NOW,
    });
  });

  it('명세 변경은 같은 tx에서 STALE 전환과 재견적 알림을 남긴다', async () => {
    // 준비
    const fixture = makeDb([applicationRow()]);
    const port = createAProjectApplicationPort(fixture.db);

    // 실행
    const changed = await port.markSpecStale(fixture.db, {
      projectId: 'prj-1',
      newVersionNo: 2,
      at: FIXED_NOW,
    });

    // 확인
    assert.equal(changed, 1);
    assert.equal(fixture.notifications[0]?.type, 'REQUOTE_REQUESTED');
    assert.equal(fixture.notifications[0]?.targetId, 'app-1');
  });

  it('대기 지원 수를 세고, 프로젝트 삭제 시 대기 지원을 거절한다', async () => {
    // 준비
    const fixture = makeDb([
      applicationRow({ id: 'app-1', status: 'SUBMITTED' }),
      applicationRow({ id: 'app-2', status: 'STALE' }),
      applicationRow({ id: 'app-3', status: 'ACCEPTED' }),
    ]);
    const port = createAProjectApplicationPort(fixture.db);

    // 실행 및 확인
    assert.equal(await port.countPending(fixture.db, 'prj-1'), 2);
    assert.equal(
      await port.rejectPendingOnDelete(fixture.db, { projectId: 'prj-1', at: FIXED_NOW }),
      2,
    );
    // 확인
    assert.deepEqual(
      fixture.rows.map((row) => [row.id, row.status]),
      [
        ['app-1', 'REJECTED'],
        ['app-2', 'REJECTED'],
        ['app-3', 'ACCEPTED'],
      ],
    );
  });
});
