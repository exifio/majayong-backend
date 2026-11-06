import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPrismaMyReportQueryPort,
  createReportTx,
  type ReportDbClient,
  type ReportRow,
} from './prisma-adapter.ts';
import {
  createInquiryTx,
  createPrismaInquiryUnitOfWork,
  type InquiryDbClient,
  type InquiryRow,
} from '../support/prisma-adapter.ts';
import { FIXED_NOW } from '../../../tests/b/fixtures.ts';
import type { NotificationDbRow } from '../notification/prisma-adapter.ts';

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

function reportRow(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    id: 'report-1',
    messageId: 'msg-1',
    reporterId: 'supplier-1',
    targetUserId: 'client-1',
    reason: 'ABUSE',
    detail: null,
    status: 'OPEN',
    action: null,
    actionNote: null,
    resolvedById: null,
    resolvedAt: null,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

function reportDb(rows: ReportRow[]) {
  const notifications: Record<string, unknown>[] = [];
  const db: ReportDbClient = {
    applicationMessage: {
      async findUnique(input) {
        return input.where.id === 'msg-1'
          ? { id: 'msg-1', senderId: 'client-1', application: { supplierId: 'supplier-1', project: { draft: { clientId: 'client-1' } } } }
          : null;
      },
    },
    report: {
      async findFirst(input) {
        const where = input.where as { messageId?: string; reporterId?: string };
        return (
          rows.find(
            (row) =>
              row.status === 'OPEN' &&
              row.messageId === where.messageId &&
              row.reporterId === where.reporterId,
          ) ?? null
        );
      },
      async findMany(input) {
        const where = input.where as { reporterId?: string; status?: ReportRow['status'] };
        return rows.filter(
          (row) =>
            (where.reporterId === undefined || row.reporterId === where.reporterId) &&
            (where.status === undefined || row.status === where.status),
        );
      },
      async findUnique(input) {
        return rows.find((row) => row.id === input.where.id) ?? null;
      },
      async create(input) {
        const created = reportRow(input.data as Partial<ReportRow>);
        rows.push(created);
        return created;
      },
      async update(input) {
        const index = rows.findIndex((row) => row.id === input.where.id);
        const current = rows[index];
        if (index < 0 || current === undefined) throw new Error('missing report');
        rows[index] = { ...current, ...(input.data as Partial<ReportRow>) };
        return rows[index] as ReportRow;
      },
      async count(input) {
        const where = input.where as { targetUserId?: string; action?: string };
        return rows.filter(
          (row) =>
            (where.targetUserId === undefined || row.targetUserId === where.targetUserId) &&
            (where.action === undefined || row.action === where.action),
        ).length;
      },
    },
    eventLog: { create: unused },
    notification: {
      findUnique: async () => null,
      async create(input) {
        notifications.push({ ...input.data });
        return { id: 'n1', ...input.data, isRead: false } satisfies NotificationDbRow;
      },
      update: unused,
      findMany: async () => [],
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
    },
  };
  return { db, notifications };
}

describe('B-07 Prisma 신고 어댑터', () => {
  it('메시지 참여자와 Project.clientId를 신고 대상 판정에 넘긴다', async () => {
    // 준비
    const { db } = reportDb([]);
    const tx = createReportTx(db, { applyAccountAction: unused }, () => FIXED_NOW);

    // 실행
    const message = await tx.findReportableMessage('msg-1');

    // 확인
    assert.equal(message?.senderId, 'client-1');
    assert.deepEqual(message?.participantIds, ['client-1', 'supplier-1']);
  });

  it('관리자 신고 목록은 신고자·대상 표시명과 메시지 문맥을 함께 돌려준다', async () => {
    // 준비
    const { db } = reportDb([
      reportRow({
        reporter: {
          id: 'supplier-1',
          role: 'SUPPLIER',
          name: null,
          clientProfile: null,
          supplierProfile: { displayName: '강태오' },
        },
        targetUser: {
          id: 'client-1',
          role: 'CLIENT',
          name: '문지아',
          clientProfile: { businessName: null },
          supplierProfile: null,
        },
        message: {
          body: '카톡으로 연락 주세요',
          createdAt: FIXED_NOW,
          application: { project: { id: 'project-1', title: '예약 사이트' } },
        },
      }),
    ]);
    const tx = createReportTx(db, { applyAccountAction: unused }, () => FIXED_NOW);

    // 실행
    const rows = await tx.listReports({});

    // 확인
    assert.deepEqual(rows[0]?.reporter, { id: 'supplier-1', role: 'SUPPLIER', displayName: '강태오' });
    assert.equal(rows[0]?.target.displayName, '문지아');
    assert.equal(rows[0]?.message.body, '카톡으로 연락 주세요');
    assert.equal(rows[0]?.message.projectTitle, '예약 사이트');
  });

  it('경고 횟수는 WARNING 조치만 센다', async () => {    // 준비
    const { db } = reportDb([
      reportRow({ id: 'r1', status: 'RESOLVED', action: 'WARNING' }),
      reportRow({ id: 'r2', status: 'RESOLVED', action: 'SUSPEND' }),
    ]);
    const tx = createReportTx(db, { applyAccountAction: unused }, () => FIXED_NOW);

    // 실행 및 확인
    assert.equal(await tx.findWarningCount('client-1'), 1);
  });

  it('판정 완료는 상태·조치·처리자를 남기고 신고자에게 알린다', async () => {
    // 준비
    const rows = [reportRow()];
    const { db, notifications } = reportDb(rows);
    const tx = createReportTx(db, { applyAccountAction: unused }, () => FIXED_NOW);

    // 실행
    const resolved = await tx.resolveReport({
      reportId: 'report-1',
      resolvedById: 'admin-1',
      action: 'WARNING',
      actionNote: '주의 안내',
      resolvedAt: FIXED_NOW,
    });
    // 확인
    assert.equal(resolved?.status, 'RESOLVED');
    assert.equal(resolved?.action, 'WARNING');
    assert.equal(resolved?.resolvedById, 'admin-1');

    // 실행 및 확인
    await tx.notifyReporter({ userId: 'supplier-1', reportId: 'report-1' });
    assert.equal(notifications[0]?.type, 'REPORT_REVIEWED');
    assert.equal(notifications[0]?.targetUrl, '/reports/report-1');
  });

  it('본인 신고 목록은 신고자 기준으로만 읽는다', async () => {
    // 준비
    const { db } = reportDb([reportRow(), reportRow({ id: 'r2', reporterId: 'supplier-2' })]);
    const port = createPrismaMyReportQueryPort(db);

    // 실행
    const mine = await port.listByReporter({ reporterId: 'supplier-1' });

    // 확인
    assert.deepEqual(mine.map((row) => row.id), ['report-1']);
  });
});

function inquiryRow(overrides: Partial<InquiryRow> = {}): InquiryRow {
  return {
    id: 'inq-1',
    userId: 'supplier-1',
    category: 'PAYMENT',
    contractId: null,
    title: '문의',
    body: '본문',
    attachments: null,
    status: 'WAITING',
    answer: null,
    answeredById: null,
    answeredAt: null,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

function inquiryDb(rows: InquiryRow[]) {
  const notifications: Record<string, unknown>[] = [];
  const db: InquiryDbClient = {
    supportInquiry: {
      async findUnique(input) {
        return rows.find((row) => row.id === input.where.id) ?? null;
      },
      async findMany(input) {
        const where = input.where as { userId?: string; status?: string };
        return rows.filter(
          (row) =>
            (where.userId === undefined || row.userId === where.userId) &&
            (where.status === undefined || row.status === where.status),
        );
      },
      async create(input) {
        const created = inquiryRow(input.data as Partial<InquiryRow>);
        rows.push(created);
        return created;
      },
      async update(input) {
        const index = rows.findIndex((row) => row.id === input.where.id);
        const current = rows[index];
        if (index < 0 || current === undefined) throw new Error('missing inquiry');
        rows[index] = { ...current, ...(input.data as Partial<InquiryRow>) };
        return rows[index] as InquiryRow;
      },
    },
    contract: {
      async findFirst(input) {
        const where = input.where as {
          id: string;
          application?: {
            OR?: readonly {
              supplierId?: string;
              project?: { draft?: { clientId?: string } };
            }[];
          };
        };
        if (where.id !== 'contract-1') return null;
        const party = where.application?.OR?.some(
          (condition) =>
            condition.supplierId === 'supplier-1' ||
            condition.project?.draft?.clientId === 'client-1',
        );
        return party === true ? { id: 'contract-1' } : null;
      },
    },
    eventLog: { create: unused },
    notification: {
      async findUnique(input) {
        const key = input.where.userId_type_targetId;
        return notifications.find(
          (row) => row.userId === key.userId && row.type === key.type && row.targetId === key.targetId,
        ) ?? null;
      },
      async create(input) {
        const data = input.data as Record<string, unknown>;
        if (
          notifications.some(
            (row) => row.userId === data.userId && row.type === data.type && row.targetId === data.targetId,
          )
        ) {
          throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        }
        const created = { ...data, id: 'n1', isRead: false };
        notifications.push(created);
        return created;
      },
    },
  };
  return { db, notifications };
}

describe('B-07 Prisma 문의 어댑터', () => {
  it('계약 당사자만 관련 계약을 선택할 수 있다', async () => {
    // 준비
    const { db } = inquiryDb([]);
    const tx = createInquiryTx(db, () => FIXED_NOW);

    // 실행 및 확인
    assert.equal(
      await tx.canAccessContract({ contractId: 'contract-1', userId: 'supplier-1' }),
      true,
    );
    assert.equal(
      await tx.canAccessContract({ contractId: 'contract-1', userId: 'client-1' }),
      true,
    );
    assert.equal(
      await tx.canAccessContract({ contractId: 'contract-1', userId: 'stranger' }),
      false,
    );
  });

  it('첨부를 JSON으로 저장하고 그대로 읽는다', async () => {
    // 준비
    const { db } = inquiryDb([]);
    const tx = createInquiryTx(db, () => FIXED_NOW);

    // 실행
    const created = await tx.createInquiry({
      userId: 'supplier-1',
      category: 'PAYMENT',
      contractId: null,
      title: '문의',
      body: '본문',
      attachments: [{ url: '/files/a.pdf', name: 'a.pdf', size: 1024 }],
      createdAt: FIXED_NOW,
    });

    // 확인
    assert.deepEqual(created.attachments, [{ url: '/files/a.pdf', name: 'a.pdf', size: 1024 }]);
  });

  it('답변은 ANSWERED로 바꾸고 작성자에게 알린다', async () => {
    // 준비
    const { db, notifications } = inquiryDb([inquiryRow()]);
    const tx = createInquiryTx(db, () => FIXED_NOW);

    // 실행
    const answered = await tx.answerInquiry({
      inquiryId: 'inq-1',
      answeredById: 'admin-1',
      answer: '처리했습니다.',
      answeredAt: FIXED_NOW,
    });
    // 확인
    assert.equal(answered?.status, 'ANSWERED');
    assert.equal(answered?.answer, '처리했습니다.');

    // 실행 및 확인
    await tx.notifyAuthor({ userId: 'supplier-1', inquiryId: 'inq-1' });
    assert.equal(notifications[0]?.type, 'INQUIRY_ANSWERED');
    assert.equal(notifications[0]?.targetUrl, '/help/inquiry?tab=my&id=inq-1');
  });

  it('깨진 첨부 JSON은 거부한다', async () => {
    // 준비
    const { db } = inquiryDb([inquiryRow({ attachments: 'broken' })]);
    const tx = createInquiryTx(db, () => FIXED_NOW);

    // 실행 및 확인
    await assert.rejects(tx.findInquiry('inq-1'), /INVALID_INQUIRY_ATTACHMENTS/);
  });

  it('UnitOfWork는 $transaction 안에서 tx를 넘긴다', async () => {
    // 준비
    const { db } = inquiryDb([inquiryRow()]);
    const uow = createPrismaInquiryUnitOfWork(
      { ...db, $transaction: async (work) => work(db) },
      () => FIXED_NOW,
    );

    // 실행
    const found = await uow.run((tx) => tx.findInquiry('inq-1'));
    // 확인
    assert.equal(found?.id, 'inq-1');
  });
});
