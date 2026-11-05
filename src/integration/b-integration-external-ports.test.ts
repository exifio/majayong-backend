import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createChatAccountPort,
  createChatEventPort,
  createAgreementPreviewPort,
  createContractItemSourcePort,
  createDepositAttemptPort,
  createIntegrationPorts,
  createProjectStatePort,
  type IntegrationDb,
  type IntegrationTransactionDb,
} from './external-ports.ts';
import { HttpError } from '../http/envelope.ts';
import { FIXED_NOW } from '../../tests/b/fixtures.ts';

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

describe('A/C 읽기 Port 어댑터', () => {
  it('지원 제출용 프로젝트 상태는 현재 버전과 포함 항목 ID만 준다', async () => {
    // 준비
    const db: IntegrationDb = {
      project: {
        async findUnique() {
          return { id: 'prj-1', draft: { clientId: 'client-1' }, status: 'RECRUITING', currentVersion: 2 };
        },
      },
      specItem: {
        async findMany(input) {
          const where = input.where as { versionNo?: number; status?: string };
          assert.equal(where.versionNo, 2);
          assert.equal(where.status, 'INCLUDED');
          return [
            { id: 'spec-2', blockId: 'block-2', description: '결제', origin: 'CHAT', sortOrder: 1 },
          ];
        },
      },
      application: { findUnique: unused },
      user: { findUnique: unused },
      escrowDeposit: { count: unused },
      eventLog: { findFirst: unused, create: unused },
    };

    // 실행
    const state = await createProjectStatePort(db).getForApplication('prj-1');

    // 확인
    assert.deepEqual(state, {
      clientUserId: 'client-1',
      status: 'RECRUITING',
      currentVersion: 2,
      specItemIds: ['spec-2'],
    });
  });

  it('계약 항목 원천은 지원 회차의 명세 버전에서 읽는다', async () => {
    // 준비
    const db: IntegrationDb = {
      project: { findUnique: unused },
      application: {
        async findUnique() {
          return { projectId: 'prj-1', specVersionNo: 3 };
        },
      },
      specItem: {
        async findMany(input) {
          const where = input.where as { versionNo?: number };
          assert.equal(where.versionNo, 3);
          return [
            { id: 'spec-1', blockId: 'block-1', description: '예약', origin: 'FIRST_SENTENCE', sortOrder: 0 },
          ];
        },
      },
      user: { findUnique: unused },
      escrowDeposit: { count: unused },
      eventLog: { findFirst: unused, create: unused },
    };

    // 실행
    const sources = await createContractItemSourcePort(db).listSources('app-1');

    // 확인
    assert.deepEqual(sources, [
      { blockId: 'block-1', description: '예약', origin: 'FIRST_SENTENCE', sortOrder: 0 },
    ]);
  });

  it('합의 미리보기는 지원 명세 스냅샷 순서로 기본 지급 구간을 만들고 메시지 연락처를 가린다', async () => {
    // 준비
    const db: IntegrationDb = {
      project: { findUnique: unused },
      application: {
        async findUnique(input) {
          assert.equal(input.where.id, 'app-1');
          return { projectId: 'prj-1', specVersionNo: 3 };
        },
      },
      specItem: {
        findMany: unused,
        async findAgreementItems(input) {
          assert.equal(input.where.versionNo, 3);
          assert.deepEqual(input.orderBy, [{ sortOrder: 'asc' }, { id: 'asc' }]);
          return [
            { id: 's1', blockId: 'b1', title: '첫 항목', conditions: [{ key: 'scope', text: '범위' }], sortOrder: 0 },
            { id: 's2', blockId: 'b2', title: '둘째 항목', conditions: null, sortOrder: 1 },
            { id: 's3', blockId: 'b3', title: '셋째 항목', conditions: null, sortOrder: 2 },
          ];
        },
      },
      applicationMessage: {
        async findMany() {
          return [{ id: 'm1', senderId: 'supplier-1', body: 'email a@b.com', createdAt: FIXED_NOW }];
        },
      },
      user: { findUnique: unused },
      escrowDeposit: { count: unused },
      eventLog: { findFirst: unused, create: unused },
    };
    const preview = createAgreementPreviewPort(db);

    // 실행 및 확인
    assert.deepEqual(await preview.getSpec('app-1'), {
      items: [
        { blockId: 'b1', specItemId: 's1', title: '첫 항목', stage: 'INTERIM', conditions: [{ key: 'scope', text: '범위' }] },
        { blockId: 'b2', specItemId: 's2', title: '둘째 항목', stage: 'FINAL', conditions: [] },
        { blockId: 'b3', specItemId: 's3', title: '셋째 항목', stage: 'FINAL', conditions: [] },
      ],
      defaultInterimRatio: 50,
    });
    // 확인
    assert.equal((await preview.getMessages('app-1'))[0]?.body, 'email [연락처 비공개]');
  });

  it('채팅 계정 상태는 User 제재 필드만 읽고, 없는 계정은 401이다', async () => {
    // 준비
    const db: IntegrationDb = {
      project: { findUnique: unused },
      specItem: { findMany: unused },
      application: { findUnique: unused },
      user: {
        async findUnique(input) {
          return input.where.id === 'user-1'
            ? { suspendedAt: null, withdrawnAt: null, chatRestrictedUntil: FIXED_NOW }
            : null;
        },
      },
      escrowDeposit: { count: unused },
      eventLog: { findFirst: unused, create: unused },
    };
    const port = createChatAccountPort(db);

    // 실행 및 확인
    assert.deepEqual(await port.getAccountState('user-1'), {
      suspendedAt: null,
      withdrawnAt: null,
      chatRestrictedUntil: FIXED_NOW,
    });
    await assert.rejects(
      port.getAccountState('ghost'),
      (error: unknown) => error instanceof HttpError && error.status === 401,
    );
  });

  it('예치 시도가 있는 계약만 후보 제외 대상으로 표시한다', async () => {
    // 준비
    const db: IntegrationDb = {
      project: { findUnique: unused },
      specItem: { findMany: unused },
      application: { findUnique: unused },
      user: { findUnique: unused },
      escrowDeposit: {
        async count(input) {
          const where = input.where as { contractId?: string };
          return where.contractId === 'contract-1' ? 1 : 0;
        },
      },
      eventLog: { findFirst: unused, create: unused },
    };
    const port = createDepositAttemptPort(db);

    // 실행 및 확인
    assert.equal(await port.hasDepositAttempt('contract-1'), true);
    assert.equal(await port.hasDepositAttempt('contract-2'), false);
  });

  it('최초 문의 이벤트는 프로젝트당 한 번만 만든다', async () => {
    // 준비
    const created: Record<string, unknown>[] = [];
    let existing = false;
    let transactionTail = Promise.resolve();
    const db: IntegrationDb = {
      project: { findUnique: unused },
      specItem: { findMany: unused },
      application: { findUnique: unused },
      user: { findUnique: unused },
      escrowDeposit: { count: unused },
      eventLog: {
        async findFirst() {
          return existing ? { id: 'evt-1' } : null;
        },
        async create(input) {
          created.push(input.data as Record<string, unknown>);
          existing = true;
          return input.data;
        },
      },
      $transaction: async (work) => {
        const previous = transactionTail;
        let unlock!: () => void;
        transactionTail = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        try {
          return await work({
            eventLog: db.eventLog,
            $queryRaw: async <T>() => [] as unknown as T,
          });
        } finally {
          unlock();
        }
      },
    };
    const port = createChatEventPort(db);

    // 실행 및 확인
    assert.equal(
      await port.recordInquiryOpenedOnce({
        projectId: 'prj-1',
        clientUserId: 'client-1',
        openedAt: FIXED_NOW,
      }),
      true,
    );
    assert.equal(created[0]?.type, 'INQUIRY_OPENED');
    // 확인
    assert.equal(
      await port.recordInquiryOpenedOnce({
        projectId: 'prj-1',
        clientUserId: 'client-1',
        openedAt: FIXED_NOW,
      }),
      false,
    );
  });

  it('동시에 열린 같은 프로젝트의 문의 중 최초 이벤트 하나만 기록한다', async () => {
    // 준비
    const created: Record<string, unknown>[] = [];
    let existing = false;
    let transactionTail = Promise.resolve();
    const db: IntegrationDb = {
      project: { findUnique: unused },
      specItem: { findMany: unused },
      application: { findUnique: unused },
      user: { findUnique: unused },
      escrowDeposit: { count: unused },
      eventLog: {
        async findFirst() {
          return existing ? { id: 'evt-1' } : null;
        },
        async create(input) {
          created.push(input.data as Record<string, unknown>);
          existing = true;
          return input.data;
        },
      },
      $transaction: async (work) => {
        const previous = transactionTail;
        let unlock!: () => void;
        transactionTail = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        try {
          return await work({ eventLog: db.eventLog, $queryRaw: async <T>() => [] as unknown as T });
        } finally {
          unlock();
        }
      },
    };
    const port = createChatEventPort(db);
    const input = { projectId: 'prj-1', clientUserId: 'client-1', openedAt: FIXED_NOW };

    // 실행
    const opened = await Promise.all([
      port.recordInquiryOpenedOnce(input),
      port.recordInquiryOpenedOnce(input),
    ]);

    // 확인
    assert.deepEqual(opened.sort(), [false, true]);
    assert.equal(created.length, 1);
  });

  it('계약이 없는 Port는 호출 시 503 INTEGRATION_PENDING으로 실패한다', async () => {
    // 준비
    const db: IntegrationDb = {
      project: { findUnique: unused },
      specItem: { findMany: unused },
      application: { findUnique: unused },
      user: { findUnique: unused },
      escrowDeposit: { count: async () => 0 },
      eventLog: { findFirst: async () => null, create: unused },
    };
    const ports = createIntegrationPorts(db, { now: () => FIXED_NOW });

    // 실행 및 확인
    await assert.rejects(
      ports.recommendations.getSupplier('supplier-1'),
      (error: unknown) => error instanceof HttpError && error.status === 503,
    );
    await assert.rejects(
      ports.agreementPreview.getSpec('app-1'),
      (error: unknown) => error instanceof HttpError && error.status === 503,
    );
    await assert.rejects(
      ports.reportAccounts.applyAccountAction({
        userId: 'user-1',
        action: 'SUSPEND',
        at: FIXED_NOW,
        until: null,
      }),
      (error: unknown) => error instanceof HttpError && error.status === 503,
    );
  });
});
