import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAProjectSearchPort,
  createProjectCandidatePort,
  type CandidateProjectRow,
  type ProjectCandidateDb,
} from '../../integration/a-ports.ts';
import { createProjectSearchPort } from './project-search.ts';

function row(overrides: Partial<CandidateProjectRow> = {}): CandidateProjectRow {
  return {
    id: 'prj-1',
    title: '예약 사이트',
    summary: '예약',
    industryCode: 'FOOD',
    requiredSkills: ['React'],
    hopeBudget: 4_000_000,
    deadline: new Date('2026-11-10T00:00:00.000Z'),
    publishedAt: new Date('2026-11-01T00:00:00.000Z'),
    currentVersion: 1,
    status: 'RECRUITING',
    items: [{ title: '예약', versionNo: 1 }],
    ...overrides,
  };
}

function fakeDb(rows: CandidateProjectRow[]): ProjectCandidateDb {
  return {
    project: {
      async findMany(input) {
        const where = input.where as { status?: { in: readonly string[] } };
        return rows.filter((candidate) =>
          where.status?.in === undefined ? true : where.status.in.includes(candidate.status),
        );
      },
    },
  };
}

function searchPort(rows: CandidateProjectRow[]) {
  return createAProjectSearchPort(createProjectSearchPort(createProjectCandidatePort(fakeDb(rows))));
}

describe('G2-01: A 공개 검색 Port (후보 → 필터 → id 목록)', () => {
  it('비공개 상태(SCHEDULED)를 제외하고 공개 상태만 후보로 넘긴다', async () => {
    // 실행
    const result = await searchPort([
      row({ id: 'prj-a' }),
      row({ id: 'prj-b', status: 'SCHEDULED' }),
      row({ id: 'prj-c', hopeBudget: 12_000_000 }),
    ]).searchPublicProjects({ filters: {}, page: 1, pageSize: 10 });

    // 확인
    assert.deepEqual(result.projectIds, ['prj-a', 'prj-c']);
    assert.equal(result.total, 2);
  });

  it('예산 필터는 구간 경계로 판정한다 (400만원 후보 ↔ minBudget 500만원 제외)', async () => {
    // 실행
    const excluded = await searchPort([row({ id: 'prj-a', hopeBudget: 4_000_000 })]).searchPublicProjects({
      filters: { minBudget: 5_000_000 },
      page: 1,
      pageSize: 10,
    });
    // 확인
    assert.deepEqual(excluded.projectIds, []);

    // 실행
    const included = await searchPort([row({ id: 'prj-a', hopeBudget: 4_000_000 })]).searchPublicProjects({
      filters: { minBudget: 3_000_000 },
      page: 1,
      pageSize: 10,
    });
    // 확인
    assert.deepEqual(included.projectIds, ['prj-a']);
  });

  it('예산 필터 상한은 미포함이다 (정확히 200만원은 200만원 미만이 아니다)', async () => {
    // 실행
    const under = await searchPort([row({ id: 'prj-a', hopeBudget: 1_999_999 })]).searchPublicProjects({
      filters: { maxBudget: 2_000_000 },
      page: 1,
      pageSize: 10,
    });
    // 확인
    assert.deepEqual(under.projectIds, ['prj-a']);

    // 실행
    const boundary = await searchPort([row({ id: 'prj-b', hopeBudget: 2_000_000 })]).searchPublicProjects({
      filters: { maxBudget: 2_000_000 },
      page: 1,
      pageSize: 10,
    });
    // 확인
    assert.deepEqual(boundary.projectIds, []);

    // 실행
    const fromBoundary = await searchPort([row({ id: 'prj-c', hopeBudget: 2_000_000 })]).searchPublicProjects({
      filters: { minBudget: 2_000_000 },
      page: 1,
      pageSize: 10,
    });
    // 확인
    assert.deepEqual(fromBoundary.projectIds, ['prj-c']);
  });

  it('후보 변환 결과에 정확 예산이 없고 구간 경계만 있다', async () => {
    // 실행
    const candidates = (await createProjectCandidatePort(
      fakeDb([row({ id: 'prj-a', hopeBudget: 4_500_000 })]),
    ).listPublicProjectCandidates()) as Array<Record<string, unknown>>;

    // 확인
    assert.equal(candidates[0]?.hopeBudget, undefined);
    assert.deepEqual(candidates[0]?.hopeBudgetRange, { minKrw: 4_000_000, maxKrw: 4_999_999 });
    assert.equal(JSON.stringify(candidates).includes('4500000'), false);
  });
});
