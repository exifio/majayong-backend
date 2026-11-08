import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgreementDraft } from '../agreement/draft.ts';
import {
  ApplicationAccessError,
  ApplicationError,
  requireApplicationParty,
  type Actor,
  type ApplicationRecord,
} from './dto.ts';
import { summarizeBMetrics, type BMetricSource } from './metrics.ts';
import {
  getApplicationDetail,
  listMyApplications,
  listProjectApplicationCards,
  type ApplicationReadPort,
  type ProjectApplicationsPort,
} from './queries.ts';
import {
  assertContractableRevision,
  compareApplicationCards,
  type ApplicationRevision,
} from './submission.ts';
import {
  acceptAgreement,
  ContractError,
  contractDocumentFor,
  type ContractRecord,
  type ContractTx,
  type ContractUnitOfWork,
} from '../contract/lifecycle.ts';
import {
  getContractDetail,
  listMyContracts,
  type ContractReadPort,
} from '../contract/queries.ts';
import {
  listChatRooms,
  type ChatMessage,
  type ChatRoomListPort,
  type ChatRoomRecord,
} from '../chat/conversation.ts';
import {
  listMyReports,
  type MyReportQueryPort,
  type ReportRecord,
} from '../report/reports.ts';
import { applicationRecord, applicationRevision, chatMessage, FIXED_NOW } from '../../../tests/b/fixtures.ts';

function buildMetricSource(): BMetricSource {
  return {
    quotes: [
      { firstViewedAt: new Date('2026-11-03T08:00:00.000Z'), submittedAt: new Date('2026-11-03T10:00:00.000Z') },
      { firstViewedAt: new Date('2026-11-03T09:00:00.000Z'), submittedAt: new Date('2026-11-03T10:00:00.000Z') },
    ],
    appliedProjectIds: ['project-1', 'project-1', 'project-2', 'project-3'],
    inquiryOpenedProjectIds: ['project-1', 'project-3', 'project-outside-window'],
    contractEvents: [
      { type: 'APPLICATION_ACCEPTED', contractId: 'contract-1', conditionCount: 10, decidedCount: 9 },
      { type: 'APPLICATION_ACCEPTED', contractId: 'contract-1', conditionCount: 10, decidedCount: 9 },
      { type: 'APPLICATION_ACCEPTED', contractId: 'contract-2', conditionCount: 4, decidedCount: 2 },
      { type: 'APPLICATION_ACCEPTED', contractId: 'contract-3', conditionCount: 2, decidedCount: 2 },
      { type: 'CONTRACT_AGREED', contractId: 'contract-1' },
      { type: 'CONTRACT_AGREED', contractId: 'contract-1' },
      { type: 'CONTRACT_AGREED', contractId: 'contract-2' },
      { type: 'CONTRACT_AGREED', contractId: 'contract-3' },
      { type: 'CONTRACT_BROKEN', contractId: 'contract-1', reason: 'SIGN_REFUSED' },
      { type: 'CONTRACT_BROKEN', contractId: 'contract-3', reason: 'DEPOSIT_TIMEOUT' },
      // ERD EventLog는 양쪽 당사자에 기록되므로 중복 이벤트 1건도 dedupe한다.
      { type: 'CONTRACT_BROKEN', contractId: 'contract-1', reason: 'SIGN_REFUSED' },
    ],
    reports: [
      { chatRoomId: 'room-1', action: 'WARNING' },
      { chatRoomId: 'room-1', action: 'CHAT_RESTRICT_7D' },
      { chatRoomId: 'room-3', action: null },
    ],
    chatRoomCount: 4,
  };
}

function isError(code: string) {
  return (error: unknown): boolean =>
    (error instanceof ApplicationAccessError ||
      error instanceof ApplicationError ||
      error instanceof ContractError) && error.code === code;
}

describe('B-08-T01 지표 이벤트 샘플·개인정보 최소화', () => {
  it('견적 시간·문의율·조건 결정률·결렬률·신고 분포를 원천 데이터로 재계산한다', () => {
    // 실행
    const summary = summarizeBMetrics(buildMetricSource());
    // 확인
    assert.deepEqual(summary, {
      quoteDraft: { count: 2, averageDurationMs: 5_400_000 },
      inquiryRate: { eligibleProjects: 3, projectsWithInquiry: 2, rate: 2 / 3 },
      conditionDecisionRate: { totalConditions: 16, decidedConditions: 13, rate: 13 / 16 },
      contractBreakRate: {
        acceptedContracts: 3, brokenContracts: 2, rate: 2 / 3,
        byReason: { CONSENT_TIMEOUT: 0, SIGN_REFUSED: 1, CLIENT_CANCELLED: 0, DEPOSIT_TIMEOUT: 1 },
      },
      depositTimeoutRate: { agreedContracts: 3, depositTimeouts: 1, rate: 1 / 3 },
      reportRate: {
        chatRooms: 4, reportedRooms: 2, reports: 3, reportsPerChatRoom: 0.75, rate: 0.5,
        byAction: { UNRESOLVED: 1, NONE: 0, WARNING: 1, CHAT_RESTRICT_7D: 1, SUSPEND: 0 },
      },
    });

    // 준비
    const serialized = JSON.stringify(summary);
    // 확인
    for (const privateValue of ['client-1', 'supplier-1', 'owner@example.com', 'project-1', 'room-1']) {
      assert.equal(serialized.includes(privateValue), false);
    }
  });

  it('조건·시간 데이터가 잘못되면 잘못된 지표 대신 거부한다', () => {
    // 준비
    const invalid: BMetricSource = {
      ...buildMetricSource(),
      quotes: [{ firstViewedAt: new Date('2026-11-04T10:00:00.000Z'), submittedAt: new Date('2026-11-03T10:00:00.000Z') }],
    };
    // 실행 및 확인
    assert.throws(() => summarizeBMetrics(invalid), /INVALID_METRIC_SOURCE/);
    // 준비
    const invalidAgreement: BMetricSource = {
      ...buildMetricSource(),
      contractEvents: [{ type: 'APPLICATION_ACCEPTED', contractId: 'contract-1', conditionCount: 1, decidedCount: 2 }],
    };
    // 실행 및 확인
    assert.throws(() => summarizeBMetrics(invalidAgreement), /INVALID_METRIC_SOURCE/);
    // 실행
    const empty = summarizeBMetrics({
      quotes: [], appliedProjectIds: [], inquiryOpenedProjectIds: [], contractEvents: [], reports: [], chatRoomCount: 0,
    });
    // 확인
    assert.deepEqual(empty, {
      quoteDraft: { count: 0, averageDurationMs: 0 },
      inquiryRate: { eligibleProjects: 0, projectsWithInquiry: 0, rate: 0 },
      conditionDecisionRate: { totalConditions: 0, decidedConditions: 0, rate: 0 },
      contractBreakRate: {
        acceptedContracts: 0, brokenContracts: 0, rate: 0,
        byReason: { CONSENT_TIMEOUT: 0, SIGN_REFUSED: 0, CLIENT_CANCELLED: 0, DEPOSIT_TIMEOUT: 0 },
      },
      depositTimeoutRate: { agreedContracts: 0, depositTimeouts: 0, rate: 0 },
      reportRate: {
        chatRooms: 0, reportedRooms: 0, reports: 0, reportsPerChatRoom: 0, rate: 0,
        byAction: { UNRESOLVED: 0, NONE: 0, WARNING: 0, CHAT_RESTRICT_7D: 0, SUSPEND: 0 },
      },
    });
  });
});

describe('B-08-T02 조회 권한·금액·견적 이력', () => {
  it('지원·계약은 당사자만 읽고 타인에게는 자원을 숨긴다', () => {
    // 실행 및 확인
    assert.doesNotThrow(() => requireApplicationParty(
      { userId: 'client-1', role: 'CLIENT' },
      { clientUserId: 'client-1', supplierUserId: 'supplier-1' },
    ));
    assert.throws(() => requireApplicationParty(
      { userId: 'intruder', role: 'SUPPLIER' },
      { clientUserId: 'client-1', supplierUserId: 'supplier-1' },
    ), isError('APPLICATION_NOT_FOUND'));

    // 준비
    const contract = {
      id: 'contract-1', applicationId: 'app-1', projectId: 'project-1',
      clientUserId: 'client-1', supplierId: 'supplier-1', status: 'PENDING_CONSENT',
      specVersionNo: 1, agreedAmount: 3_100_000, durationDays: 42,
      clientFee: 155_000, supplierFee: 155_000, interimRatio: 50,
      consentDeadline: new Date('2026-11-10T00:00:00.000Z'), contentHash: 'a'.repeat(64),
      clientSignedAt: null, supplierSignedAt: null, depositDeadline: null,
      paymentStatus: 'PENDING', totalDeposited: 0, items: [],
    } satisfies ContractRecord;
    // 실행 및 확인
    assert.throws(() => contractDocumentFor(contract, { userId: 'intruder', role: 'CLIENT' }), isError('CONTRACT_NOT_FOUND'));
    // 실행
    const document = contractDocumentFor(contract, { userId: 'client-1', role: 'CLIENT' });
    // 확인
    assert.deepEqual(
      [document.agreedAmount, document.clientFee, document.supplierFee, document.depositAmount, document.supplierPayout],
      [3_100_000, 155_000, 155_000, 3_255_000, 2_945_000],
    );
  });

  it('비교는 최신 견적 이력과 실제 금액만 제공하고 AI 단가·판정은 만들지 않는다', () => {
    // 준비
    const revisions: ApplicationRevision[] = [
      applicationRevision({ id: 'app-1-r1', revisionNo: 1, status: 'SUPERSEDED', submittedAt: new Date('2026-11-01T00:00:00.000Z'), totalAmount: 2_800_000 }),
      applicationRevision({ id: 'app-1-r2', revisionNo: 2, submittedAt: new Date('2026-11-02T00:00:00.000Z'), totalAmount: 3_100_000, questions: [{ text: '질문 1' }, { text: '질문 2' }] }),
    ];
    // 실행
    const cards = compareApplicationCards(revisions);
    // 확인
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0], {
      applicationId: 'app-1-r2', supplierId: 'supplier-1', revisionNo: 2,
      totalAmount: 3_100_000, clientFee: 155_000, depositAmount: 3_255_000,
      firstRevisionAmount: 2_800_000,
      durationDays: 42, questionCount: 2,
      revisionCount: 2, submittedAt: new Date('2026-11-02T00:00:00.000Z'),
    });
    for (const key of ['unitPrice', 'aiUnitPrice', 'isLowest', 'recommended', 'rank']) {
      assert.equal(key in (cards[0] ?? {}), false);
    }
    assert.deepEqual(revisions.map(({ id, status, totalAmount }) => [id, status, totalAmount]), [
      ['app-1-r1', 'SUPERSEDED', 2_800_000],
      ['app-1-r2', 'SUBMITTED', 3_100_000],
    ]);
    // 준비
    const oldRevision = revisions[0];
    const latestRevision = revisions[1];
    // 확인
    assert.ok(oldRevision);
    assert.ok(latestRevision);
    // 실행 및 확인
    assert.throws(() => assertContractableRevision({ revision: oldRevision, latest: latestRevision }), isError('APPLICATION_REVISION_SUPERSEDED'));
  });
});

describe('B-08-T03 transaction rollback·대화 메시지 불변', () => {
  it('합의 트랜잭션 후반 실패는 상태·계약·알림·이벤트와 기존 대화까지 되돌린다', async () => {
    // 준비
    type State = {
      applicationStatus: 'SUBMITTED' | 'ACCEPTED';
      projectStatus: 'RECRUITING' | 'ACCEPTED';
      contracts: ContractRecord[];
      messages: { readonly applicationId: string; readonly body: string }[];
      notifications: string[];
      events: string[];
    };
    class AtomicFakeUnitOfWork implements ContractUnitOfWork {
      state: State = {
        applicationStatus: 'SUBMITTED', projectStatus: 'RECRUITING', contracts: [],
        messages: [{ applicationId: 'app-1', body: chatMessage().body }], notifications: [], events: [],
      };

      async run<Result>(work: (tx: ContractTx) => Promise<Result>): Promise<Result> {
        const draft: State = structuredClone(this.state);
        const tx: ContractTx = {
          findLatestRevision: async () => applicationRecord({ status: draft.applicationStatus }),
          findProject: async () => ({ id: 'prj-1', status: draft.projectStatus, deadline: null }),
          findContract: async () => null,
          listBreakCandidates: async () => [],
          listProjectApplications: async () => [],
          findAgreementDraft: async () => null,
          saveAgreementDraft: async () => {},
          updateApplicationStatus: async (input) => {
            if (draft.applicationStatus !== input.from[0]) return false;
            draft.applicationStatus = input.to === 'ACCEPTED' ? 'ACCEPTED' : 'SUBMITTED';
            return true;
          },
          updateProjectStatus: async (input) => {
            if (draft.projectStatus !== input.from[0]) return false;
            draft.projectStatus = input.to === 'ACCEPTED' ? 'ACCEPTED' : 'RECRUITING';
            return true;
          },
          createContract: async (input) => {
            const contract: ContractRecord = {
              ...input, id: 'contract-1', status: 'PENDING_CONSENT', clientSignedAt: null,
              supplierSignedAt: null, depositDeadline: null, paymentStatus: 'PENDING', totalDeposited: 0,
            };
            draft.contracts.push(contract);
            return contract;
          },
          applySignature: async () => null,
          cancelContract: async () => false,
          appendSystemMessage: async (input) => { draft.messages.push(input); },
          notify: async (input) => { draft.notifications.push(input.type); },
          logEvent: async (input) => {
            draft.events.push(input.type);
            throw new Error('simulated event persistence failure');
          },
        };
        const result = await work(tx);
        this.state = draft;
        return result;
      }
    }

    const uow = new AtomicFakeUnitOfWork();
    const before = structuredClone(uow.state);
    const agreement: AgreementDraft = {
      items: [{
        blockId: 'block-1', specItemId: 'spec-1', title: '예약 달력', stage: 'FINAL',
        conditions: [{ key: 'scope', text: '예약 시간대', state: 'DECIDED', evidenceMessageIds: ['msg-1', 'msg-2'] }],
      }],
      interimRatio: 50, ratioState: 'UNDECIDED', cachedAt: FIXED_NOW, lastMessageAt: FIXED_NOW,
    };
    // 실행 및 확인
    await assert.rejects(acceptAgreement(uow, {
      actor: { userId: 'client-1', role: 'CLIENT' }, application: applicationRecord(), agreement,
      items: [{ blockId: 'block-1', description: '예약 기능', origin: 'AGREEMENT', sortOrder: 0 }], now: FIXED_NOW,
    }), /simulated event persistence failure/);
    // 확인
    assert.deepEqual(uow.state, before);
    assert.deepEqual(uow.state.messages, [{ applicationId: 'app-1', body: chatMessage().body }]);
  });
});

function contractRecord(overrides: Partial<ContractRecord> = {}): ContractRecord {
  return {
    id: 'contract-1',
    applicationId: 'app-1',
    projectId: 'prj-1',
    clientUserId: 'client-1',
    supplierId: 'supplier-1',
    status: 'PENDING_CONSENT',
    specVersionNo: 1,
    agreedAmount: 3_100_000,
    durationDays: 42,
    clientFee: 155_000,
    supplierFee: 155_000,
    interimRatio: 50,
    consentDeadline: new Date('2026-11-10T14:59:59.999Z'),
    contentHash: 'hash-1',
    clientSignedAt: null,
    supplierSignedAt: null,
    depositDeadline: null,
    paymentStatus: 'PENDING',
    totalDeposited: 0,
    items: [],
    ...overrides,
  };
}

function chatRoom(overrides: Partial<ChatRoomRecord> = {}): ChatRoomRecord {
  return {
    id: 'app-1',
    projectId: 'prj-1',
    clientUserId: 'client-1',
    supplierId: 'supplier-1',
    status: 'SUBMITTED',
    contractStatus: null,
    messages: [],
    projectTitle: '예약 기능',
    clientDisplayName: '김의뢰',
    supplierDisplayName: '박공급',
    ...overrides,
  };
}

function reportRecord(overrides: Partial<ReportRecord> = {}): ReportRecord {
  return {
    id: 'report-1',
    messageId: 'msg-1',
    reporterId: 'client-1',
    targetUserId: 'supplier-1',
    reason: 'CONTACT_OR_OFFSITE',
    detail: null,
    status: 'OPEN',
    action: null,
    actionNote: null,
    resolvedById: null,
    resolvedAt: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('B-08-T04 내 목록·상세 읽기 서비스', () => {
  const CLIENT: Actor = { userId: 'client-1', role: 'CLIENT' };
  const SUPPLIER: Actor = { userId: 'supplier-1', role: 'SUPPLIER' };
  const INTRUDER: Actor = { userId: 'intruder', role: 'CLIENT' };

  it('내 지원 목록은 역할별 본인 것만 최신 제출 순으로, 상세는 당사자만 연다', async () => {
    // 준비
    const older = applicationRecord({
      id: 'app-1',
      submittedAt: new Date('2026-11-02T00:00:00.000Z'),
    });
    const newer = applicationRecord({
      id: 'app-2',
      projectId: 'prj-2',
      submittedAt: new Date('2026-11-03T00:00:00.000Z'),
    });
    const others = applicationRecord({
      id: 'app-3',
      clientUserId: 'client-2',
      supplierId: 'supplier-2',
    });
    const port: ApplicationReadPort = {
      async listForUser() {
        return [older, others, newer];
      },
      async findRevision(applicationId) {
        return applicationId === 'app-1' ? applicationRevision() : null;
      },
    };

    // 실행 및 확인
    assert.deepEqual(
      (await listMyApplications(port, { actor: CLIENT })).map((row) => row.id),
      ['app-2', 'app-1'],
    );
    assert.deepEqual(
      (await listMyApplications(port, { actor: SUPPLIER })).map((row) => row.id),
      ['app-2', 'app-1'],
    );
    assert.deepEqual(
      await listMyApplications(port, { actor: { userId: 'admin-1', role: 'ADMIN' } }),
      [],
    );

    assert.equal(
      (await getApplicationDetail(port, { actor: SUPPLIER, applicationId: 'app-1' })).id,
      'app-1',
    );
    await assert.rejects(
      getApplicationDetail(port, { actor: INTRUDER, applicationId: 'app-1' }),
      (error: unknown) => error instanceof ApplicationAccessError,
    );
    await assert.rejects(
      getApplicationDetail(port, { actor: CLIENT, applicationId: 'missing' }),
      (error: unknown) => error instanceof ApplicationAccessError,
    );
  });

  it('채팅방 목록은 회차를 하나로 합치고 상대 메시지의 안 읽은 수만 센다', async () => {
    // 준비
    const messages: readonly ChatMessage[] = [
      chatMessage({ id: 'm1', senderId: 'client-1' }),
      chatMessage({
        id: 'm2',
        senderId: 'supplier-1',
        createdAt: new Date('2026-11-01T00:01:00.000Z'),
      }),
      chatMessage({
        id: 'm3',
        senderId: 'client-1',
        createdAt: new Date('2026-11-01T00:02:00.000Z'),
      }),
    ];
    const port: ChatRoomListPort = {
      async listRoomsForUser() {
        return [
          chatRoom({ id: 'app-old', messages: messages.slice(0, 2) }),
          chatRoom({ messages }),
          chatRoom({ projectId: 'prj-2', id: 'app-2' }),
          chatRoom({
            projectId: 'prj-3',
            id: 'app-3',
            clientUserId: 'client-2',
            supplierId: 'supplier-2',
            messages: [chatMessage()],
          }),
        ];
      },
    };

    // 실행
    const rooms = await listChatRooms(port, { actor: SUPPLIER });

    // 확인
    assert.deepEqual(
      rooms.map((room) => room.id),
      ['app-1', 'app-2'],
    );
    assert.equal(rooms[0]?.unreadCount, 2);
    assert.equal(rooms[0]?.lastMessage?.id, 'm3');
    assert.equal(rooms[1]?.lastMessage, null);
    assert.equal(rooms[1]?.unreadCount, 0);
    // 실행 및 확인
    assert.deepEqual(
      await listChatRooms(port, { actor: { userId: 'admin-1', role: 'ADMIN' } }),
      [],
    );
  });

  it('내 계약 목록은 당사자 것만, 상세는 비당사자와 없는 계약 모두 404다', async () => {
    // 준비
    const older = contractRecord();
    const newer = contractRecord({
      id: 'contract-2',
      consentDeadline: new Date('2026-11-12T00:00:00.000Z'),
    });
    const others = contractRecord({
      id: 'contract-3',
      clientUserId: 'client-2',
      supplierId: 'supplier-2',
    });
    const port: ContractReadPort = {
      async listForUser() {
        return [older, others, newer];
      },
      async findById(contractId) {
        return [older, newer, others].find((row) => row.id === contractId) ?? null;
      },
    };

    // 실행 및 확인
    assert.deepEqual(
      (await listMyContracts(port, { actor: CLIENT })).map((row) => row.id),
      ['contract-2', 'contract-1'],
    );
    assert.equal(
      (await getContractDetail(port, { actor: SUPPLIER, contractId: 'contract-2' })).id,
      'contract-2',
    );
    await assert.rejects(
      getContractDetail(port, { actor: INTRUDER, contractId: 'contract-2' }),
      isError('CONTRACT_NOT_FOUND'),
    );
    await assert.rejects(
      getContractDetail(port, { actor: CLIENT, contractId: 'missing' }),
      isError('CONTRACT_NOT_FOUND'),
    );
  });

  it('내 신고 목록은 본인 것만 최신 순으로, 상태로 거른다', async () => {
    // 준비
    const older = reportRecord();
    const newer = reportRecord({
      id: 'report-2',
      status: 'RESOLVED',
      action: 'WARNING',
      createdAt: new Date('2026-11-02T00:00:00.000Z'),
    });
    const others = reportRecord({ id: 'report-3', reporterId: 'client-2' });
    const port: MyReportQueryPort = {
      async listByReporter(input) {
        return [older, others, newer].filter(
          (row) =>
            row.reporterId === input.reporterId &&
            (input.status === undefined || row.status === input.status),
        );
      },
    };

    // 실행 및 확인
    assert.deepEqual(
      (await listMyReports(port, { actor: CLIENT })).map((row) => row.id),
      ['report-2', 'report-1'],
    );
    assert.deepEqual(
      (await listMyReports(port, { actor: CLIENT, status: 'RESOLVED' })).map((row) => row.id),
      ['report-2'],
    );
    assert.deepEqual(
      await listMyReports(port, { actor: { userId: 'admin-1', role: 'ADMIN' } }),
      [],
    );
  });
});

describe('B-08 보조: 프로젝트 지원 비교 목록 (#050)', () => {
  const CLIENT_ACTOR: Actor = { userId: 'client-1', role: 'CLIENT' };
  const revisions: ApplicationRevision[] = [
    applicationRevision({
      id: 'app-s1-r1',
      supplierId: 'supplier-1',
      revisionNo: 1,
      status: 'SUPERSEDED',
      submittedAt: new Date('2026-11-01T00:00:00.000Z'),
      totalAmount: 2_800_000,
    }),
    applicationRevision({
      id: 'app-s1-r2',
      supplierId: 'supplier-1',
      revisionNo: 2,
      submittedAt: new Date('2026-11-02T00:00:00.000Z'),
      totalAmount: 3_100_000,
      questions: [{ text: '질문 1' }, { text: '질문 2' }],
    }),
    applicationRevision({
      id: 'app-s2-r1',
      supplierId: 'supplier-2',
      submittedAt: new Date('2026-11-03T00:00:00.000Z'),
      totalAmount: 1_500_000,
    }),
    applicationRevision({
      id: 'app-other-project',
      projectId: 'prj-2',
      supplierId: 'supplier-3',
      submittedAt: new Date('2026-10-31T00:00:00.000Z'),
    }),
  ];

  function port(overrides: Partial<ProjectApplicationsPort> = {}): ProjectApplicationsPort {
    return {
      findProjectClientId: async (projectId) => (projectId === 'prj-1' ? 'client-1' : null),
      listRevisionsByProject: async () => revisions,
      listSupplierProfileSummaries: async () => [],
      ...overrides,
    };
  }

  it('의뢰인 본인에게 공급자별 최신 회차만 지원 순서대로 준다', async () => {
    // 실행
    const cards = await listProjectApplicationCards(port(), {
      actor: CLIENT_ACTOR,
      projectId: 'prj-1',
    });

    // 확인
    assert.deepEqual(
      cards.map((card) => [card.applicationId, card.supplierId, card.revisionCount]),
      [
        ['app-s1-r2', 'supplier-1', 2],
        ['app-s2-r1', 'supplier-2', 1],
      ],
    );
    assert.equal(cards[0]?.questionCount, 2);
    assert.equal(cards[0]?.totalAmount, 3_100_000);
    assert.equal(cards[0]?.submittedAt.toISOString(), '2026-11-02T00:00:00.000Z');
    assert.equal(cards.length, 2);
  });

  it('판정·추천 필드를 만들지 않는다', async () => {
    // 실행
    const [card] = await listProjectApplicationCards(port(), {
      actor: CLIENT_ACTOR,
      projectId: 'prj-1',
    });

    // 확인
    assert.deepEqual(Object.keys(card ?? {}).sort(), [
      'applicationId',
      'careerYears',
      'clientFee',
      'completedContractCount',
      'depositAmount',
      'durationDays',
      'firstRevisionAmount',
      'portfolioSummary',
      'questionCount',
      'ratingAvg',
      'reviewCount',
      'revisionCount',
      'revisionNo',
      'submittedAt',
      'supplierId',
      'supplierName',
      'totalAmount',
    ]);
  });

  it('의뢰인 본인에게 공개 프로필 요약만 비교 카드에 결합한다', async () => {
    // 준비
    const calls: string[][] = [];
    // 실행
    const cards = await listProjectApplicationCards(port({
      listSupplierProfileSummaries: async (supplierIds) => {
        calls.push([...supplierIds]);
        return [{
          supplierId: 'supplier-1',
          displayName: '스튜디오 넛',
          careerYears: 8,
          ratingAvg: 4.8,
          reviewCount: 12,
          completedContractCount: 3,
          portfolioSummary: '공개 포트폴리오',
        }];
      },
    }), { actor: CLIENT_ACTOR, projectId: 'prj-1' });

    // 확인
    assert.deepEqual(calls, [['supplier-1', 'supplier-2']]);
    assert.equal(cards[0]?.careerYears, 8);
    assert.equal(cards[0]?.portfolioSummary, '공개 포트폴리오');
    assert.equal(Object.keys(cards[0] ?? {}).includes('email'), false);
  });

  it('비당사자에게 프로필 요약 조회도 하지 않는다', async () => {
    // 준비
    let profileCalls = 0;
    // 실행 및 확인
    await assert.rejects(listProjectApplicationCards(port({
      listSupplierProfileSummaries: async () => { profileCalls += 1; return []; },
    }), { actor: { userId: 'intruder', role: 'CLIENT' }, projectId: 'prj-1' }));
    // 확인
    assert.equal(profileCalls, 0);
  });

  it('다른 의뢰인·공급자·없는 프로젝트는 404로 숨긴다', async () => {
    // 실행 및 확인
    for (const [actor, target] of [
      [{ userId: 'client-2', role: 'CLIENT' }, port()],
      [{ userId: 'supplier-1', role: 'SUPPLIER' }, port()],
      [CLIENT_ACTOR, port({ findProjectClientId: async () => null })],
    ] as const) {
      await assert.rejects(
        listProjectApplicationCards(target, { actor, projectId: 'prj-1' }),
        (error: unknown) => error instanceof ApplicationAccessError,
      );
    }
  });
});
