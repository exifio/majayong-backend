import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ApplicationStatus } from './dto.ts';
import {
  ApplicationError,
  ApplicationUniqueViolation,
  createApplicationNotificationPort,
  type ApplicationRevision,
  type ApplicationTx,
  type ApplicationUnitOfWork,
  type NewApplicationRevision,
  type ReviseApplicationInput,
  type SubmitApplicationInput,
  assertContractableRevision,
  autoRejectCompetingApplications,
  autoRejectCompetingApplicationsInTransaction,
  attachSupplierProfileSummaries,
  compareApplicationCards,
  markApplicationsStale,
  rejectApplication,
  reviseApplication,
  submitApplication,
  withdrawApplication,
} from './submission.ts';
import { createMarketplaceAutoRejectPort } from './marketplace-port.ts';
import { CONTACT_PLACEHOLDER, maskContacts } from '../chat/masking.ts';
import {
  createNotificationOnceInTransaction,
  type NewNotification,
  type NotificationRecord,
  type NotificationType,
  type NotificationTx,
} from '../notification/notifications.ts';
import { FIXED_NOW, applicationRevision } from '../../../tests/b/fixtures.ts';

const SPEC_ITEM_IDS = ['spec-1', 'spec-2', 'spec-3', 'spec-4'];

function isAppError(status: number, code: string) {
  return (error: unknown): boolean =>
    error instanceof ApplicationError && error.status === status && error.code === code;
}

class FakeApplicationTx implements ApplicationTx {
  rows: ApplicationRevision[];
  systemMessages: { applicationId: string; body: string }[] = [];
  readonly notificationTx = new FakeNotificationTx();
  notifications = createApplicationNotificationPort(this.notificationTx);
  viewedAt: Date | null;
  private forceUnique = false;

  constructor(
    rows: readonly ApplicationRevision[] = [],
    options: { readonly viewedAt?: Date | null; readonly status?: 'RECRUITING' | 'EXPIRED' } = {},
  ) {
    this.rows = [...rows];
    this.viewedAt = options.viewedAt === undefined ? null : options.viewedAt;
    this.status = options.status ?? 'RECRUITING';
  }

  status: 'RECRUITING' | 'EXPIRED';

  failNextCreateWithUnique(): void {
    this.forceUnique = true;
  }

  async findFirstDetailView(): Promise<Date | null> {
    return this.viewedAt;
  }

  async findProjectSpec() {
    return {
      status: this.status,
      currentVersion: 1,
      specItemIds: SPEC_ITEM_IDS,
    };
  }

  async findLatestRevision(input: {
    readonly projectId: string;
    readonly supplierId: string;
  }): Promise<ApplicationRevision | null> {
    const matching = this.rows.filter(
      (row) => row.projectId === input.projectId && row.supplierId === input.supplierId,
    );
    let latest: ApplicationRevision | null = null;
    for (const row of matching) {
      if (latest === null || row.revisionNo > latest.revisionNo) latest = row;
    }
    return latest;
  }

  async findById(applicationId: string): Promise<ApplicationRevision | null> {
    return this.rows.find((row) => row.id === applicationId) ?? null;
  }

  async listByProject(projectId: string): Promise<readonly ApplicationRevision[]> {
    return this.rows.filter((row) => row.projectId === projectId);
  }

  async createRevision(input: NewApplicationRevision): Promise<ApplicationRevision> {
    if (this.forceUnique) {
      this.forceUnique = false;
      throw new ApplicationUniqueViolation();
    }

    const duplicateRevision = this.rows.some(
      (row) =>
        row.projectId === input.projectId &&
        row.supplierId === input.supplierId &&
        row.revisionNo === input.revisionNo,
    );
    const activeDuplicate = this.rows.some(
      (row) =>
        row.projectId === input.projectId &&
        row.supplierId === input.supplierId &&
        (row.status === 'SUBMITTED' || row.status === 'STALE' || row.status === 'ACCEPTED'),
    );
    if (duplicateRevision || activeDuplicate) throw new ApplicationUniqueViolation();

    const created: ApplicationRevision = {
      ...input,
      id: `app-${this.rows.length + 1}`,
      status: 'SUBMITTED',
    };
    this.rows.push(created);
    return created;
  }

  async updateStatus(input: {
    readonly applicationId: string;
    readonly from: readonly ApplicationStatus[];
    readonly to: ApplicationStatus;
  }): Promise<boolean> {
    const index = this.rows.findIndex(
      (row) => row.id === input.applicationId && input.from.includes(row.status),
    );
    const current = this.rows[index];
    if (index < 0 || current === undefined) return false;

    this.rows[index] = { ...current, status: input.to };
    return true;
  }

  async appendSystemMessage(input: {
    readonly applicationId: string;
    readonly body: string;
  }): Promise<void> {
    this.systemMessages.push({ applicationId: input.applicationId, body: input.body });
  }

}

class FakeNotificationTx implements NotificationTx {
  readonly rows: { readonly userId: string; readonly type: NotificationType; readonly targetId: string }[] = [];
  failCreate: Error | null = null;
  async findByKey(input: { readonly userId: string; readonly type: NotificationType; readonly targetId: string }): Promise<NotificationRecord | null> {
    return this.rows.some((row) => row.userId === input.userId && row.type === input.type && row.targetId === input.targetId)
      ? { id: 'notification-1', userId: input.userId, type: input.type, targetUrl: '/projects/prj-1/applications', targetId: input.targetId, payload: null, isRead: false, createdAt: FIXED_NOW }
      : null;
  }
  async create(input: NewNotification): Promise<NotificationRecord> {
    if (this.failCreate !== null) throw this.failCreate;
    this.rows.push({ userId: input.userId, type: input.type, targetId: input.targetId });
    return { ...input, id: `notification-${this.rows.length}`, isRead: false };
  }
  async refreshBundled(): Promise<NotificationRecord> { throw new Error('not a chat notification'); }
  async listRecent() { return []; }
  async countUnread() { return 0; }
  async markRead() { return false; }
  async markAllRead() { return 0; }
}

class FakeUnitOfWork implements ApplicationUnitOfWork {
  readonly tx: FakeApplicationTx;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(tx: FakeApplicationTx) {
    this.tx = tx;
  }

  run<T>(work: (tx: ApplicationTx) => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const before = {
        rows: structuredClone(this.tx.rows),
        systemMessages: structuredClone(this.tx.systemMessages),
        notificationRows: structuredClone(this.tx.notificationTx.rows),
      };
      try {
        return await work(this.tx);
      } catch (error) {
        this.tx.rows = before.rows;
        this.tx.systemMessages = before.systemMessages;
        this.tx.notificationTx.rows.splice(0, this.tx.notificationTx.rows.length, ...before.notificationRows);
        throw error;
      }
    });
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function submitInput(
  overrides: Partial<SubmitApplicationInput> = {},
): SubmitApplicationInput {
  return {
    projectId: 'prj-1',
    clientUserId: 'client-1',
    supplierId: 'supplier-1',
    projectStatus: 'RECRUITING',
    specVersionNo: 1,
    specItemIds: SPEC_ITEM_IDS,
    totalAmount: 3_100_000,
    durationDays: 42,
    message: '잘 부탁드립니다.',
    questions: [],
    items: [
      { specItemId: 'spec-1', isAvailable: true },
      { specItemId: 'spec-2', isAvailable: false },
    ],
    now: FIXED_NOW,
    ...overrides,
  };
}

function reviseInput(overrides: Partial<ReviseApplicationInput> = {}): ReviseApplicationInput {
  return {
    applicationId: 'app-1',
    supplierId: 'supplier-1',
    specVersionNo: 1,
    specItemIds: SPEC_ITEM_IDS,
    totalAmount: 3_300_000,
    durationDays: 40,
    items: [{ specItemId: 'spec-1', isAvailable: true }],
    revisionReason: '명세가 바뀌어 일정을 조정합니다.',
    now: new Date('2026-11-05T00:00:00.000Z'),
    ...overrides,
  };
}

describe('B-02-T01 상세 미열람 지원 거부', () => {
  it('상세 열람 기록이 없으면 403 DETAIL_VIEW_REQUIRED다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: null });

    // 실행 및 확인
    await assert.rejects(
      submitApplication(new FakeUnitOfWork(tx), submitInput()),
      isAppError(403, 'DETAIL_VIEW_REQUIRED'),
    );
    // 확인
    assert.equal(tx.rows.length, 0);
  });

  it('모집 중이 아니면 409 PROJECT_NOT_RECRUITING이다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW, status: 'EXPIRED' });

    // 실행 및 확인
    await assert.rejects(
      submitApplication(new FakeUnitOfWork(tx), submitInput({ projectStatus: 'RECRUITING' })),
      isAppError(409, 'PROJECT_NOT_RECRUITING'),
    );
  });

  it('가능 항목이 하나도 없거나 명세에 없는 항목이면 거부한다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW });
    const uow = new FakeUnitOfWork(tx);

    // 실행 및 확인
    await assert.rejects(
      submitApplication(
        uow,
        submitInput({ items: [{ specItemId: 'spec-1', isAvailable: false }] }),
      ),
      isAppError(400, 'NO_AVAILABLE_ITEM'),
    );
  });

  it('B-02-T03b 명세에 없는 항목 ID는 INVALID_SPEC_ITEM으로 거부한다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW });
    const uow = new FakeUnitOfWork(tx);

    // 실행 및 확인
    await assert.rejects(
      submitApplication(
        uow,
        submitInput({ items: [{ specItemId: 'spec-9', isAvailable: true }] }),
      ),
      isAppError(400, 'INVALID_SPEC_ITEM'),
    );
  });

  it('유효한 지원은 1회차 SUBMITTED로 저장하고 최초 열람 시각을 남긴다', async () => {
    // 준비
    const viewedAt = new Date('2026-10-28T01:00:00.000Z');
    const tx = new FakeApplicationTx([], { viewedAt });
    const uow = new FakeUnitOfWork(tx);

    // 실행
    const created = await submitApplication(uow, submitInput());

    // 확인
    assert.equal(created.revisionNo, 1);
    assert.equal(created.status, 'SUBMITTED');
    assert.equal(created.firstViewedAt.toISOString(), viewedAt.toISOString());
    assert.equal(created.totalAmount, 3_100_000);
    assert.deepEqual(created.items, [
      { specItemId: 'spec-1', isAvailable: true },
      { specItemId: 'spec-2', isAvailable: false },
    ]);
  });
});

describe('B-02-T02 중복·동시 제출', () => {
  it('이미 진행 중인 지원이 있으면 409 APPLICATION_ALREADY_SUBMITTED다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW });
    const uow = new FakeUnitOfWork(tx);

    // 실행
    await submitApplication(uow, submitInput());

    // 실행 및 확인
    await assert.rejects(
      submitApplication(uow, submitInput()),
      isAppError(409, 'APPLICATION_ALREADY_SUBMITTED'),
    );
    // 확인
    assert.equal(tx.rows.length, 1);
  });

  it('동시 제출은 한 건만 성공하고 나머지는 409다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW });
    const uow = new FakeUnitOfWork(tx);

    // 실행
    const results = await Promise.allSettled([
      submitApplication(uow, submitInput()),
      submitApplication(uow, submitInput()),
    ]);

    // 준비
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    // 확인
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(tx.rows.length, 1);

    // 준비
    const failure = rejected[0];
    // 확인
    assert.equal(failure?.status, 'rejected');
    if (failure?.status === 'rejected') {
      assert.equal(failure.reason instanceof ApplicationError, true);
      assert.equal(failure.reason.code, 'APPLICATION_ALREADY_SUBMITTED');
    }
  });

  it('DB unique 위반은 409 APPLICATION_ALREADY_SUBMITTED로 바꾼다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW });
    const uow = new FakeUnitOfWork(tx);
    tx.failNextCreateWithUnique();

    // 실행 및 확인
    await assert.rejects(
      submitApplication(uow, submitInput()),
      isAppError(409, 'APPLICATION_ALREADY_SUBMITTED'),
    );
  });
});

describe('B-02-T03 질문 3개 제한·연락처 원문 저장 금지', () => {
  it('질문은 최대 3개이며 4개는 400 TOO_MANY_QUESTIONS다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW });

    // 실행 및 확인
    await assert.rejects(
      submitApplication(
        new FakeUnitOfWork(tx),
        submitInput({
          questions: [{ text: 'q1' }, { text: 'q2' }, { text: 'q3' }, { text: 'q4' }],
        }),
      ),
      isAppError(400, 'TOO_MANY_QUESTIONS'),
    );
    // 확인
    assert.equal(tx.rows.length, 0);
  });

  it('메시지·질문의 전화·이메일·메신저 ID는 저장 전에 가린다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW });
    const message = '카톡 chef123, 010-1234-5678, owner@example.com 으로 연락 주세요.';
    const questionText = '텔레그램 @chef_kim 으로 답 주시면 02-123-4567도 됩니다.';

    // 실행
    const created = await submitApplication(
      new FakeUnitOfWork(tx),
      submitInput({ message, questions: [{ text: questionText }] }),
    );

    // 확인
    assert.equal(created.message?.includes(CONTACT_PLACEHOLDER), true);
    assert.equal(created.questions[0]?.text.includes(CONTACT_PLACEHOLDER), true);
    assert.equal(created.isMessageMasked, true);

    // 준비
    const stored = JSON.stringify(tx.rows);
    // 확인
    for (const original of [
      'chef123',
      '010-1234-5678',
      'owner@example.com',
      '@chef_kim',
      '02-123-4567',
    ]) {
      assert.equal(stored.includes(original), false);
    }
  });

  it('연락처가 없는 본문은 그대로 저장하고 isMessageMasked=false다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW });

    // 실행
    const created = await submitApplication(
      new FakeUnitOfWork(tx),
      submitInput({ message: '일정과 범위 확인했습니다.', questions: [{ text: '예약금은 어떻게 처리하나요?' }] }),
    );

    // 확인
    assert.equal(created.message, '일정과 범위 확인했습니다.');
    assert.equal(created.isMessageMasked, false);
  });

  it('가림기는 여러 연락처를 한 번에 바꾸고 이미 가린 본문은 그대로 둔다', () => {
    // 실행
    const masked = maskContacts('010-1111-2222 / a@b.co.kr / 카톡: chef1');
    // 확인
    assert.equal(masked.masked, true);
    assert.equal(masked.text.includes('chef1'), false);
    assert.equal(masked.text.includes('010-1111-2222'), false);

    // 실행
    const again = maskContacts(masked.text);
    // 확인
    assert.equal(again.text, masked.text);
    assert.equal(again.masked, false);
  });
});

describe('B-02-T04 명세 변경 → STALE', () => {
  it('해당 프로젝트의 SUBMITTED만 STALE로 바꾸고 나머지는 유지한다', async () => {
    // 준비
    const tx = new FakeApplicationTx([
      applicationRevision({ id: 'app-1', supplierId: 'supplier-1', status: 'SUBMITTED' }),
      applicationRevision({ id: 'app-2', supplierId: 'supplier-2', status: 'STALE' }),
      applicationRevision({ id: 'app-3', supplierId: 'supplier-3', status: 'ACCEPTED' }),
      applicationRevision({
        id: 'app-4',
        projectId: 'prj-2',
        supplierId: 'supplier-4',
        status: 'SUBMITTED',
      }),
    ]);

    // 실행
    const count = await markApplicationsStale(new FakeUnitOfWork(tx), { projectId: 'prj-1', now: FIXED_NOW });

    // 확인
    assert.equal(count, 1);
    assert.deepEqual(
      tx.rows.map((row) => [row.id, row.status]),
      [
        ['app-1', 'STALE'],
        ['app-2', 'STALE'],
        ['app-3', 'ACCEPTED'],
        ['app-4', 'SUBMITTED'],
      ],
    );
  });
});

describe('B-02-T05 견적 수정 회차', () => {
  it('이전 회차는 SUPERSEDED, 새 회차는 항목·질문·메시지·최초 열람 시각을 복사한다', async () => {
    // 준비
    const previous = applicationRevision({
      questions: [{ text: '예약금은 어떻게 처리하나요?' }],
    });
    const tx = new FakeApplicationTx([previous], { viewedAt: previous.firstViewedAt });
    const uow = new FakeUnitOfWork(tx);

    // 실행
    const result = await reviseApplication(uow, reviseInput());

    // 확인
    assert.equal(result.previous.status, 'SUPERSEDED');
    assert.equal(result.current.revisionNo, 2);
    assert.equal(result.current.status, 'SUBMITTED');
    assert.equal(result.current.specVersionNo, 1);
    assert.equal(result.current.totalAmount, 3_300_000);
    assert.equal(result.current.durationDays, 40);
    assert.equal(
      result.current.firstViewedAt.toISOString(),
      previous.firstViewedAt.toISOString(),
    );
    assert.equal(result.current.message, previous.message);
    assert.deepEqual(result.current.questions, previous.questions);
    assert.equal(result.current.revisionReason, '명세가 바뀌어 일정을 조정합니다.');
    assert.equal(tx.rows.length, 2);
    assert.equal(tx.rows[0]?.status, 'SUPERSEDED');
    assert.equal(tx.systemMessages.length, 1);
    assert.equal(tx.systemMessages[0]?.applicationId, result.current.id);
  });

  it('STALE 회차도 재견적할 수 있고 이전 회차는 남는다', async () => {
    // 준비
    const tx = new FakeApplicationTx([applicationRevision({ status: 'STALE' })], {
      viewedAt: FIXED_NOW,
    });

    // 실행
    const result = await reviseApplication(new FakeUnitOfWork(tx), reviseInput());

    // 확인
    assert.equal(result.previous.status, 'SUPERSEDED');
    assert.equal(result.current.status, 'SUBMITTED');
  });

  it('임시 계약(ACCEPTED) 이후에는 견적을 수정할 수 없다', async () => {
    // 준비
    const tx = new FakeApplicationTx([applicationRevision({ status: 'ACCEPTED' })], {
      viewedAt: FIXED_NOW,
    });

    // 실행 및 확인
    await assert.rejects(
      reviseApplication(new FakeUnitOfWork(tx), reviseInput()),
      isAppError(409, 'APPLICATION_NOT_REVISABLE'),
    );
  });

  it('다른 공급자의 회차는 404로 존재를 숨긴다', async () => {
    // 준비
    const tx = new FakeApplicationTx([applicationRevision()], { viewedAt: FIXED_NOW });

    // 실행 및 확인
    await assert.rejects(
      reviseApplication(
        new FakeUnitOfWork(tx),
        reviseInput({ supplierId: 'supplier-2' }),
      ),
      isAppError(404, 'APPLICATION_NOT_FOUND'),
    );
  });

  it('수정 메시지의 연락처도 가린다', async () => {
    // 준비
    const tx = new FakeApplicationTx([applicationRevision()], { viewedAt: FIXED_NOW });

    // 실행
    const result = await reviseApplication(
      new FakeUnitOfWork(tx),
      reviseInput({ message: '카톡 chef999로 연락 주세요.' }),
    );

    // 확인
    assert.equal(result.current.message?.includes('chef999'), false);
    assert.equal(result.current.isMessageMasked, true);
  });
});

describe('B-02-T06 구 회차 계약 시도 거부', () => {
  const oldRevision = applicationRevision({ id: 'app-1', revisionNo: 1, status: 'SUPERSEDED' });
  const latestRevision = applicationRevision({ id: 'app-2', revisionNo: 2, status: 'SUBMITTED' });

  it('최신 회차가 아니면 409 APPLICATION_REVISION_SUPERSEDED다', () => {
    // 실행 및 확인
    assert.throws(
      () => assertContractableRevision({ revision: oldRevision, latest: latestRevision }),
      isAppError(409, 'APPLICATION_REVISION_SUPERSEDED'),
    );
  });

  it('최신 회차가 SUBMITTED가 아니면 409 APPLICATION_NOT_SUBMITTED다', () => {
    // 실행 및 확인
    assert.throws(
      () =>
        assertContractableRevision({
          revision: latestRevision,
          latest: { ...latestRevision, status: 'STALE' },
        }),
      isAppError(409, 'APPLICATION_NOT_SUBMITTED'),
    );
  });

  it('최신 SUBMITTED 회차는 통과한다', () => {
    // 실행 및 확인
    assert.doesNotThrow(() =>
      assertContractableRevision({ revision: latestRevision, latest: latestRevision }),
    );
  });
});

describe('B-02-T07 철회·직접 거절', () => {
  it('공급자는 SUBMITTED·STALE(보류) 지원을 철회할 수 있다', async () => {
    // 준비
    const tx = new FakeApplicationTx([
      applicationRevision({ id: 'app-1', status: 'SUBMITTED' }),
      applicationRevision({ id: 'app-2', supplierId: 'supplier-2', status: 'STALE' }),
    ]);
    const uow = new FakeUnitOfWork(tx);

    // 실행 및 확인
    assert.deepEqual(
      await withdrawApplication(uow, { applicationId: 'app-1', supplierId: 'supplier-1' }),
      { status: 'WITHDRAWN' },
    );
    assert.deepEqual(
      await withdrawApplication(uow, { applicationId: 'app-2', supplierId: 'supplier-2' }),
      { status: 'WITHDRAWN' },
    );
    // 확인
    assert.deepEqual(
      tx.rows.map((row) => row.status),
      ['WITHDRAWN', 'WITHDRAWN'],
    );
  });

  it('ACCEPTED 지원은 철회할 수 없고 다른 공급자는 404다', async () => {
    // 준비
    const tx = new FakeApplicationTx([applicationRevision({ status: 'ACCEPTED' })]);
    const uow = new FakeUnitOfWork(tx);

    // 실행 및 확인
    await assert.rejects(
      withdrawApplication(uow, { applicationId: 'app-1', supplierId: 'supplier-1' }),
      isAppError(409, 'APPLICATION_STATE_CHANGED'),
    );
    await assert.rejects(
      withdrawApplication(uow, { applicationId: 'app-1', supplierId: 'supplier-2' }),
      isAppError(404, 'APPLICATION_NOT_FOUND'),
    );
  });

  it('의뢰인은 진행 중 지원을 직접 거절할 수 있다', async () => {
    // 준비
    const tx = new FakeApplicationTx([applicationRevision()]);
    const uow = new FakeUnitOfWork(tx);

    // 실행 및 확인
    assert.deepEqual(
      await rejectApplication(uow, { applicationId: 'app-1', clientUserId: 'client-1', now: FIXED_NOW }),
      { status: 'REJECTED' },
    );
    // 확인
    assert.equal(tx.rows[0]?.status, 'REJECTED');
  });
});

describe('B-02 보조: 예치 완료 자동 거절 Port', () => {
  it('계약한 지원을 뺀 SUBMITTED·STALE만 AUTO_REJECTED로 바꾼다', async () => {
    // 준비
    const tx = new FakeApplicationTx([
      applicationRevision({ id: 'app-1', supplierId: 'supplier-1', status: 'ACCEPTED' }),
      applicationRevision({ id: 'app-2', supplierId: 'supplier-2', status: 'SUBMITTED' }),
      applicationRevision({ id: 'app-3', supplierId: 'supplier-3', status: 'STALE' }),
      applicationRevision({ id: 'app-4', supplierId: 'supplier-4', status: 'REJECTED' }),
    ]);

    // 실행
    const count = await autoRejectCompetingApplications(new FakeUnitOfWork(tx), {
      projectId: 'prj-1',
      acceptedApplicationId: 'app-1',
      now: FIXED_NOW,
    });

    // 확인
    assert.equal(count, 2);
    assert.deepEqual(
      tx.rows.map((row) => [row.id, row.status]),
      [
        ['app-1', 'ACCEPTED'],
        ['app-2', 'AUTO_REJECTED'],
        ['app-3', 'AUTO_REJECTED'],
        ['app-4', 'REJECTED'],
      ],
    );
  });

  it('제공된 transaction-scoped port로 다른 지원만 자동 거절한다', async () => {
    // 준비
    const tx = new FakeApplicationTx([
      applicationRevision({ id: 'app-1', status: 'ACCEPTED' }),
      applicationRevision({ id: 'app-2', supplierId: 'supplier-2', status: 'SUBMITTED' }),
      applicationRevision({ id: 'app-3', supplierId: 'supplier-3', status: 'STALE' }),
    ]);
    // 실행
    const result = await autoRejectCompetingApplicationsInTransaction(tx, {
      projectId: 'prj-1',
      acceptedApplicationId: 'app-1',
      now: FIXED_NOW,
    });

    // 확인
    assert.deepEqual(result, { rejectedCount: 2 });
    assert.deepEqual(tx.rows.map((row) => row.status), ['ACCEPTED', 'AUTO_REJECTED', 'AUTO_REJECTED']);
  });
});

describe('B-02 보조: 지원 비교 카드', () => {
  it('공급자별 최신 회차만 지원 순서대로 보여 주고 판정 필드를 만들지 않는다', () => {
    // 실행
    const cards = compareApplicationCards([
      applicationRevision({
        id: 'app-1',
        supplierId: 'supplier-1',
        revisionNo: 1,
        submittedAt: new Date('2026-10-29T00:00:00.000Z'),
        totalAmount: 2_000_000,
      }),
      applicationRevision({
        id: 'app-2',
        supplierId: 'supplier-1',
        revisionNo: 2,
        submittedAt: new Date('2026-10-30T00:00:00.000Z'),
        totalAmount: 2_500_000,
        questions: [{ text: 'q1' }, { text: 'q2' }],
      }),
      applicationRevision({
        id: 'app-3',
        supplierId: 'supplier-2',
        submittedAt: new Date('2026-10-28T00:00:00.000Z'),
        totalAmount: 3_000_000,
      }),
    ]);

    // 확인
    assert.deepEqual(
      cards.map((card) => [card.supplierId, card.revisionNo, card.revisionCount]),
      [
        ['supplier-2', 1, 1],
        ['supplier-1', 2, 2],
      ],
    );
    assert.equal(cards[1]?.totalAmount, 2_500_000);
    assert.equal(cards[1]?.questionCount, 2);

    for (const card of cards) {
      assert.equal('isLowest' in card, false);
      assert.equal('recommended' in card, false);
      assert.equal('rank' in card, false);
    }
  });

  it('A의 공개 프로필에서 경력·리뷰·완료 계약·요약만 카드에 붙인다', () => {
    // 실행
    const cards = compareApplicationCards([
      applicationRevision({ id: 'app-1', supplierId: 'supplier-1' }),
      applicationRevision({ id: 'app-2', supplierId: 'supplier-2' }),
    ]);
    const enriched = attachSupplierProfileSummaries(cards, [
      {
        supplierId: 'supplier-1', careerYears: 6, ratingAvg: 4.5,
        reviewCount: 2, completedContractCount: 3, portfolioSummary: '예약 서비스 구축 경험',
      },
    ]);

    // 확인
    assert.deepEqual(enriched[0], {
      ...cards[0], careerYears: 6, ratingAvg: 4.5, reviewCount: 2,
      completedContractCount: 3, portfolioSummary: '예약 서비스 구축 경험',
    });
    assert.deepEqual(enriched[1], {
      ...cards[1], careerYears: null, ratingAvg: null, reviewCount: 0,
      completedContractCount: 0, portfolioSummary: null,
    });
    // 준비
    const serialized = JSON.stringify(enriched);
    // 확인
    assert.equal(serialized.includes('email'), false);
    assert.equal(serialized.includes('unitPrice'), false);
    assert.equal(serialized.includes('payout'), false);
  });
});

describe('B-02 보조: C 예치 완료 자동 거절 adapter', () => {
  it('C MarketplacePorts 모양으로 같은 도메인 함수에 위임한다', async () => {
    // 준비
    const tx = new FakeApplicationTx([
      applicationRevision({ id: 'app-2', supplierId: 'supplier-2', status: 'SUBMITTED' }),
      applicationRevision({ id: 'app-3', supplierId: 'supplier-3', status: 'STALE' }),
      applicationRevision({ id: 'app-4', supplierId: 'supplier-4', status: 'ACCEPTED' }),
    ]);
    const port = createMarketplaceAutoRejectPort(new FakeUnitOfWork(tx));

    // 실행
    const result = await port.autoRejectCompetingApplications({
      projectId: 'prj-1',
      acceptedApplicationId: 'app-1',
      now: FIXED_NOW,
    });

    // 확인
    assert.deepEqual(result, { rejectedCount: 2 });
    assert.deepEqual(
      tx.rows.map((row) => [row.id, row.status]),
      [
        ['app-2', 'AUTO_REJECTED'],
        ['app-3', 'AUTO_REJECTED'],
        ['app-4', 'ACCEPTED'],
      ],
    );
  });

  it('자동 거절 실패는 C 트랜잭션에 그대로 전파한다', async () => {
    // 준비
    const failing: ApplicationUnitOfWork = {
      run: async () => {
        throw new Error('deposit tx failed');
      },
    };
    const port = createMarketplaceAutoRejectPort(failing);

    // 실행 및 확인
    await assert.rejects(
      port.autoRejectCompetingApplications({ projectId: 'prj-1', acceptedApplicationId: 'app-1', now: FIXED_NOW }),
      /deposit tx failed/,
    );
  });
});

describe('B-02-T08 지원·거절·재견적 알림 발행', () => {
  it('지원 제출은 의뢰인에게 APPLICATION_RECEIVED를 프로젝트 대상으로 1회 보낸다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW });

    // 실행
    await submitApplication(
      new FakeUnitOfWork(tx),
      submitInput(),
    );

    // 확인
    assert.equal(tx.notificationTx.rows.length, 1);
    assert.equal(tx.notificationTx.rows[0]?.type, 'APPLICATION_RECEIVED');
    assert.equal(tx.notificationTx.rows[0]?.userId, 'client-1');
    assert.equal(tx.notificationTx.rows[0]?.targetId, 'prj-1');
  });

  it('거부된 지원 제출은 알림을 보내지 않는다', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: null });
    // 실행 및 확인
    await assert.rejects(
      submitApplication(new FakeUnitOfWork(tx), submitInput()),
      isAppError(403, 'DETAIL_VIEW_REQUIRED'),
    );
    // 확인
    assert.equal(tx.notificationTx.rows.length, 0);
  });

  it('견적 수정도 의뢰인에게 APPLICATION_RECEIVED를 보낸다', async () => {
    // 준비
    const previous = applicationRevision();
    const tx = new FakeApplicationTx([previous], { viewedAt: previous.firstViewedAt });
    // 실행
    const result = await reviseApplication(
      new FakeUnitOfWork(tx),
      reviseInput(),
    );

    // 확인
    assert.equal(tx.notificationTx.rows.length, 1);
    assert.equal(tx.notificationTx.rows[0]?.type, 'APPLICATION_RECEIVED');
    assert.equal(tx.notificationTx.rows[0]?.targetId, result.current.projectId);
  });

  it('의뢰인 직접 거절은 공급자에게 APPLICATION_REJECTED를 지원 대상으로 보낸다', async () => {
    // 준비
    const tx = new FakeApplicationTx([applicationRevision()]);
    // 실행
    await rejectApplication(new FakeUnitOfWork(tx), {
      applicationId: 'app-1',
      clientUserId: 'client-1',
      now: FIXED_NOW,
    });

    // 확인
    assert.equal(tx.notificationTx.rows.length, 1);
    assert.equal(tx.notificationTx.rows[0]?.type, 'APPLICATION_REJECTED');
    assert.equal(tx.notificationTx.rows[0]?.userId, 'supplier-1');
    assert.equal(tx.notificationTx.rows[0]?.targetId, 'app-1');
  });

  it('명세 변경으로 STALE이 된 지원에만 REQUOTE_REQUESTED를 보낸다', async () => {
    // 준비
    const tx = new FakeApplicationTx([
      applicationRevision({ id: 'app-1', supplierId: 'supplier-1', status: 'SUBMITTED' }),
      applicationRevision({ id: 'app-2', supplierId: 'supplier-2', status: 'STALE' }),
      applicationRevision({ id: 'app-3', supplierId: 'supplier-3', status: 'ACCEPTED' }),
    ]);
    // 실행
    const count = await markApplicationsStale(new FakeUnitOfWork(tx), {
      projectId: 'prj-1',
      now: FIXED_NOW,
    });

    // 확인
    assert.equal(count, 1);
    assert.equal(tx.notificationTx.rows.length, 1);
    assert.equal(tx.notificationTx.rows[0]?.type, 'REQUOTE_REQUESTED');
    assert.equal(tx.notificationTx.rows[0]?.userId, 'supplier-1');
    assert.equal(tx.notificationTx.rows[0]?.targetId, 'app-1');
  });

  it('알림 발행 실패는 지원 쓰기 실패로 전파된다(실제 롤백은 PG 통합)', async () => {
    // 준비
    const tx = new FakeApplicationTx([], { viewedAt: FIXED_NOW });
    tx.notificationTx.failCreate = new Error('notify down');

    // 실행 및 확인
    await assert.rejects(
      submitApplication(new FakeUnitOfWork(tx), submitInput()),
      /notify down/,
    );
    // 확인
    assert.equal(tx.rows.length, 0);
    assert.equal(tx.notificationTx.rows.length, 0);
  });
});
