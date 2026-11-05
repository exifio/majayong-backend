import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarizeBMetrics } from './metrics.ts';
import {
  loadBMetricSource,
  type MetricQueryRunner,
} from './metrics-sql.ts';

const SINCE = new Date('2026-11-01T00:00:00.000Z');
const NOW = new Date('2026-11-04T00:00:00.000Z');

interface Fixture {
  quotes?: readonly { firstViewedAt: Date; submittedAt: Date }[];
  applied?: readonly { id: string }[];
  inquiries?: readonly { id: string }[];
  contracts?: readonly Record<string, unknown>[];
  reports?: readonly { projectId: string; supplierId: string; action: string | null }[];
  rooms?: readonly { id: number }[];
}

function runner(fixture: Fixture): MetricQueryRunner {
  return {
    async query<Row>(sql: string): Promise<readonly Row[]> {
      if (sql.includes('"firstViewedAt"')) return (fixture.quotes ?? []) as readonly Row[];
      if (sql.includes('INQUIRY_OPENED')) return (fixture.inquiries ?? []) as readonly Row[];
      if (sql.includes('CONTRACT_AGREED')) return (fixture.contracts ?? []) as readonly Row[];
      if (sql.includes('FROM reports')) return (fixture.reports ?? []) as readonly Row[];
      if (sql.includes('count(*)::int')) return (fixture.rooms ?? [{ id: 0 }]) as readonly Row[];
      return (fixture.applied ?? []) as readonly Row[];
    },
  };
}

describe('B-08-T05 PostgreSQL 지표 projection', () => {
  it('SQL row를 BMetricSource로 매핑하고 기존 요약 규칙과 일치한다', async () => {
    // 실행
    const source = await loadBMetricSource(
      runner({
        quotes: [
          { firstViewedAt: new Date('2026-11-01T10:00:00.000Z'), submittedAt: new Date('2026-11-01T11:00:00.000Z') },
          { firstViewedAt: new Date('2026-11-02T12:00:00.000Z'), submittedAt: new Date('2026-11-02T14:00:00.000Z') },
        ],
        applied: [{ id: 'p1' }, { id: 'p2' }],
        inquiries: [{ id: 'p1' }],
        contracts: [
          { type: 'APPLICATION_ACCEPTED', contractId: 'c1', conditionCount: 4, decidedCount: 3, reason: null },
          { type: 'CONTRACT_AGREED', contractId: 'c1', conditionCount: null, decidedCount: null, reason: null },
          { type: 'APPLICATION_ACCEPTED', contractId: 'c2', conditionCount: 2, decidedCount: 1, reason: null },
          { type: 'CONTRACT_BROKEN', contractId: 'c2', conditionCount: null, decidedCount: null, reason: 'CONSENT_TIMEOUT' },
        ],
        reports: [
          { projectId: 'p1', supplierId: 's1', action: 'WARNING' },
          { projectId: 'p1', supplierId: 's1', action: null },
        ],
        rooms: [{ id: 2 }],
      }),
      { since: SINCE, now: NOW },
    );

    const summary = summarizeBMetrics(source);
    // 확인
    assert.equal(summary.quoteDraft.count, 2);
    assert.equal(summary.quoteDraft.averageDurationMs, 5_400_000);
    assert.equal(summary.inquiryRate.rate, 0.5);
    assert.equal(summary.conditionDecisionRate.totalConditions, 6);
    assert.equal(summary.conditionDecisionRate.decidedConditions, 4);
    assert.equal(summary.contractBreakRate.brokenContracts, 1);
    assert.equal(summary.contractBreakRate.byReason.CONSENT_TIMEOUT, 1);
    assert.equal(summary.reportRate.chatRooms, 2);
    assert.equal(summary.reportRate.rate, 0.5);
    assert.equal(summary.reportRate.byAction.WARNING, 1);
    assert.equal(summary.reportRate.byAction.UNRESOLVED, 1);
  });

  it('알 수 없는 결렬 사유는 INVALID_METRIC_SOURCE로 거부한다', async () => {
    // 실행 및 확인
    await assert.rejects(
      loadBMetricSource(
        runner({
          contracts: [
            { type: 'CONTRACT_BROKEN', contractId: 'c1', conditionCount: null, decidedCount: null, reason: 'GHOST' },
          ],
        }),
        { since: SINCE, now: NOW },
      ),
      /INVALID_METRIC_SOURCE/,
    );
  });

  it('APPLICATION_ACCEPTED에 조건 수가 없으면 거부한다', async () => {
    // 실행 및 확인
    await assert.rejects(
      loadBMetricSource(
        runner({
          contracts: [
            { type: 'APPLICATION_ACCEPTED', contractId: 'c1', conditionCount: null, decidedCount: 3, reason: null },
          ],
        }),
        { since: SINCE, now: NOW },
      ),
      /INVALID_METRIC_SOURCE/,
    );
  });

  it('빈 구간은 0으로 요약한다', async () => {
    // 실행
    const summary = summarizeBMetrics(
      await loadBMetricSource(runner({ rooms: [{ id: 0 }] }), { since: SINCE, now: NOW }),
    );

    // 확인
    assert.equal(summary.quoteDraft.count, 0);
    assert.equal(summary.contractBreakRate.rate, 0);
    assert.equal(summary.reportRate.reportsPerChatRoom, 0);
  });
});
