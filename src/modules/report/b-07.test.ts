import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OpenReportUniqueViolation,
  REPORT_ACTIONS,
  REPORT_REASONS,
  ReportError,
  listReports,
  resolveReport,
  submitReport,
  type ReportAction,
  type ReportRecord,
  type ReportTx,
  type ReportUnitOfWork,
} from './reports.ts';
import {
  INQUIRY_CATEGORIES,
  InquiryError,
  answerInquiry,
  createInquiry,
  getInquiry,
  listInquiriesForAdmin,
  listMyInquiries,
  type InquiryAttachment,
  type InquiryRecord,
  type InquiryTx,
  type InquiryUnitOfWork,
} from '../support/inquiries.ts';
import { FIXED_NOW } from '../../../tests/b/fixtures.ts';

const CLIENT = { userId: 'client-1', role: 'CLIENT' as const };
const SUPPLIER = { userId: 'supplier-1', role: 'SUPPLIER' as const };
const ADMIN = { userId: 'admin-1', role: 'ADMIN' as const };
const INTRUDER = { userId: 'other-1', role: 'CLIENT' as const };

function isReportError(status: number, code: string) {
  return (error: unknown): boolean =>
    error instanceof ReportError && error.status === status && error.code === code;
}

function isInquiryError(status: number, code: string) {
  return (error: unknown): boolean =>
    error instanceof InquiryError && error.status === status && error.code === code;
}

interface ReportableMessage {
  readonly id: string;
  readonly senderId: string | null;
  readonly participantIds: readonly string[];
}

class FakeReportTx implements ReportTx {
  readonly messages: readonly ReportableMessage[];
  reports: ReportRecord[] = [];
  readonly notifications: { userId: string; reportId: string }[] = [];
  readonly events: { userId: string; type: string; payload: Readonly<Record<string, unknown>> }[] = [];
  readonly accountActions: {
    userId: string;
    action: 'CHAT_RESTRICT_7D' | 'SUSPEND';
    at: Date;
    until: Date | null;
  }[] = [];
  private nextId = 1;
  private forceUnique = false;

  constructor(messages: readonly ReportableMessage[] = []) { this.messages = messages; }
  makeNextCreateUniqueViolation(): void { this.forceUnique = true; }

  async findReportableMessage(messageId: string): Promise<ReportableMessage | null> {
    return this.messages.find((message) => message.id === messageId) ?? null;
  }
  async findOpenReport(input: { messageId: string; reporterId: string }): Promise<ReportRecord | null> {
    return this.reports.find((report) => report.messageId === input.messageId && report.reporterId === input.reporterId && report.status === 'OPEN') ?? null;
  }
  async createReport(input: {
    messageId: string; reporterId: string; targetUserId: string;
    reason: ReportRecord['reason']; detail: string | null; createdAt: Date;
  }): Promise<ReportRecord> {
    if (this.forceUnique) { this.forceUnique = false; throw new OpenReportUniqueViolation(); }
    if (await this.findOpenReport(input)) throw new OpenReportUniqueViolation();
    const created: ReportRecord = {
      ...input, id: `report-${this.nextId}`, status: 'OPEN', action: null,
      actionNote: null, resolvedById: null, resolvedAt: null,
    };
    this.nextId += 1;
    this.reports.push(created);
    return created;
  }
  async listReports(input: { status?: ReportRecord['status'] }): Promise<readonly ReportRecord[]> {
    return this.reports.filter((report) => input.status === undefined || report.status === input.status);
  }
  async findReport(reportId: string): Promise<ReportRecord | null> {
    return this.reports.find((report) => report.id === reportId) ?? null;
  }
  async countWarnings(targetUserId: string): Promise<number> {
    return this.reports.filter((report) => report.targetUserId === targetUserId && report.action === 'WARNING').length;
  }
  async resolveReport(input: {
    reportId: string; resolvedById: string; action: ReportAction; actionNote: string; resolvedAt: Date;
  }): Promise<ReportRecord | null> {
    const index = this.reports.findIndex((report) => report.id === input.reportId && report.status === 'OPEN');
    const report = this.reports[index];
    if (index < 0 || report === undefined) return null;
    const resolved = { ...report, status: 'RESOLVED' as const, action: input.action,
      actionNote: input.actionNote, resolvedById: input.resolvedById, resolvedAt: input.resolvedAt };
    this.reports[index] = resolved;
    return resolved;
  }
  async applyAccountAction(input: {
    userId: string; action: 'CHAT_RESTRICT_7D' | 'SUSPEND'; at: Date; until: Date | null;
  }): Promise<void> { this.accountActions.push(input); }
  async findWarningCount(targetUserId: string): Promise<number> { return this.countWarnings(targetUserId); }
  async notifyReporter(input: { userId: string; reportId: string }): Promise<void> { this.notifications.push(input); }
  async logEvent(input: {
    userId: string; type: 'REPORT_SUBMITTED' | 'REPORT_RESOLVED'; payload: Readonly<Record<string, unknown>>;
  }): Promise<void> { this.events.push(input); }
}

class FakeReportUnitOfWork implements ReportUnitOfWork {
  readonly tx: FakeReportTx;
  constructor(tx: FakeReportTx) { this.tx = tx; }
  async run<T>(work: (tx: ReportTx) => Promise<T>): Promise<T> { return work(this.tx); }
}

const REPORT_MESSAGES: readonly ReportableMessage[] = [
  { id: 'message-1', senderId: 'supplier-1', participantIds: ['client-1', 'supplier-1'] },
  { id: 'message-2', senderId: 'client-1', participantIds: ['client-1', 'supplier-1'] },
  { id: 'message-system', senderId: null, participantIds: ['client-1', 'supplier-1'] },
];

describe('B-07-T01/T02/T03 메시지 신고·중복·알림 보안', () => {
  it('본인이 보낸 메시지와 시스템 메시지는 신고할 수 없다', async () => {
    // 준비
    const uow = new FakeReportUnitOfWork(new FakeReportTx(REPORT_MESSAGES));
    // 실행 및 확인
    for (const messageId of ['message-2', 'message-system']) {
      await assert.rejects(submitReport(uow, { actor: CLIENT, messageId, reason: 'ABUSE', now: FIXED_NOW }),
        isReportError(400, 'REPORT_SELF_OR_SYSTEM_MESSAGE'));
    }
    assert.equal(uow.tx.reports.length, 0);
  });

  it('대화 참여자만 다른 사람의 메시지를 신고할 수 있다', async () => {
    // 실행 및 확인
    await assert.rejects(submitReport(new FakeReportUnitOfWork(new FakeReportTx(REPORT_MESSAGES)), {
      actor: INTRUDER, messageId: 'message-1', reason: 'ABUSE', now: FIXED_NOW,
    }), isReportError(404, 'REPORT_TARGET_NOT_FOUND'));
  });

  it('4종 사유로 접수하고 신고 대상 알림은 만들지 않는다', async () => {
    // 확인
    assert.deepEqual(REPORT_REASONS, ['CONTACT_OR_OFFSITE', 'ABUSE', 'FALSE_INFO', 'OTHER']);
    // 준비
    const uow = new FakeReportUnitOfWork(new FakeReportTx(REPORT_MESSAGES));
    // 실행
    const report = await submitReport(uow, {
      actor: CLIENT, messageId: 'message-1', reason: 'CONTACT_OR_OFFSITE',
      detail: '외부 연락처를 요구했습니다.', now: FIXED_NOW,
    });
    // 확인
    assert.equal(report.status, 'OPEN');
    assert.equal(report.targetUserId, 'supplier-1');
    assert.equal(uow.tx.events[0]?.type, 'REPORT_SUBMITTED');
    assert.equal(uow.tx.notifications.length, 0);
  });

  it('같은 기자의 열린 메시지 신고 중복과 DB unique 경합은 409다', async () => {
    // 준비
    const tx = new FakeReportTx(REPORT_MESSAGES);
    const uow = new FakeReportUnitOfWork(tx);
    const input = { actor: CLIENT, messageId: 'message-1', reason: 'ABUSE' as const, now: FIXED_NOW };
    // 실행 및 확인
    await submitReport(uow, input);
    await assert.rejects(submitReport(uow, input), isReportError(409, 'REPORT_ALREADY_OPEN'));

    // 준비
    const racingTx = new FakeReportTx(REPORT_MESSAGES);
    racingTx.makeNextCreateUniqueViolation();
    // 실행 및 확인
    await assert.rejects(submitReport(new FakeReportUnitOfWork(racingTx), input),
      isReportError(409, 'REPORT_ALREADY_OPEN'));
  });

  it('잘못된 사유와 빈 설명은 거부한다', async () => {
    // 준비
    const uow = new FakeReportUnitOfWork(new FakeReportTx(REPORT_MESSAGES));
    // 실행 및 확인
    await assert.rejects(submitReport(uow, {
      actor: CLIENT, messageId: 'message-1', reason: 'SPAM' as unknown as typeof REPORT_REASONS[number], now: FIXED_NOW,
    }), isReportError(400, 'INVALID_REPORT_REASON'));
    await assert.rejects(submitReport(uow, {
      actor: CLIENT, messageId: 'message-1', reason: 'OTHER', detail: ' ', now: FIXED_NOW,
    }), isReportError(400, 'INVALID_REPORT_DETAIL'));
  });
});

describe('B-07-T04 운영자 신고 판정·계정 조치', () => {
  it('운영자 외에는 목록/판정할 수 없고 조치에는 사유가 필요하다', async () => {
    // 준비
    const uow = new FakeReportUnitOfWork(new FakeReportTx(REPORT_MESSAGES));
    // 실행 및 확인
    await assert.rejects(listReports(uow, { actor: CLIENT }), isReportError(403, 'ADMIN_ONLY'));
    await assert.rejects(resolveReport(uow, {
      actor: CLIENT, reportId: 'report-1', action: 'NONE', actionNote: '문제 없음', now: FIXED_NOW,
    }), isReportError(403, 'ADMIN_ONLY'));
  });

  it('판정 완료는 신고자에게만 알리고 EventLog를 남긴다', async () => {
    // 확인
    assert.deepEqual(REPORT_ACTIONS, ['NONE', 'WARNING', 'CHAT_RESTRICT_7D', 'SUSPEND']);
    // 준비
    const tx = new FakeReportTx(REPORT_MESSAGES);
    const uow = new FakeReportUnitOfWork(tx);
    // 실행
    const report = await submitReport(uow, {
      actor: CLIENT, messageId: 'message-1', reason: 'ABUSE', now: FIXED_NOW,
    });
    // 실행 및 확인
    await assert.rejects(resolveReport(uow, {
      actor: ADMIN, reportId: report.id, action: 'WARNING', actionNote: ' ', now: FIXED_NOW,
    }), isReportError(400, 'ACTION_NOTE_REQUIRED'));

    // 실행
    const result = await resolveReport(uow, {
      actor: ADMIN, reportId: report.id, action: 'WARNING',
      actionNote: '비속어 사용이 확인되어 경고합니다.', now: FIXED_NOW,
    });
    // 확인
    assert.equal(result.report.status, 'RESOLVED');
    assert.deepEqual(tx.notifications, [{ userId: 'client-1', reportId: report.id }]);
    assert.equal(tx.events.at(-1)?.type, 'REPORT_RESOLVED');
    assert.equal(tx.accountActions.length, 0);
  });

  it('CHAT_RESTRICT_7D를 계정 Port에 넘긴다', async () => {
    // 준비
    const tx = new FakeReportTx(REPORT_MESSAGES);
    const uow = new FakeReportUnitOfWork(tx);
    // 실행
    const restricted = await submitReport(uow, {
      actor: CLIENT, messageId: 'message-1', reason: 'ABUSE', now: FIXED_NOW,
    });
    await resolveReport(uow, {
      actor: ADMIN, reportId: restricted.id, action: 'CHAT_RESTRICT_7D',
      actionNote: '반복적인 외부 연락 시도', now: FIXED_NOW,
    });
    // 확인
    assert.deepEqual(tx.accountActions[0], {
      userId: 'supplier-1', action: 'CHAT_RESTRICT_7D', at: FIXED_NOW,
      until: new Date(FIXED_NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
  });

  it('T04b SUSPEND를 계정 Port에 넘긴다', async () => {
    // 준비
    const secondMessageTx = new FakeReportTx([
      ...REPORT_MESSAGES,
      { id: 'message-3', senderId: 'supplier-1', participantIds: ['client-1', 'supplier-1'] },
    ]);
    const secondUow = new FakeReportUnitOfWork(secondMessageTx);
    // 실행
    const suspended = await submitReport(secondUow, {
      actor: CLIENT, messageId: 'message-3', reason: 'FALSE_INFO', now: FIXED_NOW,
    });
    await resolveReport(secondUow, {
      actor: ADMIN, reportId: suspended.id, action: 'SUSPEND', actionNote: '운영 정책 위반', now: FIXED_NOW,
    });
    // 확인
    assert.deepEqual(secondMessageTx.accountActions[0], {
      userId: 'supplier-1', action: 'SUSPEND', at: FIXED_NOW, until: null,
    });
    assert.deepEqual(secondMessageTx.notifications, [{ userId: 'client-1', reportId: suspended.id }]);
  });

  it('두 번째 WARNING은 자동 정지하지 않고 운영 검토 권고만 남긴다', async () => {
    // 준비
    const tx = new FakeReportTx([
      ...REPORT_MESSAGES,
      { id: 'message-3', senderId: 'supplier-1', participantIds: ['client-1', 'supplier-1'] },
    ]);
    tx.reports.push({
      id: 'old-warning', messageId: 'old-message', reporterId: 'client-1', targetUserId: 'supplier-1',
      reason: 'ABUSE', detail: null, status: 'RESOLVED', action: 'WARNING', actionNote: '이전 경고',
      resolvedById: 'admin-1', resolvedAt: FIXED_NOW, createdAt: FIXED_NOW,
    });
    const uow = new FakeReportUnitOfWork(tx);
    // 실행
    const report = await submitReport(uow, {
      actor: CLIENT, messageId: 'message-3', reason: 'ABUSE', now: FIXED_NOW,
    });
    const result = await resolveReport(uow, {
      actor: ADMIN, reportId: report.id, action: 'WARNING', actionNote: '두 번째 경고', now: FIXED_NOW,
    });
    // 확인
    assert.equal(result.warningReviewRecommended, true);
    assert.equal(tx.accountActions.length, 0);
  });
});

interface ContractAccess { readonly contractId: string; readonly userId: string }

class FakeInquiryTx implements InquiryTx {
  inquiries: InquiryRecord[] = [];
  readonly accessibleContracts: readonly ContractAccess[];
  readonly notifications: { userId: string; inquiryId: string }[] = [];
  readonly events: { userId: string; type: string; payload: Readonly<Record<string, unknown>> }[] = [];
  private nextId = 1;
  constructor(accessibleContracts: readonly ContractAccess[] = []) { this.accessibleContracts = accessibleContracts; }
  async canAccessContract(input: ContractAccess): Promise<boolean> {
    return this.accessibleContracts.some((item) => item.contractId === input.contractId && item.userId === input.userId);
  }
  async createInquiry(input: {
    userId: string; category: InquiryRecord['category']; contractId: string | null;
    title: string; body: string; attachments: readonly InquiryAttachment[]; createdAt: Date;
  }): Promise<InquiryRecord> {
    const record: InquiryRecord = {
      ...input, id: `inquiry-${this.nextId}`, status: 'WAITING', answer: null,
      answeredById: null, answeredAt: null,
    };
    this.nextId += 1;
    this.inquiries.push(record);
    return record;
  }
  async findInquiry(id: string): Promise<InquiryRecord | null> { return this.inquiries.find((item) => item.id === id) ?? null; }
  async listInquiries(input: { userId?: string; status?: InquiryRecord['status'] }): Promise<readonly InquiryRecord[]> {
    return this.inquiries.filter((item) => (input.userId === undefined || item.userId === input.userId) &&
      (input.status === undefined || item.status === input.status));
  }
  async answerInquiry(input: {
    inquiryId: string; answeredById: string; answer: string; answeredAt: Date;
  }): Promise<InquiryRecord | null> {
    const index = this.inquiries.findIndex((item) => item.id === input.inquiryId && item.status === 'WAITING');
    const current = this.inquiries[index];
    if (index < 0 || current === undefined) return null;
    const answered = { ...current, status: 'ANSWERED' as const, answer: input.answer,
      answeredById: input.answeredById, answeredAt: input.answeredAt };
    this.inquiries[index] = answered;
    return answered;
  }
  async notifyAuthor(input: { userId: string; inquiryId: string }): Promise<void> { this.notifications.push(input); }
  async logEvent(input: {
    userId: string; type: 'INQUIRY_OPENED' | 'SUPPORT_INQUIRY_SUBMITTED' | 'SUPPORT_INQUIRY_ANSWERED';
    payload: Readonly<Record<string, unknown>>;
  }): Promise<void> { this.events.push(input); }
}

class FakeInquiryUnitOfWork implements InquiryUnitOfWork {
  readonly tx: FakeInquiryTx;
  constructor(tx: FakeInquiryTx = new FakeInquiryTx()) { this.tx = tx; }
  async run<T>(work: (tx: InquiryTx) => Promise<T>): Promise<T> { return work(this.tx); }
}

const ATTACHMENTS: readonly InquiryAttachment[] = [
  { url: 'https://storage.example/private/a', name: 'screen.png', size: 1_000 },
  { url: 'https://storage.example/private/b', name: 'invoice.pdf', size: 2_000 },
];

describe('B-07-T05/T06/T07 1:1 문의 권한·첨부·답변', () => {
  it('유형 6종, 문의 생성과 본인 목록 조회', async () => {
    // 확인
    assert.deepEqual(INQUIRY_CATEGORIES, ['USAGE', 'PAYMENT', 'INSPECTION', 'CANCEL', 'ACCOUNT', 'OTHER']);
    // 준비
    const uow = new FakeInquiryUnitOfWork();
    // 실행
    const created = await createInquiry(uow, {
      actor: CLIENT, category: 'PAYMENT', title: '예치 확인', body: '예치 상태를 확인하고 싶습니다.', now: FIXED_NOW,
    });
    // 확인
    assert.equal(created.userId, CLIENT.userId);
    assert.equal(created.status, 'WAITING');
    assert.equal(uow.tx.events[0]?.type, 'SUPPORT_INQUIRY_SUBMITTED');
    assert.equal(uow.tx.events.length, 1);
    assert.deepEqual((await listMyInquiries(uow, { actor: CLIENT })).map((item) => item.id), [created.id]);
    assert.deepEqual(await listMyInquiries(uow, { actor: INTRUDER }), []);
  });

  it('타인 문의는 404, ADMIN은 상세 조회 가능', async () => {
    // 준비
    const uow = new FakeInquiryUnitOfWork();
    // 실행
    const created = await createInquiry(uow, {
      actor: CLIENT, category: 'USAGE', title: '사용법', body: '문의합니다.', now: FIXED_NOW,
    });
    // 실행 및 확인
    await assert.rejects(getInquiry(uow, { actor: INTRUDER, inquiryId: created.id }),
      isInquiryError(404, 'INQUIRY_NOT_FOUND'));
    assert.equal((await getInquiry(uow, { actor: ADMIN, inquiryId: created.id })).id, created.id);
  });

  it('연결 계약은 당사자만 선택할 수 있다', async () => {
    // 준비
    const uow = new FakeInquiryUnitOfWork(new FakeInquiryTx([{ contractId: 'contract-1', userId: CLIENT.userId }]));
    // 실행 및 확인
    await assert.rejects(createInquiry(uow, {
      actor: INTRUDER, category: 'CANCEL', contractId: 'contract-1', title: '관련 문의', body: '내용', now: FIXED_NOW,
    }), isInquiryError(404, 'CONTRACT_NOT_FOUND'));
    assert.equal(uow.tx.inquiries.length, 0);
  });

  it('첨부 4개·10MB 초과를 거부한다', async () => {
    // 준비
    const uow = new FakeInquiryUnitOfWork();
    // 실행 및 확인
    await assert.rejects(createInquiry(uow, {
      actor: CLIENT, category: 'OTHER', title: '첨부', body: '내용',
      attachments: [...ATTACHMENTS, ...ATTACHMENTS], now: FIXED_NOW,
    }), isInquiryError(400, 'TOO_MANY_ATTACHMENTS'));
    await assert.rejects(createInquiry(uow, {
      actor: CLIENT, category: 'OTHER', title: '첨부', body: '내용',
      attachments: [{ url: '/private/file', name: 'large.bin', size: 10 * 1024 * 1024 + 1 }], now: FIXED_NOW,
    }), isInquiryError(400, 'ATTACHMENT_TOO_LARGE'));
    await assert.rejects(createInquiry(uow, {
      actor: CLIENT, category: 'OTHER', title: '첨부', body: '내용',
      attachments: [{ url: '/private/file', name: 'bad.bin', size: -1 }], now: FIXED_NOW,
    }), isInquiryError(400, 'INVALID_ATTACHMENT'));
  });

  it('T06b 정확한 10MB 첨부는 허용한다', async () => {
    // 준비
    const uow = new FakeInquiryUnitOfWork();
    // 실행
    const record = await createInquiry(uow, {
      actor: CLIENT, category: 'OTHER', title: '첨부', body: '내용',
      attachments: [{ url: '/private/file', name: 'max.bin', size: 10 * 1024 * 1024 }], now: FIXED_NOW,
    });
    // 확인
    assert.equal(record.attachments[0]?.size, 10 * 1024 * 1024);
  });

  it('잘못된 유형·빈 제목·본문은 거부한다', async () => {
    // 준비
    const uow = new FakeInquiryUnitOfWork();
    // 실행 및 확인
    await assert.rejects(createInquiry(uow, {
      actor: CLIENT, category: 'BUG' as unknown as typeof INQUIRY_CATEGORIES[number], title: '제목', body: '본문', now: FIXED_NOW,
    }), isInquiryError(400, 'INVALID_CATEGORY'));
    await assert.rejects(createInquiry(uow, {
      actor: CLIENT, category: 'OTHER', title: ' ', body: '본문', now: FIXED_NOW,
    }), isInquiryError(400, 'INVALID_TITLE'));
    await assert.rejects(createInquiry(uow, {
      actor: CLIENT, category: 'OTHER', title: '제목', body: ' ', now: FIXED_NOW,
    }), isInquiryError(400, 'INVALID_BODY'));
  });

  it('ADMIN만 목록·답변 가능, 답변하면 본인에게만 알림한다', async () => {
    // 준비
    const uow = new FakeInquiryUnitOfWork();
    const created = await createInquiry(uow, {
      actor: CLIENT, category: 'ACCOUNT', title: '계정 문의', body: '계정 확인', now: FIXED_NOW,
    });
    // 실행 및 확인
    await assert.rejects(listInquiriesForAdmin(uow, { actor: CLIENT }), isInquiryError(403, 'ADMIN_ONLY'));
    await assert.rejects(answerInquiry(uow, {
      actor: CLIENT, inquiryId: created.id, answer: '답변', now: FIXED_NOW,
    }), isInquiryError(403, 'ADMIN_ONLY'));
    // 실행
    const answered = await answerInquiry(uow, {
      actor: ADMIN, inquiryId: created.id, answer: '예치 내역을 확인했습니다.', now: FIXED_NOW,
    });
    // 확인
    assert.equal(answered.status, 'ANSWERED');
    assert.deepEqual(uow.tx.notifications, [{ userId: CLIENT.userId, inquiryId: created.id }]);
    assert.equal(uow.tx.events.at(-1)?.type, 'SUPPORT_INQUIRY_ANSWERED');
    assert.equal((await listInquiriesForAdmin(uow, { actor: ADMIN })).length, 1);
    await assert.rejects(answerInquiry(uow, {
      actor: ADMIN, inquiryId: created.id, answer: '중복 답변', now: FIXED_NOW,
    }), isInquiryError(409, 'INQUIRY_ALREADY_ANSWERED'));
  });
});
