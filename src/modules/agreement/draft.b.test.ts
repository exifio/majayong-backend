import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AgreementExtractionError,
  buildAgreementDraft,
  isDraftFresh,
  previewAgreementDraft,
  refreshAgreementDraft,
  type AgreementDraft,
  type AgreementExtraction,
  type AgreementExtractionPort,
  type AgreementMessage,
  type AgreementSpec,
  type ConditionState,
} from './draft.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const CLIENT = 'client-1';
const SUPPLIER = 'supplier-1';

function spec(overrides: Partial<AgreementSpec> = {}): AgreementSpec {
  return {
    items: [
      {
        blockId: 'block-1',
        specItemId: 'spec-1',
        title: '예약 기능',
        stage: 'FINAL',
        conditions: [
          { key: 'scope', text: '예약 가능 시간대' },
          { key: 'warranty', text: '버그 수정 기간' },
        ],
      },
      {
        blockId: 'block-2',
        specItemId: null,
        title: '지급 구간',
        stage: 'INTERIM',
        conditions: [{ key: 'milestone', text: '중간 지급 시점' }],
      },
    ],
    defaultInterimRatio: 50,
    ...overrides,
  };
}

function message(
  id: string,
  senderId: string | null,
  minute: number,
  body = '확인했습니다.',
): AgreementMessage {
  return {
    id,
    senderId,
    body,
    createdAt: new Date(Date.UTC(2026, 10, 3, 0, minute, 0)),
  };
}

function extraction(
  items: AgreementExtraction['items'],
  overrides: Partial<AgreementExtraction> = {},
): AgreementExtraction {
  return { items, ...overrides };
}

function findState(draft: AgreementDraft, blockId: string, key: string): ConditionState {
  const item = draft.items.find((candidate) => candidate.blockId === blockId);
  assert.ok(item, `block ${blockId} 없음`);
  const condition = item.conditions.find((candidate) => candidate.key === key);
  assert.ok(condition, `condition ${key} 없음`);
  return condition.state;
}

function findEvidence(draft: AgreementDraft, blockId: string, key: string): readonly string[] {
  const item = draft.items.find((candidate) => candidate.blockId === blockId);
  assert.ok(item);
  const condition = item.conditions.find((candidate) => candidate.key === key);
  assert.ok(condition);
  return condition.evidenceMessageIds;
}

function throwsCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof AgreementExtractionError && error.status === 502 && error.code === code;
}

describe('B-04-T01 한쪽만 말한 조건은 PROPOSED', () => {
  it('의뢰인 한 명의 근거만 있으면 PROPOSED이고 근거가 남는다', () => {
    // 준비
    const messages = [message('m1', CLIENT, 1, '예약은 30분 단위로 해주세요.')];

    // 실행
    const draft = buildAgreementDraft(
      extraction([
        {
          blockId: 'block-1',
          conditions: [{ key: 'scope', state: 'PROPOSED', evidenceMessageIds: ['m1'] }],
        },
      ]),
      { spec: spec(), messages, now: NOW },
    );

    // 확인
    assert.equal(findState(draft, 'block-1', 'scope'), 'PROPOSED');
    assert.deepEqual(findEvidence(draft, 'block-1', 'scope'), ['m1']);
    assert.equal(draft.lastMessageAt?.toISOString(), messages[0]?.createdAt.toISOString());
    assert.equal(draft.cachedAt.toISOString(), NOW.toISOString());
  });

  it('지급 비율을 말하지 않으면 기본값과 UNDECIDED다', () => {
    // 실행
    const draft = buildAgreementDraft(extraction([]), {
      spec: spec(),
      messages: [message('m1', CLIENT, 1)],
      now: NOW,
    });

    // 확인
    assert.equal(draft.interimRatio, 50);
    assert.equal(draft.ratioState, 'UNDECIDED');
  });
});

describe('B-04-T02 근거 없는 DECIDED 거부', () => {
  const messages = [
    message('m1', CLIENT, 1),
    message('m2', SUPPLIER, 2),
    message('m3', CLIENT, 3),
  ];

  it('근거가 없으면 AGREEMENT_EVIDENCE_REQUIRED로 거부한다', () => {
    // 실행 및 확인
    assert.throws(
      () =>
        buildAgreementDraft(
          extraction([
            {
              blockId: 'block-1',
              conditions: [{ key: 'scope', state: 'DECIDED' }],
            },
          ]),
          { spec: spec(), messages, now: NOW },
        ),
      throwsCode('AGREEMENT_EVIDENCE_REQUIRED'),
    );
  });

  it('한 사람의 메시지만 근거로는 DECIDED가 될 수 없다', () => {
    // 실행 및 확인
    assert.throws(
      () =>
        buildAgreementDraft(
          extraction([
            {
              blockId: 'block-1',
              conditions: [
                { key: 'scope', state: 'DECIDED', evidenceMessageIds: ['m1', 'm3'] },
              ],
            },
          ]),
          { spec: spec(), messages, now: NOW },
        ),
      throwsCode('AGREEMENT_EVIDENCE_REQUIRED'),
    );
  });

  it('양측 근거가 있으면 DECIDED다', () => {
    // 실행
    const draft = buildAgreementDraft(
      extraction([
        {
          blockId: 'block-1',
          conditions: [
            { key: 'scope', state: 'DECIDED', evidenceMessageIds: ['m1', 'm2'] },
          ],
        },
      ]),
      { spec: spec(), messages, now: NOW },
    );

    // 확인
    assert.equal(findState(draft, 'block-1', 'scope'), 'DECIDED');
    assert.deepEqual(findEvidence(draft, 'block-1', 'scope'), ['m1', 'm2']);
  });

  it('새 추출이 거부되면 이전 캐시를 유지하고 실패를 표시한다', async () => {
    // 실행
    const previous = buildAgreementDraft(
      extraction([
        {
          blockId: 'block-1',
          conditions: [
            { key: 'warranty', state: 'DECIDED', evidenceMessageIds: ['m1', 'm2'] },
          ],
        },
      ]),
      { spec: spec(), messages, now: NOW },
    );

    // 준비
    const port: AgreementExtractionPort = {
      async extract() {
        return extraction([
          {
            blockId: 'block-1',
            conditions: [{ key: 'scope', state: 'DECIDED' }],
          },
        ]);
      },
    };

    // 실행
    const result = await refreshAgreementDraft(port, {
      spec: spec(),
      messages: [...messages, message('m4', CLIENT, 4)],
      now: new Date('2026-11-03T12:05:00.000Z'),
      previous,
    });

    // 확인
    assert.equal(result.failed, true);
    assert.equal(result.refreshed, false);
    assert.equal(result.errorCode, 'AGREEMENT_EVIDENCE_REQUIRED');
    assert.equal(result.draft.cachedAt.toISOString(), previous.cachedAt.toISOString());
    assert.equal(findState(result.draft, 'block-1', 'warranty'), 'DECIDED');
    assert.equal(findState(result.draft, 'block-1', 'scope'), 'UNDECIDED');
  });
});

describe('B-04-T03 가장 최근 합의만 인정', () => {
  const messages = [
    message('m1', CLIENT, 1, '보증 3개월로 할까요?'),
    message('m2', SUPPLIER, 2, '네, 3개월 가능합니다.'),
    message('m3', CLIENT, 3, '역시 6개월로 늘릴 수 있을까요?'),
    message('m4', SUPPLIER, 4, '6개월로 하겠습니다.'),
  ];

  it('같은 조건에 합의가 여러 번 있으면 근거가 가장 최근인 합의를 쓴다', () => {
    // 실행
    const draft = buildAgreementDraft(
      extraction([
        {
          blockId: 'block-1',
          conditions: [
            { key: 'warranty', state: 'DECIDED', evidenceMessageIds: ['m1', 'm2'] },
            { key: 'warranty', state: 'DECIDED', evidenceMessageIds: ['m3', 'm4'] },
          ],
        },
      ]),
      { spec: spec(), messages, now: NOW },
    );

    // 확인
    assert.equal(findState(draft, 'block-1', 'warranty'), 'DECIDED');
    assert.deepEqual(findEvidence(draft, 'block-1', 'warranty'), ['m3', 'm4']);
  });

  it('최근에 다시 제안하면 과거 합의를 DECIDED로 유지하지 않는다', () => {
    // 실행
    const draft = buildAgreementDraft(
      extraction([
        {
          blockId: 'block-1',
          conditions: [
            { key: 'warranty', state: 'DECIDED', evidenceMessageIds: ['m1', 'm2'] },
            { key: 'warranty', state: 'PROPOSED', evidenceMessageIds: ['m3', 'm4'] },
          ],
        },
      ]),
      { spec: spec(), messages, now: NOW },
    );

    // 확인
    assert.equal(findState(draft, 'block-1', 'warranty'), 'PROPOSED');
    assert.deepEqual(findEvidence(draft, 'block-1', 'warranty'), ['m3', 'm4']);
  });
});

describe('B-04-T04 새 메시지 후 캐시 무효화', () => {
  const messages = [message('m1', CLIENT, 1), message('m2', SUPPLIER, 2)];

  const draft = buildAgreementDraft(
    extraction([
      {
        blockId: 'block-1',
        conditions: [{ key: 'scope', state: 'DECIDED', evidenceMessageIds: ['m1', 'm2'] }],
      },
    ]),
    { spec: spec(), messages, now: NOW },
  );

  it('마지막 반영 메시지까지는 캐시가 최신이다', () => {
    // 실행 및 확인
    assert.equal(isDraftFresh(draft, messages), true);
    assert.equal(isDraftFresh(draft, messages.slice(0, 1)), true);
  });

  it('더 새로운 메시지가 오면 캐시가 낡는다', () => {
    // 실행 및 확인
    assert.equal(isDraftFresh(draft, [...messages, message('m3', CLIENT, 9)]), false);
  });

  it('캐시가 최신이면 추출기를 호출하지 않는다', async () => {
    // 준비
    let calls = 0;
    const port: AgreementExtractionPort = {
      async extract() {
        calls += 1;
        throw new Error('호출되면 안 된다');
      },
    };

    // 실행
    const result = await refreshAgreementDraft(port, {
      spec: spec(),
      messages,
      now: new Date('2026-11-03T12:10:00.000Z'),
      previous: draft,
    });

    // 확인
    assert.equal(calls, 0);
    assert.equal(result.refreshed, false);
    assert.equal(result.failed, false);
    assert.equal(result.draft.cachedAt.toISOString(), draft.cachedAt.toISOString());
  });

  it('새 메시지가 있으면 다시 추출해 캐시를 교체한다', async () => {
    // 준비
    const nextMessages = [...messages, message('m3', SUPPLIER, 9)];
    let calls = 0;
    const port: AgreementExtractionPort = {
      async extract(input) {
        calls += 1;
        assert.equal(input.messages.length, 3);
        return extraction([
          {
            blockId: 'block-1',
            conditions: [
              { key: 'scope', state: 'DECIDED', evidenceMessageIds: ['m1', 'm2', 'm3'] },
            ],
          },
        ]);
      },
    };

    const refreshedAt = new Date('2026-11-03T12:10:00.000Z');
    // 실행
    const result = await refreshAgreementDraft(port, {
      spec: spec(),
      messages: nextMessages,
      now: refreshedAt,
      previous: draft,
    });

    // 확인
    assert.equal(calls, 1);
    assert.equal(result.refreshed, true);
    assert.equal(result.failed, false);
    assert.equal(result.draft.cachedAt.toISOString(), refreshedAt.toISOString());
    assert.equal(
      result.draft.lastMessageAt?.toISOString(),
      nextMessages[2]?.createdAt.toISOString(),
    );
    assert.equal(isDraftFresh(result.draft, nextMessages), true);
  });
});

describe('B-04-T05 없는 Block·조건·메시지 거부', () => {
  const messages = [message('m1', CLIENT, 1), message('m2', SUPPLIER, 2)];

  it('명세에 없는 blockId는 UNKNOWN_BLOCK이다', () => {
    // 실행 및 확인
    assert.throws(
      () =>
        buildAgreementDraft(
          extraction([{ blockId: 'block-x', conditions: [] }]),
          { spec: spec(), messages, now: NOW },
        ),
      throwsCode('UNKNOWN_BLOCK'),
    );
  });

  it('그 블록에 없는 조건 key는 UNKNOWN_CONDITION이다', () => {
    // 실행 및 확인
    assert.throws(
      () =>
        buildAgreementDraft(
          extraction([
            {
              blockId: 'block-1',
              conditions: [{ key: 'made-up', state: 'PROPOSED' }],
            },
          ]),
          { spec: spec(), messages, now: NOW },
        ),
      throwsCode('UNKNOWN_CONDITION'),
    );
  });

  it('대화에 없는 근거 메시지는 UNKNOWN_EVIDENCE다', () => {
    // 실행 및 확인
    assert.throws(
      () =>
        buildAgreementDraft(
          extraction([
            {
              blockId: 'block-1',
              conditions: [
                { key: 'scope', state: 'PROPOSED', evidenceMessageIds: ['m1', 'm-ghost'] },
              ],
            },
          ]),
          { spec: spec(), messages, now: NOW },
        ),
      throwsCode('UNKNOWN_EVIDENCE'),
    );
  });

  it('알 수 없는 상태값은 INVALID_EXTRACTION이다', () => {
    // 실행 및 확인
    assert.throws(
      () =>
        buildAgreementDraft(
          extraction([
            {
              blockId: 'block-1',
              conditions: [
                {
                  key: 'scope',
                  state: 'AGREED' as unknown as ConditionState,
                  evidenceMessageIds: ['m1'],
                },
              ],
            },
          ]),
          { spec: spec(), messages, now: NOW },
        ),
      throwsCode('INVALID_EXTRACTION'),
    );
  });

  it('지급 비율이 10~90 밖이면 INVALID_INTERIM_RATIO다', () => {
    // 확인
    for (const interimRatio of [9, 91, 0, 120]) {
      assert.throws(
        () =>
          buildAgreementDraft(extraction([], { interimRatio }), {
            spec: spec(),
            messages,
            now: NOW,
          }),
        throwsCode('INVALID_INTERIM_RATIO'),
      );
    }

    // 실행
    const draft = buildAgreementDraft(
      extraction([], { interimRatio: 90, ratioState: 'PROPOSED' }),
      { spec: spec(), messages, now: NOW },
    );
    // 확인
    assert.equal(draft.interimRatio, 90);
    assert.equal(draft.ratioState, 'PROPOSED');
  });
});

describe('B-04-T06 말하지 않은 조건은 UNDECIDED', () => {
  it('명세의 모든 항목과 조건을 유지하고 미언급 조건은 비워 둔다', () => {
    // 실행
    const draft = buildAgreementDraft(
      extraction([
        {
          blockId: 'block-1',
          conditions: [
            { key: 'scope', state: 'PROPOSED', evidenceMessageIds: ['m1'] },
          ],
        },
      ]),
      {
        spec: spec(),
        messages: [message('m1', CLIENT, 1)],
        now: NOW,
      },
    );

    // 확인
    assert.deepEqual(
      draft.items.map((item) => item.blockId),
      ['block-1', 'block-2'],
    );

    // 준비
    const first = draft.items[0];
    // 확인
    assert.ok(first);
    assert.equal(first.title, '예약 기능');
    assert.equal(first.specItemId, 'spec-1');
    assert.equal(first.stage, 'FINAL');
    assert.deepEqual(
      first.conditions.map((condition) => condition.key),
      ['scope', 'warranty'],
    );
    assert.equal(findState(draft, 'block-1', 'warranty'), 'UNDECIDED');
    assert.deepEqual(findEvidence(draft, 'block-1', 'warranty'), []);
    assert.equal(findState(draft, 'block-2', 'milestone'), 'UNDECIDED');
  });

  it('제목·단계는 명세를 쓰고 LLM 값을 신뢰하지 않는다', () => {
    // 실행
    const draft = buildAgreementDraft(
      extraction([
        {
          blockId: 'block-1',
          title: '조작된 제목',
          stage: 'INTERIM',
          conditions: [],
        } as unknown as AgreementExtraction['items'][number],
      ]),
      { spec: spec(), messages: [message('m1', CLIENT, 1)], now: NOW },
    );

    // 준비
    const first = draft.items[0];
    // 확인
    assert.ok(first);
    assert.equal(first.title, '예약 기능');
    assert.equal(first.stage, 'FINAL');
  });
});

describe('B-04-T07 LLM 오류 시 안전한 실패', () => {
  const messages = [message('m1', CLIENT, 1), message('m2', SUPPLIER, 2)];

  const previous = buildAgreementDraft(
    extraction([
      {
        blockId: 'block-1',
        conditions: [{ key: 'scope', state: 'DECIDED', evidenceMessageIds: ['m1', 'm2'] }],
      },
    ]),
    { spec: spec(), messages, now: NOW },
  );

  it('추출기가 예외를 던지면 이전 캐시를 낡은 상태로 돌려준다', async () => {
    // 준비
    const port: AgreementExtractionPort = {
      async extract() {
        throw new Error('LLM timeout');
      },
    };

    // 실행
    const result = await refreshAgreementDraft(port, {
      spec: spec(),
      messages: [...messages, message('m3', CLIENT, 3)],
      now: new Date('2026-11-03T12:20:00.000Z'),
      previous,
    });

    // 확인
    assert.equal(result.failed, true);
    assert.equal(result.refreshed, false);
    assert.equal(result.stale, true);
    assert.equal(result.draft.cachedAt.toISOString(), previous.cachedAt.toISOString());
    assert.equal(findState(result.draft, 'block-1', 'scope'), 'DECIDED');
  });

  it('캐시가 없고 추출기가 실패하면 전부 UNDECIDED 기본값이다', async () => {
    // 준비
    const port: AgreementExtractionPort = {
      async extract() {
        throw new Error('LLM timeout');
      },
    };

    // 실행
    const result = await refreshAgreementDraft(port, {
      spec: spec(),
      messages,
      now: new Date('2026-11-03T12:20:00.000Z'),
    });

    // 확인
    assert.equal(result.failed, true);
    assert.equal(result.stale, true);
    assert.equal(result.draft.interimRatio, 50);
    assert.equal(result.draft.ratioState, 'UNDECIDED');
    assert.equal(result.draft.lastMessageAt, null);
    for (const item of result.draft.items) {
      for (const condition of item.conditions) {
        assert.equal(condition.state, 'UNDECIDED');
        assert.deepEqual(condition.evidenceMessageIds, []);
      }
    }
  });

  it('형식이 깨진 응답은 INVALID_EXTRACTION으로 안전 실패한다', async () => {
    // 실행 및 확인
    for (const malformed of [null, 'text', { items: 'nope' }, { items: [{}] }]) {
      const port: AgreementExtractionPort = {
        async extract() {
          return malformed;
        },
      };

      const result = await refreshAgreementDraft(port, {
        spec: spec(),
        messages,
        now: NOW,
      });

      assert.equal(result.failed, true);
      assert.equal(result.refreshed, false);
      assert.equal(result.stale, true);
      assert.equal(result.draft.lastMessageAt, null);
    }
  });
});

describe('B-04-T08 읽기 전용 agreement-preview', () => {
  const messages = [message('m1', CLIENT, 1), message('m2', SUPPLIER, 2)];

  const cached = buildAgreementDraft(
    extraction([
      {
        blockId: 'block-1',
        conditions: [{ key: 'scope', state: 'DECIDED', evidenceMessageIds: ['m1', 'm2'] }],
      },
    ]),
    { spec: spec(), messages, now: NOW },
  );

  it('저장된 초안을 그대로 돌려주고 확정 조건을 바꾸지 않는다', () => {
    // 준비
    const before = JSON.stringify(cached);

    // 실행
    const preview = previewAgreementDraft({
      spec: spec(),
      messages,
      cached,
      now: new Date('2026-11-03T12:30:00.000Z'),
    });

    // 확인
    assert.equal(preview.readOnly, true);
    assert.equal(preview.stale, false);
    assert.equal(preview.draft, cached);
    assert.equal(findState(preview.draft, 'block-1', 'scope'), 'DECIDED');
    assert.equal(findState(preview.draft, 'block-1', 'warranty'), 'UNDECIDED');
    assert.equal(JSON.stringify(cached), before);
  });

  it('새 메시지가 있으면 갱신하지 않고 stale로만 표시한다', () => {
    // 실행
    const preview = previewAgreementDraft({
      spec: spec(),
      messages: [...messages, message('m3', CLIENT, 3)],
      cached,
      now: new Date('2026-11-03T12:30:00.000Z'),
    });

    // 확인
    assert.equal(preview.stale, true);
    assert.equal(preview.draft, cached);
    assert.equal(preview.draft.cachedAt.toISOString(), cached.cachedAt.toISOString());
  });

  it('캐시가 없으면 LLM 없이 전부 UNDECIDED 기본값이다', () => {
    // 실행
    const preview = previewAgreementDraft({
      spec: spec(),
      messages,
      cached: null,
      now: NOW,
    });

    // 확인
    assert.equal(preview.readOnly, true);
    assert.equal(preview.stale, false);
    assert.equal(preview.draft.interimRatio, 50);
    assert.equal(preview.draft.ratioState, 'UNDECIDED');
    for (const item of preview.draft.items) {
      for (const condition of item.conditions) {
        assert.equal(condition.state, 'UNDECIDED');
        assert.deepEqual(condition.evidenceMessageIds, []);
      }
    }
  });
});
