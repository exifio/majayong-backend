import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPrismaAgreementDraftStore } from './prisma-adapter.ts';
import type { AgreementDraft } from './draft.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');

describe('B-04 agreementDraft 어댑터', () => {
  it('JSON 날짜를 왕복 변환한다', async () => {
    // 준비
    const databaseNull = Object.freeze({ dbNull: true });
    let stored: unknown = databaseNull;
    const prisma = {
      application: {
        async findUnique() {
          return { agreementDraft: stored === databaseNull ? null : stored };
        },
        async update(input: { data: { agreementDraft: unknown } }) {
          stored = input.data.agreementDraft;
          return { id: 'app-1' };
        },
      },
    };
    const store = createPrismaAgreementDraftStore(prisma, { databaseNull });
    const draft: AgreementDraft = {
      items: [{
        blockId: 'block-1', specItemId: 'spec-1', title: '예약', stage: 'FINAL',
        conditions: [{ key: 'scope', text: '시간', state: 'PROPOSED', evidenceMessageIds: ['msg-1'] }],
      }],
      interimRatio: 50, ratioState: 'UNDECIDED', cachedAt: NOW, lastMessageAt: NOW,
    };

    // 실행
    await store.save('app-1', draft);
    const loaded = await store.get('app-1');
    // 확인
    assert.deepEqual(loaded, draft);
    assert.ok(loaded?.cachedAt instanceof Date);
    assert.ok(loaded?.lastMessageAt instanceof Date);
  });

  it('데이터베이스 null 센티널로 무효화한다', async () => {
    // 준비
    const databaseNull = Object.freeze({ dbNull: true });
    let stored: unknown = { stale: true };
    const prisma = {
      application: {
        async findUnique() { return { agreementDraft: stored === databaseNull ? null : stored }; },
        async update(input: { data: { agreementDraft: unknown } }) {
          stored = input.data.agreementDraft;
          return { id: 'app-1' };
        },
      },
    };
    const store = createPrismaAgreementDraftStore(prisma, { databaseNull });

    // 실행
    await store.invalidate('app-1');

    // 확인
    assert.equal(stored, databaseNull);
    // 실행 및 확인
    assert.equal(await store.get('app-1'), null);
  });

  it('검증된 합의 상태를 왕복 변환하고 증빙 재검증은 도메인에 맡긴다', async () => {
    // 준비
    const databaseNull = Object.freeze({ dbNull: true });
    let stored: unknown = databaseNull;
    const prisma = {
      application: {
        async findUnique() { return { agreementDraft: stored === databaseNull ? null : stored }; },
        async update(input: { data: { agreementDraft: unknown } }) {
          stored = input.data.agreementDraft;
          return { id: 'app-1' };
        },
      },
    };
    const store = createPrismaAgreementDraftStore(prisma, { databaseNull });
    const draft: AgreementDraft = {
      items: [{
        blockId: 'block-1', specItemId: 'spec-1', title: '예약', stage: 'FINAL',
        conditions: [{ key: 'scope', text: '시간', state: 'DECIDED', evidenceMessageIds: ['m-old'] }],
      }],
      interimRatio: 50, ratioState: 'DECIDED', cachedAt: NOW, lastMessageAt: NOW,
    };

    // 실행
    await store.save('app-1', draft);
    const loaded = await store.get('app-1');
    // 확인
    assert.equal(loaded?.items[0]?.conditions[0]?.state, 'DECIDED');
    assert.deepEqual(loaded?.items[0]?.conditions[0]?.evidenceMessageIds, ['m-old']);
    assert.equal(loaded?.ratioState, 'DECIDED');
  });

  it('데이터베이스 경계에서 잘못된 캐시 JSON을 거부한다', async () => {
    // 준비
    const prisma = {
      application: {
        async findUnique() { return { agreementDraft: { items: 'not-an-array' } }; },
        async update() { return { id: 'app-1' }; },
      },
    };
    const store = createPrismaAgreementDraftStore(prisma, { databaseNull: Object.freeze({ dbNull: true }) });

    // 실행 및 확인
    await assert.rejects(store.get('app-1'), /Invalid agreementDraft JSON/);
  });
});
