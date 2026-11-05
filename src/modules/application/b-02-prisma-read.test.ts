import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPrismaApplicationReadPort,
  type ApplicationReadDelegate,
  type ApplicationRow,
} from './prisma-adapter.ts';
import { FIXED_NOW } from '../../../tests/b/fixtures.ts';

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
    message: '안녕하세요',
    questions: [{ text: '질문 1' }],
    isMessageMasked: false,
    revisionReason: null,
    firstViewedAt: FIXED_NOW,
    submittedAt: FIXED_NOW,
    items: [{ specItemId: 'spec-1', isAvailable: true }],
    project: { draft: { clientId: 'client-1' } },
    ...overrides,
  };
}

function db(rows: readonly ApplicationRow[]) {
  const calls: unknown[] = [];
  const delegate: ApplicationReadDelegate = {
    async findMany(input) {
      calls.push(input.where);
      return rows.filter((candidate) => {
        const where = input.where as {
          projectId?: string;
          supplierId?: string;
          project?: { is?: { draft?: { is?: { clientId?: string } } } };
        };
        if (where.projectId !== undefined && candidate.projectId !== where.projectId) return false;
        if (where.supplierId !== undefined && candidate.supplierId !== where.supplierId) return false;
        const owner = where.project?.is?.draft?.is?.clientId;
        if (owner !== undefined && candidate.project.draft.clientId !== owner) {
          return false;
        }
        return true;
      });
    },
    async findUnique(input) {
      return rows.find((candidate) => candidate.id === input.where.id) ?? null;
    },
  };
  return {
    calls,
    client: {
      application: delegate,
      project: {
        async findUnique(input: { where: { id: string } }) {
          return input.where.id === 'prj-1' ? { draft: { clientId: 'client-1' } } : null;
        },
      },
    },
  };
}

describe('B-02 Prisma 읽기 어댑터', () => {
  it('Project.draft.clientId를 Application.clientUserId로 매핑한다', async () => {
    // 준비
    const port = createPrismaApplicationReadPort(db([row()]).client);

    // 실행
    const revision = await port.findRevision('app-1');

    // 확인
    assert.equal(revision?.clientUserId, 'client-1');
    assert.deepEqual(revision?.questions, [{ text: '질문 1' }]);
    assert.deepEqual(revision?.items, [{ specItemId: 'spec-1', isAvailable: true }]);
  });

  it('의뢰인은 project.clientId로, 공급자는 supplierId로 필터한다', async () => {
    // 준비
    const fixture = db([row(), row({ id: 'app-2', supplierId: 'supplier-2' })]);
    const port = createPrismaApplicationReadPort(fixture.client);

    // 실행
    const mine = await port.listForUser({ userId: 'client-1', role: 'CLIENT' });
    const supplier = await port.listForUser({ userId: 'supplier-2', role: 'SUPPLIER' });

    // 확인
    assert.deepEqual(mine.map((item) => item.id), ['app-1', 'app-2']);
    assert.deepEqual(supplier.map((item) => item.id), ['app-2']);
    assert.deepEqual(fixture.calls[0], {
      project: { is: { draft: { is: { clientId: 'client-1' } } } },
    });
    assert.deepEqual(fixture.calls[1], { supplierId: 'supplier-2' });
  });

  it('프로젝트 의뢰인 ID와 회차 목록을 제공한다', async () => {
    // 준비
    const port = createPrismaApplicationReadPort(
      db([row({ revisionNo: 2 }), row({ id: 'app-0', revisionNo: 1 })]).client,
    );

    // 실행 및 확인
    assert.equal(await port.findProjectClientId('prj-1'), 'client-1');
    assert.equal(await port.findProjectClientId('prj-2'), null);
    assert.equal((await port.listRevisionsByProject('prj-1')).length, 2);
  });

  it('비교 카드는 공개 동의·게시된 요약만 노출하고 연락처를 가린다', async () => {
    // 준비
    const fixture = db([row()]);
    const calls: unknown[] = [];
    const port = createPrismaApplicationReadPort({
      ...fixture.client,
      supplierProfile: {
        async findMany(input) {
          calls.push(input);
          return [
            {
              userId: 'supplier-1', careerYears: 8, ratingAvg: 4.8, reviewCount: 3,
              portfolioSummary: '메일 a@b.com', portfolioSummaryStatus: 'PUBLISHED',
              portfolioConsentAt: FIXED_NOW, user: { withdrawnAt: null }, applications: [{ id: 'completed-1' }],
            },
            {
              userId: 'supplier-2', careerYears: 2, ratingAvg: null, reviewCount: 0,
              portfolioSummary: '비공개 요약', portfolioSummaryStatus: 'HIDDEN',
              portfolioConsentAt: FIXED_NOW, user: { withdrawnAt: null }, applications: [],
            },
            {
              userId: 'supplier-3', careerYears: 2, ratingAvg: null, reviewCount: 0,
              portfolioSummary: '철회 사용자', portfolioSummaryStatus: 'PUBLISHED',
              portfolioConsentAt: FIXED_NOW, user: { withdrawnAt: FIXED_NOW }, applications: [],
            },
          ];
        },
      },
    });

    // 실행
    const summaries = await port.listSupplierProfileSummaries(['supplier-1', 'supplier-2', 'supplier-3']);

    // 확인
    assert.equal(calls.length, 1);
    assert.deepEqual(summaries, [{
      supplierId: 'supplier-1', careerYears: 8, ratingAvg: 4.8, reviewCount: 3,
      completedContractCount: 1, portfolioSummary: '메일 [연락처 비공개]',
    }, {
      supplierId: 'supplier-2', careerYears: 2, ratingAvg: null, reviewCount: 0,
      completedContractCount: 0, portfolioSummary: null,
    }]);
  });

  it('깨진 questions JSON은 조용히 버리지 않고 거부한다', async () => {
    // 준비
    const port = createPrismaApplicationReadPort(db([row({ questions: 'broken' })]).client);

    // 실행 및 확인
    await assert.rejects(port.findRevision('app-1'), /INVALID_APPLICATION_QUESTIONS/);
  });
});
