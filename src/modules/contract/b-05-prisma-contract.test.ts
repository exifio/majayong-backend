import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createContractTx,
  createPrismaContractReadPort,
  type ContractDbClient,
  type ContractRow,
} from './prisma-adapter.ts';
import { FIXED_NOW } from '../../../tests/b/fixtures.ts';
import type { NotificationDbRow } from '../notification/prisma-adapter.ts';

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

function contractRow(overrides: Partial<ContractRow> = {}): ContractRow {
  return {
    id: 'contract-1',
    applicationId: 'app-1',
    status: 'PENDING_CONSENT',
    specVersionNo: 1,
    agreedAmount: 3_100_000,
    durationDays: 42,
    clientFee: 155_000,
    supplierFee: 155_000,
    interimRatio: 50,
    consentDeadline: new Date('2026-11-10T14:59:59.000Z'),
    contentHash: 'hash-1',
    clientSignedAt: null,
    supplierSignedAt: null,
    depositDeadline: null,
    paymentStatus: 'PENDING',
    totalDeposited: 0,
    items: [
      {
        blockId: 'block-1',
        title: '예약',
        description: '예약 기능',
        origin: 'CHAT',
        stage: 'FINAL',
        conditions: [
          { key: 'scope', text: '시간', state: 'DECIDED', evidenceMessageIds: ['m1', 'm2'] },
        ],
        sortOrder: 0,
      },
    ],
    application: {
      projectId: 'prj-1',
      supplierId: 'supplier-1',
      project: { draft: { clientId: 'client-1' } },
    },
    ...overrides,
  };
}

function makeDb(rows: ContractRow[]) {
  const messages: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];

  const statusMatches = (row: ContractRow, where: Record<string, unknown>): boolean => {
    if (typeof where.status === 'string' && row.status !== where.status) return false;
    const statusIn = where.status as { in?: readonly string[] } | undefined;
    if (statusIn?.in !== undefined && !statusIn.in.includes(row.status)) return false;
    return true;
  };
  const matches = (row: ContractRow, where: Record<string, unknown>): boolean => {
    if (!statusMatches(row, where)) return false;
    if (where.clientSignedAt === null && row.clientSignedAt !== null) return false;
    if (where.supplierSignedAt === null && row.supplierSignedAt !== null) return false;
    return true;
  };

  const db: ContractDbClient = {
    contract: {
      async findUnique(input) {
        return rows.find((row) => row.id === input.where.id) ?? null;
      },
      async findMany(input) {
        const where = input.where as Record<string, unknown>;
        const or = where.OR as readonly Record<string, unknown>[] | undefined;
        const application = where.application as
          | { project?: { draft?: { clientId?: string } }; supplierId?: string }
          | undefined;
        return rows.filter((row) => {
          if (or !== undefined) {
            return or.some((condition) => {
              if (!statusMatches(row, condition)) return false;
              const due = condition.consentDeadline as { lte?: Date } | undefined;
              const deposit = condition.depositDeadline as { lte?: Date } | undefined;
              if (due?.lte !== undefined) return row.consentDeadline.getTime() <= due.lte.getTime();
              if (deposit?.lte !== undefined) {
                return row.depositDeadline !== null && row.depositDeadline.getTime() <= deposit.lte.getTime();
              }
              return true;
            });
          }
          if (application?.project?.draft?.clientId !== undefined) {
            return row.application.project.draft.clientId === application.project.draft.clientId;
          }
          if (application?.supplierId !== undefined) {
            return row.application.supplierId === application.supplierId;
          }
          return statusMatches(row, where);
        });
      },
      async create(input) {
        const data = input.data as {
          applicationId: string;
          items: { create: readonly Record<string, unknown>[] };
        };
        const created = contractRow({
          id: `contract-${rows.length + 1}`,
          applicationId: data.applicationId,
          items: data.items.create.map((item) => ({
            blockId: String(item.blockId),
            title: String(item.title),
            description: String(item.description),
            origin: item.origin as ContractRow['items'][number]['origin'],
            stage: item.stage as ContractRow['items'][number]['stage'],
            conditions: item.conditions,
            sortOrder: Number(item.sortOrder),
          })),
        });
        rows.push(created);
        return created;
      },
      async update(input) {
        const index = rows.findIndex((row) => row.id === input.where.id);
        const current = rows[index];
        if (index < 0 || current === undefined) throw new Error('missing contract');
        rows[index] = { ...current, ...(input.data as Partial<ContractRow>) };
        return rows[index] as ContractRow;
      },
      async updateMany(input) {
        const where = input.where as Record<string, unknown>;
        const index = rows.findIndex((row) => row.id === where.id && matches(row, where));
        const current = rows[index];
        if (index < 0 || current === undefined) return { count: 0 };
        rows[index] = { ...current, ...(input.data as Partial<ContractRow>) };
        return { count: 1 };
      },
    },
    application: {
      findFirst: unused,
      async findMany() {
        return [];
      },
      async findUnique() {
        return null;
      },
      async update() {
        return {};
      },
      async updateMany() {
        return { count: 1 };
      },
    },
    project: {
      async findUnique(input) {
        return input.where.id === 'prj-1'
          ? { id: 'prj-1', status: 'RECRUITING' as const, deadline: null }
          : null;
      },
      async updateMany() {
        return { count: 1 };
      },
    },
    applicationMessage: {
      async create(input) {
        messages.push(input.data as Record<string, unknown>);
        return input.data;
      },
    },
    eventLog: {
      async create(input) {
        events.push(input.data as Record<string, unknown>);
        return input.data;
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

  return { db, messages, events, notifications };
}

describe('B-05 Prisma 계약 어댑터', () => {
  it('Contract의 projectId·clientUserId를 Application에서 가져오고 조건을 파싱한다', async () => {
    // 준비
    const { db } = makeDb([contractRow()]);
    const port = createPrismaContractReadPort(db);

    // 실행
    const found = await port.findById('contract-1');

    // 확인
    assert.equal(found?.projectId, 'prj-1');
    assert.equal(found?.clientUserId, 'client-1');
    assert.equal(found?.supplierId, 'supplier-1');
    assert.deepEqual(found?.items[0]?.conditions, [
      { key: 'scope', text: '시간', state: 'DECIDED', evidenceMessageIds: ['m1', 'm2'] },
    ]);
  });

  it('계약 생성은 항목 사본과 PENDING_CONSENT 상태를 저장한다', async () => {
    // 준비
    const { db } = makeDb([]);
    const tx = createContractTx(db, { hasDepositAttempt: async () => false });

    // 실행
    const created = await tx.createContract({
      applicationId: 'app-1',
      projectId: 'prj-1',
      clientUserId: 'client-1',
      supplierId: 'supplier-1',
      specVersionNo: 1,
      agreedAmount: 3_100_000,
      durationDays: 42,
      clientFee: 155_000,
      supplierFee: 155_000,
      interimRatio: 50,
      consentDeadline: FIXED_NOW,
      contentHash: 'hash-1',
      items: [
        {
          blockId: 'block-1',
          title: '예약',
          description: '예약 기능',
          origin: 'CHAT',
          stage: 'FINAL',
          sortOrder: 0,
          conditions: [
            { key: 'scope', text: '시간', state: 'PROPOSED', evidenceMessageIds: [] },
          ],
        },
      ],
    });

    // 확인
    assert.equal(created.status, 'PENDING_CONSENT');
    assert.equal(created.items[0]?.conditions[0]?.state, 'PROPOSED');
  });

  it('두 번째 서명은 ACTIVE와 예치 기한을 함께 저장한다', async () => {
    // 준비
    const { db } = makeDb([contractRow()]);
    const tx = createContractTx(db, { hasDepositAttempt: async () => false });
    const depositDeadline = new Date('2026-11-07T14:59:59.000Z');

    // 실행
    const signed = await tx.applySignature({
      contractId: 'contract-1',
      party: 'SUPPLIER',
      signedAt: FIXED_NOW,
      activate: true,
      depositDeadline,
    });

    // 확인
    assert.equal(signed?.status, 'ACTIVE');
    assert.equal(signed?.supplierSignedAt?.toISOString(), FIXED_NOW.toISOString());
    assert.equal(signed?.depositDeadline?.toISOString(), depositDeadline.toISOString());
  });

  it('서명은 이미 서명된 당사자의 중복 조건부 갱신을 거부한다', async () => {
    // 준비
    const { db } = makeDb([contractRow({ clientSignedAt: FIXED_NOW })]);
    const tx = createContractTx(db, { hasDepositAttempt: async () => false });

    // 실행
    const result = await tx.applySignature({
      contractId: 'contract-1', party: 'CLIENT', signedAt: FIXED_NOW,
      activate: false, depositDeadline: null,
    });

    // 확인
    assert.equal(result, null);
  });

  it('상태 조건부 갱신은 현재 상태가 허용될 때만 성공한다', async () => {
    // 준비
    const { db } = makeDb([contractRow()]);
    const tx = createContractTx(db, { hasDepositAttempt: async () => false });

    // 실행 및 확인
    assert.equal(
      await tx.updateApplicationStatus({ applicationId: 'app-1', from: ['STALE'], to: 'ACCEPTED' }),
      true,
    );
    assert.equal(await tx.cancelContract({ contractId: 'contract-1', reason: 'SIGN_REFUSED' }), true);
    assert.equal(await tx.cancelContract({ contractId: 'contract-1', reason: 'SIGN_REFUSED' }), false);
  });

  it('결렬 후보에서 입금 시도가 있는 계약을 제외한다', async () => {
    // 준비
    const expired = contractRow({
      id: 'contract-1',
      status: 'PENDING_CONSENT',
      consentDeadline: new Date('2026-11-01T00:00:00.000Z'),
    });
    const active = contractRow({
      id: 'contract-2',
      status: 'ACTIVE',
      depositDeadline: new Date('2026-11-02T00:00:00.000Z'),
    });
    const { db } = makeDb([expired, active]);

    // 실행
    const withoutAttempts = await createContractTx(db, {
      hasDepositAttempt: async () => false,
    }).listBreakCandidates(FIXED_NOW);
    // 확인
    assert.deepEqual(withoutAttempts.map((row) => row.id), ['contract-1', 'contract-2']);

    // 실행
    const withAttempt = await createContractTx(db, {
      hasDepositAttempt: async (contractId) => contractId === 'contract-2',
    }).listBreakCandidates(FIXED_NOW);
    // 확인
    assert.deepEqual(withAttempt.map((row) => row.id), ['contract-1']);
  });

  it('결렬 알림·이벤트·SYSTEM 메시지를 같은 tx에 남긴다', async () => {
    // 준비
    const { db, messages, events, notifications } = makeDb([contractRow()]);
    const tx = createContractTx(db, { hasDepositAttempt: async () => false });

    // 실행
    await tx.appendSystemMessage({ applicationId: 'app-1', body: '결렬되었습니다.' });
    await tx.notify({
      userId: 'client-1',
      type: 'CONTRACT_BROKEN',
      targetId: 'contract-1',
      payload: { reason: 'SIGN_REFUSED' },
      now: FIXED_NOW,
    });
    await tx.logEvent({
      userId: 'client-1',
      type: 'CONTRACT_BROKEN',
      payload: { contractId: 'contract-1', reason: 'SIGN_REFUSED' },
    });

    // 확인
    assert.equal(messages[0]?.kind, 'SYSTEM');
    assert.equal(notifications[0]?.type, 'CONTRACT_BROKEN');
    assert.equal(events[0]?.contractId, 'contract-1');
  });

  it('깨진 조건 JSON은 거부한다', async () => {
    // 준비
    const { db } = makeDb([
      contractRow({
        items: [
          {
            blockId: 'block-1',
            title: '예약',
            description: '예약 기능',
            origin: 'CHAT',
            stage: 'FINAL',
            conditions: 'broken',
            sortOrder: 0,
          },
        ],
      }),
    ]);
    const port = createPrismaContractReadPort(db);

    // 실행 및 확인
    await assert.rejects(port.findById('contract-1'), /INVALID_CONTRACT_CONDITIONS/);
  });
});
