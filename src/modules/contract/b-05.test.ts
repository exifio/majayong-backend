import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgreementCondition, AgreementDraft, AgreementSpec } from '../agreement/draft.ts';
import type { ApplicationRecord, ApplicationStatus } from '../application/dto.ts';
import {
  createContractNotificationPort,
  ContractError,
  assertScopeMutable,
  breakContract,
  breakExpiredContracts,
  calculateContractFees,
  consentDeadlineFrom,
  contractDocumentFor,
  depositDeadlineFrom,
  endOfKstDayAfter,
  prepareProvisionalContract,
  signContract,
  acceptAgreement,
  type ContractActor,
  type ContractBreakReason,
  type ContractItemSource,
  type ContractProjectState,
  type ContractRecord,
  type ContractTx,
  type ContractUnitOfWork,
  type NewContractRecord,
} from './lifecycle.ts';
import {
  createNotificationOnceInTransaction,
  type NewNotification,
  type NotificationRecord,
  type NotificationType,
  type NotificationTx,
} from '../notification/notifications.ts';
import type { ProjectStatus } from '../market/public-project.ts';
import { FIXED_NOW, applicationRecord } from '../../../tests/b/fixtures.ts';

const CLIENT: ContractActor = { userId: 'client-1', role: 'CLIENT' };
const SUPPLIER: ContractActor = { userId: 'supplier-1', role: 'SUPPLIER' };
const INTRUDER: ContractActor = { userId: 'supplier-2', role: 'SUPPLIER' };

function isContractError(status: number, code: string) {
  return (error: unknown): boolean =>
    error instanceof ContractError && error.status === status && error.code === code;
}

function conditions(): readonly AgreementCondition[] {
  return [
    {
      key: 'scope',
      text: '예약 가능 시간대',
      state: 'DECIDED',
      evidenceMessageIds: ['m1', 'm2'],
    },
    {
      key: 'warranty',
      text: '버그 수정 기간',
      state: 'UNDECIDED',
      evidenceMessageIds: [],
    },
  ];
}

function agreementDraft(overrides: Partial<AgreementDraft> = {}): AgreementDraft {
  return {
    items: [
      {
        blockId: 'block-1',
        specItemId: 'spec-1',
        title: '예약 달력',
        stage: 'FINAL',
        conditions: conditions(),
      },
      {
        blockId: 'block-2',
        specItemId: 'spec-2',
        title: '예약금 결제',
        stage: 'INTERIM',
        conditions: [
          {
            key: 'milestone',
            text: '중간 지급 시점',
            state: 'PROPOSED',
            evidenceMessageIds: ['m3'],
          },
        ],
      },
    ],
    interimRatio: 60,
    ratioState: 'DECIDED',
    cachedAt: FIXED_NOW,
    lastMessageAt: FIXED_NOW,
    ...overrides,
  };
}

function spec(): AgreementSpec {
  return {
    items: [
      { blockId: 'block-1', specItemId: 'spec-1', title: '예약 달력', stage: 'FINAL', conditions: [{ key: 'scope', text: '예약 시간대' }] },
      { blockId: 'block-2', specItemId: 'spec-2', title: '예약금 결제', stage: 'INTERIM', conditions: [{ key: 'milestone', text: '중간 지급 시점' }] },
    ],
    defaultInterimRatio: 50,
  };
}

function sources(): readonly ContractItemSource[] {
  return [
    {
      blockId: 'block-2',
      description: '예약금을 받고 예약을 확정한다.',
      origin: 'CHAT',
      sortOrder: 1,
    },
    {
      blockId: 'block-1',
      description: '예약 달력과 시간대 설정.',
      origin: 'FIRST_SENTENCE',
      sortOrder: 0,
    },
  ];
}

interface FakeProject extends ContractProjectState {
  status: ProjectStatus;
  selectionEndsAt: Date | null;
}

interface NotificationRow {
  readonly userId: string;
  readonly type: 'APPLICATION_ACCEPTED' | 'CONTRACT_BROKEN';
  readonly targetId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface EventRow {
  readonly userId: string;
  readonly type: 'APPLICATION_ACCEPTED' | 'CONTRACT_SIGNED' | 'CONTRACT_AGREED' | 'CONTRACT_BROKEN';
  readonly payload: Readonly<Record<string, unknown>>;
}

class FakeNotificationTx implements NotificationTx {
  readonly rows: { readonly id: string; readonly userId: string; readonly type: NotificationType; readonly targetId: string }[] = [];
  failCreate: Error | null = null;
  async findByKey(input: { readonly userId: string; readonly type: NotificationType; readonly targetId: string }): Promise<NotificationRecord | null> {
    const row = this.rows.find((candidate) =>
      candidate.userId === input.userId && candidate.type === input.type && candidate.targetId === input.targetId,
    );
    return row === undefined ? null : {
      id: row.id,
      userId: row.userId,
      type: row.type,
      targetUrl: `/contracts/${input.targetId}/sign`,
      targetId: input.targetId,
      payload: null,
      isRead: false,
      createdAt: FIXED_NOW,
    };
  }
  async create(input: NewNotification): Promise<NotificationRecord> {
    if (this.failCreate !== null) throw this.failCreate;
    const id = `notification-${this.rows.length + 1}`;
    this.rows.push({ id, userId: input.userId, type: input.type, targetId: input.targetId });
    return { id, ...input, isRead: false };
  }
  async refreshBundled(): Promise<NotificationRecord> { throw new Error('not a chat notification'); }
  async listRecent() { return []; }
  async countUnread() { return 0; }
  async markRead() { return false; }
  async markAllRead() { return 0; }
}

class FakeContractTx implements ContractTx {
  applications: ApplicationRecord[];
  projects: FakeProject[];
  contracts: ContractRecord[] = [];
  systemMessages: { applicationId: string; body: string }[] = [];
  notifications: NotificationRow[] = [];
  events: EventRow[] = [];
  lastCancelReason: ContractBreakReason | null = null;
  readonly agreementDrafts = new Map<string, AgreementDraft>();
  readonly notificationTx = new FakeNotificationTx();
  readonly notificationPort = createContractNotificationPort(this.notificationTx);
  failNotificationInsert = false;

  constructor(input: {
    readonly applications: readonly ApplicationRecord[];
    readonly projects: readonly {
      id: string;
      status: ProjectStatus;
      deadline: Date | null;
      selectionEndsAt?: Date | null;
    }[];
    readonly contracts?: readonly ContractRecord[];
  }) {
    this.applications = [...input.applications];
    this.projects = input.projects.map((project) => ({
      ...project,
      selectionEndsAt: project.selectionEndsAt === undefined ? null : project.selectionEndsAt,
    }));
    this.contracts = [...(input.contracts ?? [])];
  }

  async findLatestRevision(input: {
    readonly projectId: string;
    readonly supplierId: string;
  }): Promise<ApplicationRecord | null> {
    let latest: ApplicationRecord | null = null;
    for (const application of this.applications) {
      if (
        application.projectId !== input.projectId ||
        application.supplierId !== input.supplierId
      ) {
        continue;
      }
      if (latest === null || application.revisionNo > latest.revisionNo) {
        latest = application;
      }
    }
    return latest;
  }

  async findProject(projectId: string): Promise<ContractProjectState | null> {
    const project = this.projects.find((candidate) => candidate.id === projectId);
    return project === undefined ? null : project;
  }

  async findContract(contractId: string): Promise<ContractRecord | null> {
    return this.contracts.find((contract) => contract.id === contractId) ?? null;
  }

  async listBreakCandidates(now: Date): Promise<readonly ContractRecord[]> {
    return this.contracts.filter((contract) => {
      if (contract.status === 'PENDING_CONSENT') {
        return contract.consentDeadline.getTime() <= now.getTime();
      }
      if (contract.status === 'ACTIVE' && contract.depositDeadline !== null) {
        return (
          contract.depositDeadline.getTime() <= now.getTime() &&
          contract.paymentStatus === 'PENDING' &&
          contract.totalDeposited === 0
        );
      }
      return false;
    });
  }

  async listProjectApplications(projectId: string): Promise<readonly ApplicationRecord[]> {
    return this.applications.filter((application) => application.projectId === projectId);
  }

  async findAgreementDraft(applicationId: string): Promise<AgreementDraft | null> {
    return this.agreementDrafts.get(applicationId) ?? null;
  }

  async saveAgreementDraft(applicationId: string, draft: AgreementDraft): Promise<void> {
    this.agreementDrafts.set(applicationId, draft);
  }

  async updateApplicationStatus(input: {
    readonly applicationId: string;
    readonly from: readonly ApplicationStatus[];
    readonly to: ApplicationStatus;
  }): Promise<boolean> {
    const index = this.applications.findIndex(
      (application) =>
        application.id === input.applicationId && input.from.includes(application.status),
    );
    const current = this.applications[index];
    if (index < 0 || current === undefined) return false;
    this.applications[index] = { ...current, status: input.to };
    return true;
  }

  async updateProjectStatus(input: {
    readonly projectId: string;
    readonly from: readonly ProjectStatus[];
    readonly to: ProjectStatus;
    readonly selectionEndsAt: Date | null;
  }): Promise<boolean> {
    const index = this.projects.findIndex(
      (project) => project.id === input.projectId && input.from.includes(project.status),
    );
    const current = this.projects[index];
    if (index < 0 || current === undefined) return false;
    this.projects[index] = {
      ...current,
      status: input.to,
      selectionEndsAt: input.selectionEndsAt,
    };
    return true;
  }

  async createContract(input: NewContractRecord): Promise<ContractRecord> {
    const created: ContractRecord = {
      ...input,
      id: `contract-${this.contracts.length + 1}`,
      status: 'PENDING_CONSENT',
      clientSignedAt: null,
      supplierSignedAt: null,
      depositDeadline: null,
      paymentStatus: 'PENDING',
      totalDeposited: 0,
    };
    this.contracts.push(created);
    return created;
  }

  async applySignature(input: {
    readonly contractId: string;
    readonly party: 'CLIENT' | 'SUPPLIER';
    readonly signedAt: Date;
    readonly activate: boolean;
    readonly depositDeadline: Date | null;
  }): Promise<ContractRecord | null> {
    const index = this.contracts.findIndex((contract) => contract.id === input.contractId);
    const current = this.contracts[index];
    if (index < 0 || current === undefined) return null;
    if (current.status !== 'PENDING_CONSENT') return null;
    if (input.signedAt.getTime() >= current.consentDeadline.getTime()) return null;

    const alreadySigned =
      input.party === 'CLIENT'
        ? current.clientSignedAt !== null
        : current.supplierSignedAt !== null;
    if (alreadySigned) return null;

    const updated: ContractRecord = {
      ...current,
      status: input.activate ? 'ACTIVE' : 'PENDING_CONSENT',
      clientSignedAt: input.party === 'CLIENT' ? input.signedAt : current.clientSignedAt,
      supplierSignedAt: input.party === 'SUPPLIER' ? input.signedAt : current.supplierSignedAt,
      depositDeadline: input.activate ? input.depositDeadline : current.depositDeadline,
    };
    this.contracts[index] = updated;
    return updated;
  }

  async cancelContract(input: {
    readonly contractId: string;
    readonly reason: ContractBreakReason;
  }): Promise<boolean> {
    const index = this.contracts.findIndex((contract) => contract.id === input.contractId);
    const current = this.contracts[index];
    if (index < 0 || current === undefined) return false;
    if (current.status !== 'PENDING_CONSENT' && current.status !== 'ACTIVE') return false;

    this.contracts[index] = { ...current, status: 'CANCELLED' };
    this.lastCancelReason = input.reason;
    return true;
  }

  async appendSystemMessage(input: {
    readonly applicationId: string;
    readonly body: string;
  }): Promise<void> {
    this.systemMessages.push({ applicationId: input.applicationId, body: input.body });
  }

  async notify(input: {
    readonly userId: string;
    readonly type: 'APPLICATION_ACCEPTED' | 'CONTRACT_BROKEN';
    readonly targetId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly now: Date;
  }): Promise<void> {
    if (this.failNotificationInsert) this.notificationTx.failCreate = new Error('simulated notification insert failure');
    await this.notificationPort.notify(input);
    this.notifications.push(input);
  }

  async logEvent(input: {
    readonly userId: string;
    readonly type: 'APPLICATION_ACCEPTED' | 'CONTRACT_SIGNED' | 'CONTRACT_AGREED' | 'CONTRACT_BROKEN';
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    this.events.push(input);
  }
}

class FakeUnitOfWork implements ContractUnitOfWork {
  readonly tx: FakeContractTx;

  constructor(tx: FakeContractTx) {
    this.tx = tx;
  }

  async run<T>(work: (tx: ContractTx) => Promise<T>): Promise<T> {
    const before = {
      applications: structuredClone(this.tx.applications),
      projects: structuredClone(this.tx.projects),
      contracts: structuredClone(this.tx.contracts),
      systemMessages: structuredClone(this.tx.systemMessages),
      notifications: structuredClone(this.tx.notifications),
      notificationRows: structuredClone(this.tx.notificationTx.rows),
      events: structuredClone(this.tx.events),
      lastCancelReason: this.tx.lastCancelReason,
    };
    try {
      return await work(this.tx);
    } catch (error) {
      this.tx.applications = before.applications;
      this.tx.projects = before.projects;
      this.tx.contracts = before.contracts;
      this.tx.systemMessages = before.systemMessages;
      this.tx.notifications = before.notifications;
      this.tx.notificationTx.rows.splice(0, this.tx.notificationTx.rows.length, ...before.notificationRows);
      this.tx.events = before.events;
      this.tx.lastCancelReason = before.lastCancelReason;
      throw error;
    }
  }
}

function setup(
  applications: readonly ApplicationRecord[] = [applicationRecord()],
  projectOverrides: Partial<FakeProject> = {},
): { tx: FakeContractTx; uow: FakeUnitOfWork } {
  const tx = new FakeContractTx({
    applications,
    projects: [
      {
        id: 'prj-1',
        status: 'RECRUITING',
        deadline: new Date('2026-11-20T14:59:59.000Z'),
        ...projectOverrides,
      },
    ],
  });
  return { tx, uow: new FakeUnitOfWork(tx) };
}

async function accept(
  tx: FakeContractTx,
  uow: FakeUnitOfWork,
  overrides: {
    readonly application?: ApplicationRecord;
    readonly agreement?: AgreementDraft | null;
    readonly now?: Date;
  } = {},
): Promise<ContractRecord> {
  const application = overrides.application ?? applicationRecord();
  const result = await acceptAgreement(uow, {
    actor: CLIENT,
    application,
    agreement: overrides.agreement === undefined ? agreementDraft() : overrides.agreement,
    items: sources(),
    now: overrides.now ?? FIXED_NOW,
  });
  assert.ok(result.contract.id.length > 0);
  return result.contract;
}

async function signBoth(
  uow: FakeUnitOfWork,
  contract: ContractRecord,
  firstAt = new Date('2026-11-03T01:00:00.000Z'),
  secondAt = new Date('2026-11-03T02:00:00.000Z'),
): Promise<ContractRecord> {
  await signContract(uow, {
    contractId: contract.id,
    actor: SUPPLIER,
    expectedContentHash: contract.contentHash,
    now: firstAt,
  });
  const result = await signContract(uow, {
    contractId: contract.id,
    actor: CLIENT,
    expectedContentHash: contract.contentHash,
    now: secondAt,
  });
  return result.contract;
}

describe('B-05-T01 동시 2명 합의 → 1명만', () => {
  it('프로젝트당 한 지원만 ACCEPTED가 되고 두 번째는 거부된다', async () => {
    // 준비
    const { tx, uow } = setup([
      applicationRecord(),
      applicationRecord({ id: 'app-2', supplierId: 'supplier-2', revisionNo: 1 }),
    ]);

    // 실행
    const contract = await accept(tx, uow);
    const result = await accept(tx, uow, {
      application: applicationRecord({ id: 'app-2', supplierId: 'supplier-2' }),
    }).catch((error: unknown) => error);

    // 확인
    assert.ok(result instanceof ContractError);
    assert.equal(result.status, 409);
    assert.equal(result.code, 'PROJECT_ALREADY_CONTRACTED');

    assert.equal(tx.contracts.length, 1);
    assert.equal(tx.projects[0]?.status, 'ACCEPTED');
    assert.equal(
      tx.applications.find((application) => application.id === 'app-1')?.status,
      'ACCEPTED',
    );
    assert.equal(
      tx.applications.find((application) => application.id === 'app-2')?.status,
      'SUBMITTED',
    );
    assert.equal(contract.status, 'PENDING_CONSENT');
  });

  it('동시 서명은 한 번만 계약을 활성화한다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);
    await signContract(uow, {
      contractId: contract.id, actor: SUPPLIER,
      expectedContentHash: contract.contentHash, now: FIXED_NOW,
    });

    // 준비
    let serialize: Promise<void> = Promise.resolve();
    const serialUow: ContractUnitOfWork = {
      async run<T>(work: (tx: ContractTx) => Promise<T>): Promise<T> {
        const previous = serialize;
        let unlock!: () => void;
        serialize = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        try {
          return await work(tx);
        } finally {
          unlock();
        }
      },
    };
    // 실행
    const outcomes = await Promise.allSettled([
      signContract(serialUow, {
        contractId: contract.id, actor: CLIENT,
        expectedContentHash: contract.contentHash, now: FIXED_NOW,
      }),
      signContract(serialUow, {
        contractId: contract.id, actor: CLIENT,
        expectedContentHash: contract.contentHash, now: FIXED_NOW,
      }),
    ]);

    // 확인
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(tx.contracts[0]?.status, 'ACTIVE');
    assert.equal(tx.projects[0]?.status, 'CONTRACTED');
  });

  it('합의 완료는 계약·수수료·기한·항목을 한 번에 만든다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);

    // 확인
    assert.equal(contract.agreedAmount, 3_100_000);
    assert.equal(contract.clientFee, 155_000);
    assert.equal(contract.supplierFee, 155_000);
    assert.equal(contract.durationDays, 42);
    assert.equal(contract.interimRatio, 60);
    assert.equal(
      contract.consentDeadline.toISOString(),
      consentDeadlineFrom(FIXED_NOW).toISOString(),
    );
    assert.equal(contract.contentHash.length, 64);

    assert.deepEqual(
      contract.items.map((item) => [item.blockId, item.stage, item.sortOrder]),
      [
        ['block-1', 'FINAL', 0],
        ['block-2', 'INTERIM', 1],
      ],
    );
    assert.deepEqual(contract.items[0]?.conditions, conditions());

    assert.equal(tx.systemMessages.length, 1);
    assert.deepEqual(
      tx.notifications.map((notification) => [
        notification.userId,
        notification.type,
        notification.targetId,
      ]),
      [['supplier-1', 'APPLICATION_ACCEPTED', contract.id]],
    );
    assert.equal(tx.events[0]?.type, 'APPLICATION_ACCEPTED');
    assert.deepEqual(tx.events[0]?.payload, {
      applicationId: 'app-1',
      contractId: contract.id,
      conditionCount: 3,
      decidedCount: 1,
    });
  });

  it('의뢰인만 합의를 완료할 수 있다', async () => {
    // 준비
    const { tx, uow } = setup();

    // 실행 및 확인
    await assert.rejects(
      acceptAgreement(uow, {
        actor: SUPPLIER,
        application: applicationRecord(),
        agreement: agreementDraft(),
        items: sources(),
        now: FIXED_NOW,
      }),
      isContractError(403, 'CLIENT_ONLY'),
    );
    // 확인
    assert.equal(tx.contracts.length, 0);
    assert.equal(tx.projects[0]?.status, 'RECRUITING');
  });

  it('수수료는 5%씩 반올림하고 금액이 0 이하면 거부한다', () => {
    // 확인
    assert.deepEqual(calculateContractFees(3_100_000), {
      clientFee: 155_000,
      supplierFee: 155_000,
    });
    assert.deepEqual(calculateContractFees(100_001), {
      clientFee: 5_000,
      supplierFee: 5_000,
    });
    // 실행 및 확인
    assert.throws(
      () => calculateContractFees(0),
      isContractError(400, 'INVALID_AMOUNT'),
    );
  });
});

describe('B-05-T09 계약 알림 브리지', () => {
  it('합의 완료 알림을 B-06 멱등 함수에 연결하고 동일 키는 중복 생성하지 않는다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);

    // 확인
    assert.equal(tx.notifications.length, 1);
    assert.equal(tx.notifications[0]?.type, 'APPLICATION_ACCEPTED');
    assert.equal(tx.notifications[0]?.targetId, contract.id);
    assert.equal(tx.notificationTx.rows.length, 1);

    // 실행
    await createNotificationOnceInTransaction(tx.notificationTx, {
      userId: SUPPLIER.userId,
      type: 'APPLICATION_ACCEPTED',
      targetId: contract.id,
      payload: { applicationId: 'app-1' },
      now: FIXED_NOW,
    });
    // 확인
    assert.equal(tx.notificationTx.rows.length, 1);
  });

  it('알림 저장 실패는 합의·계약 쓰기를 실패시킨다(실제 DB 롤백은 PG 통합)', async () => {
    // 준비
    const { tx, uow } = setup();
    tx.failNotificationInsert = true;

    // 실행 및 확인
    await assert.rejects(accept(tx, uow), /simulated notification insert failure/);
    // 확인
    assert.equal(tx.contracts.length, 0);
    assert.equal(tx.projects[0]?.status, 'RECRUITING');
    assert.equal(tx.applications[0]?.status, 'SUBMITTED');
    assert.equal(tx.notificationTx.rows.length, 0);
  });
});

describe('B-05-T02 견적 변경·합의 경합', () => {
  it('미리 본 회차가 최신이 아니면 합의를 거부한다', async () => {
    // 준비
    const preview = applicationRecord();
    const revised = applicationRecord({
      id: 'app-2',
      revisionNo: 2,
      status: 'SUBMITTED',
      totalAmount: 3_200_000,
    });
    const { tx, uow } = setup([
      { ...preview, status: 'SUPERSEDED' },
      revised,
    ]);

    // 실행 및 확인
    await assert.rejects(
      acceptAgreement(uow, {
        actor: CLIENT,
        application: preview,
        agreement: agreementDraft(),
        items: sources(),
        now: FIXED_NOW,
      }),
      isContractError(409, 'APPLICATION_REVISION_SUPERSEDED'),
    );

    // 확인
    assert.equal(tx.contracts.length, 0);
    assert.equal(tx.projects[0]?.status, 'RECRUITING');
  });

  it('최신 회차라도 STALE이면 계약할 수 없다', async () => {
    // 준비
    const stale = applicationRecord({ status: 'STALE' });
    const { tx, uow } = setup([applicationRecord({ status: 'SUPERSEDED' }), stale]);

    // 실행 및 확인
    await assert.rejects(
      acceptAgreement(uow, {
        actor: CLIENT,
        application: stale,
        agreement: agreementDraft(),
        items: sources(),
        now: FIXED_NOW,
      }),
      isContractError(409, 'APPLICATION_NOT_SUBMITTED'),
    );
    // 확인
    assert.equal(tx.contracts.length, 0);
  });

  it('계약 항목에 없는 블록은 거부한다', async () => {
    // 준비
    const { tx, uow } = setup();
    const unknownBlock = agreementDraft({
      items: [
        {
          blockId: 'block-ghost',
          specItemId: null,
          title: '없는 기능',
          stage: 'FINAL',
          conditions: [],
        },
      ],
    });

    // 실행 및 확인
    await assert.rejects(
      acceptAgreement(uow, {
        actor: CLIENT,
        application: applicationRecord(),
        agreement: unknownBlock,
        items: sources(),
        now: FIXED_NOW,
      }),
      isContractError(409, 'UNKNOWN_CONTRACT_BLOCK'),
    );
    // 확인
    assert.equal(tx.contracts.length, 0);
  });
});

describe('B-05-T03 미정 조건 계약 허용', () => {
  it('UNDECIDED 조건이 있어도 계약하고 그대로 계약서에 남긴다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow, {
      agreement: agreementDraft({ ratioState: 'UNDECIDED', interimRatio: 60 }),
    });

    // 확인
    assert.equal(contract.interimRatio, 50);
    // 준비
    const warranty = contract.items[0]?.conditions.find(
      (condition) => condition.key === 'warranty',
    );
    // 확인
    assert.ok(warranty);
    assert.equal(warranty.state, 'UNDECIDED');
    assert.deepEqual(warranty.evidenceMessageIds, []);
    assert.equal(
      contract.items[1]?.conditions[0]?.state,
      'PROPOSED',
    );
  });

  it('비율이 DECIDED여도 10~90을 벗어나면 거부한다', async () => {
    // 준비
    const { tx, uow } = setup();

    // 실행 및 확인
    await assert.rejects(
      acceptAgreement(uow, {
        actor: CLIENT,
        application: applicationRecord(),
        agreement: agreementDraft({ ratioState: 'DECIDED', interimRatio: 95 }),
        items: sources(),
        now: FIXED_NOW,
      }),
      isContractError(400, 'INVALID_INTERIM_RATIO'),
    );
    // 확인
    assert.equal(tx.contracts.length, 0);
    assert.equal(tx.projects[0]?.status, 'RECRUITING');
  });

  it('합의 내용이 없으면 계약하지 않는다', () => {
    // 실행 및 확인
    assert.throws(
      () =>
        prepareProvisionalContract({
          application: applicationRecord(),
          agreement: null,
          items: sources(),
          now: FIXED_NOW,
        }),
      isContractError(409, 'AGREEMENT_REQUIRED'),
    );
  });
});

describe('B-05-T04 두 번째 서명과 7일 기한 경쟁', () => {
  it('한쪽 서명 뒤 다른 쪽 서명으로 체결되고 예치 기한이 KST 3일 23:59다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);

    const first = await signContract(uow, {
      contractId: contract.id,
      actor: SUPPLIER,
      expectedContentHash: contract.contentHash,
      now: new Date('2026-11-03T01:00:00.000Z'),
    });
    // 확인
    assert.equal(first.activated, false);
    assert.equal(first.contract.status, 'PENDING_CONSENT');
    assert.equal(first.contract.supplierSignedAt?.toISOString(), '2026-11-03T01:00:00.000Z');
    assert.equal(tx.projects[0]?.status, 'ACCEPTED');
    assert.equal(tx.events.at(-1)?.type, 'CONTRACT_SIGNED');

    // 실행
    const second = await signContract(uow, {
      contractId: contract.id,
      actor: CLIENT,
      expectedContentHash: contract.contentHash,
      now: new Date('2026-11-03T02:00:00.000Z'),
    });

    // 확인
    assert.equal(second.activated, true);
    assert.equal(second.contract.status, 'ACTIVE');
    assert.equal(
      second.contract.depositDeadline?.toISOString(),
      '2026-11-06T14:59:59.999Z',
    );
    assert.equal(
      second.contract.depositDeadline?.toISOString(),
      endOfKstDayAfter(new Date('2026-11-03T02:00:00.000Z'), 3).toISOString(),
    );
    assert.equal(tx.projects[0]?.status, 'CONTRACTED');
    assert.equal(
      tx.events.filter((event) => event.type === 'CONTRACT_AGREED').length,
      2,
    );
  });

  it('같은 사람이 두 번 서명하거나 이미 체결된 계약에 서명할 수 없다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);
    await signContract(uow, {
      contractId: contract.id,
      actor: SUPPLIER,
      expectedContentHash: contract.contentHash,
      now: new Date('2026-11-03T01:00:00.000Z'),
    });

    // 실행 및 확인
    await assert.rejects(
      signContract(uow, {
        contractId: contract.id,
        actor: SUPPLIER,
        expectedContentHash: contract.contentHash,
        now: new Date('2026-11-03T01:10:00.000Z'),
      }),
      isContractError(409, 'ALREADY_SIGNED'),
    );

    // 실행
    const active = await signContract(uow, {
      contractId: contract.id,
      actor: CLIENT,
      expectedContentHash: contract.contentHash,
      now: new Date('2026-11-03T02:00:00.000Z'),
    });
    // 확인
    assert.equal(active.contract.status, 'ACTIVE');

    // 실행 및 확인
    await assert.rejects(
      signContract(uow, {
        contractId: contract.id,
        actor: CLIENT,
        expectedContentHash: contract.contentHash,
        now: new Date('2026-11-03T02:10:00.000Z'),
      }),
      isContractError(409, 'CONTRACT_NOT_SIGNABLE'),
    );
  });

  it('해시가 다르면 서명을 거부한다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);

    // 실행 및 확인
    await assert.rejects(
      signContract(uow, {
        contractId: contract.id,
        actor: CLIENT,
        expectedContentHash: '0'.repeat(64),
        now: new Date('2026-11-03T01:00:00.000Z'),
      }),
      isContractError(409, 'CONTRACT_HASH_MISMATCH'),
    );
    // 확인
    assert.equal(tx.contracts[0]?.status, 'PENDING_CONSENT');
  });

  it('서명 기한과 같은 시각·이후에는 서명할 수 없다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);
    // 준비
    const deadline = contract.consentDeadline;

    // 실행
    const justBefore = await signContract(uow, {
      contractId: contract.id,
      actor: CLIENT,
      expectedContentHash: contract.contentHash,
      now: new Date(deadline.getTime() - 1),
    });
    // 확인
    assert.equal(justBefore.contract.clientSignedAt?.getTime(), deadline.getTime() - 1);

    // 실행 및 확인
    await assert.rejects(
      signContract(uow, {
        contractId: contract.id,
        actor: CLIENT,
        expectedContentHash: contract.contentHash,
        now: deadline,
      }),
      isContractError(409, 'CONSENT_EXPIRED'),
    );
  });

  it('서명 기한이 지난 계약은 배치가 결렬시키고 이후 서명은 거부된다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);

    const broken = await breakExpiredContracts(uow, {
      now: new Date(contract.consentDeadline.getTime()),
    });
    // 확인
    assert.equal(broken, 1);
    assert.equal(tx.contracts[0]?.status, 'CANCELLED');
    assert.equal(tx.applications[0]?.status, 'REJECTED');
    assert.equal(tx.projects[0]?.status, 'RECRUITING');
    assert.deepEqual(
      tx.notifications
        .filter((notification) => notification.type === 'CONTRACT_BROKEN')
        .map((notification) => notification.payload),
      [{ reason: 'CONSENT_TIMEOUT' }, { reason: 'CONSENT_TIMEOUT' }],
    );

    // 실행 및 확인
    await assert.rejects(
      signContract(uow, {
        contractId: contract.id,
        actor: CLIENT,
        expectedContentHash: contract.contentHash,
        now: new Date(contract.consentDeadline.getTime()),
      }),
      isContractError(409, 'CONTRACT_NOT_SIGNABLE'),
    );
  });

  it('서명과 배치가 경합하면 먼저 성공한 쪽만 유효하다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);
    await signContract(uow, {
      contractId: contract.id,
      actor: SUPPLIER,
      expectedContentHash: contract.contentHash,
      now: new Date(contract.consentDeadline.getTime() - 60 * 60 * 1000),
    });

    // 준비
    const almostLate = new Date(contract.consentDeadline.getTime() - 1);
    // 실행
    const signed = await signContract(uow, {
      contractId: contract.id,
      actor: CLIENT,
      expectedContentHash: contract.contentHash,
      now: almostLate,
    });
    // 확인
    assert.equal(signed.contract.status, 'ACTIVE');

    // 실행
    const broken = await breakExpiredContracts(uow, {
      now: new Date(contract.consentDeadline.getTime()),
    });
    // 확인
    assert.equal(broken, 0);
    assert.equal(tx.contracts[0]?.status, 'ACTIVE');
  });
});

describe('B-05-T05 서명 후 보류 유지', () => {
  it('계약 체결 뒤에도 다른 지원은 거절하지 않고 보류로 남는다', async () => {
    // 준비
    const { tx, uow } = setup([
      applicationRecord(),
      applicationRecord({ id: 'app-2', supplierId: 'supplier-2' }),
    ]);
    // 실행
    const contract = await accept(tx, uow);
    const active = await signBoth(uow, contract);

    // 확인
    assert.equal(active.status, 'ACTIVE');
    assert.equal(tx.projects[0]?.status, 'CONTRACTED');
    assert.equal(
      tx.applications.find((application) => application.id === 'app-2')?.status,
      'SUBMITTED',
    );
    assert.equal(
      tx.applications.find((application) => application.id === 'app-1')?.status,
      'ACCEPTED',
    );
    assert.equal(
      tx.notifications.filter(
        (notification) => notification.type === 'APPLICATION_ACCEPTED',
      ).length,
      1,
    );
  });
});

describe('B-05-T06 결렬 4종과 재선택 기간', () => {
  const afterDeadline = new Date('2026-11-22T00:00:00.000Z');
  const beforeDeadline = new Date('2026-11-05T00:00:00.000Z');

  it('공급자 서명 거절은 즉시 결렬되고 마감 후 대기 지원이 있으면 SELECTING +7일이다', async () => {
    // 준비
    const { tx, uow } = setup([
      applicationRecord(),
      applicationRecord({ id: 'app-2', supplierId: 'supplier-2' }),
    ]);
    // 실행
    const contract = await accept(tx, uow);

    const result = await breakContract(uow, {
      contractId: contract.id,
      reason: 'SIGN_REFUSED',
      actor: SUPPLIER,
      now: afterDeadline,
    });

    // 확인
    assert.equal(result.broken, true);
    assert.equal(result.projectStatus, 'SELECTING');
    assert.equal(tx.projects[0]?.status, 'SELECTING');
    assert.equal(
      tx.projects[0]?.selectionEndsAt?.toISOString(),
      new Date(afterDeadline.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
    assert.equal(tx.contracts[0]?.status, 'CANCELLED');
    assert.equal(tx.lastCancelReason, 'SIGN_REFUSED');
    assert.equal(tx.applications[0]?.status, 'REJECTED');
    assert.deepEqual(
      tx.notifications
        .filter((notification) => notification.type === 'CONTRACT_BROKEN')
        .map((notification) => [
          notification.userId,
          notification.type,
          notification.payload,
        ]),
      [
        ['client-1', 'CONTRACT_BROKEN', { reason: 'SIGN_REFUSED' }],
        ['supplier-1', 'CONTRACT_BROKEN', { reason: 'SIGN_REFUSED' }],
      ],
    );
  });

  it('의뢰인 임시 계약 취소는 마감 후 대기 지원이 없으면 EXPIRED다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);

    const result = await breakContract(uow, {
      contractId: contract.id,
      reason: 'CLIENT_CANCELLED',
      actor: CLIENT,
      now: afterDeadline,
    });

    // 확인
    assert.equal(result.projectStatus, 'EXPIRED');
    assert.equal(tx.projects[0]?.status, 'EXPIRED');
    assert.equal(tx.projects[0]?.selectionEndsAt, null);
  });

  it('서명 기한 경과는 마감 전이면 RECRUITING으로 돌아간다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);

    const broken = await breakExpiredContracts(uow, {
      now: new Date(contract.consentDeadline.getTime() + 1),
    });

    // 확인
    assert.equal(broken, 1);
    assert.equal(tx.projects[0]?.status, 'RECRUITING');
    assert.equal(tx.lastCancelReason, 'CONSENT_TIMEOUT');
  });

  it('예치 기한 경과는 DEPOSIT_TIMEOUT으로 결렬한다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);
    const active = await signBoth(uow, contract);
    // 확인
    assert.equal(active.depositDeadline !== null, true);

    // 준비
    const deadline = active.depositDeadline;
    // 확인
    assert.ok(deadline);

    // 실행
    const broken = await breakExpiredContracts(uow, {
      now: new Date(deadline.getTime() + 1),
    });

    // 확인
    assert.equal(broken, 1);
    assert.equal(tx.contracts[0]?.status, 'CANCELLED');
    assert.equal(tx.lastCancelReason, 'DEPOSIT_TIMEOUT');
    assert.deepEqual(
      tx.notifications
        .filter((notification) => notification.type === 'CONTRACT_BROKEN')
        .map((notification) => notification.payload),
      [{ reason: 'DEPOSIT_TIMEOUT' }, { reason: 'DEPOSIT_TIMEOUT' }],
    );
    assert.equal(tx.projects[0]?.status, 'RECRUITING');
  });

  it('입금이 시작된 계약은 예치 기한 배치에서 제외한다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);
    const active = await signBoth(uow, contract);
    // 준비
    const deadline = active.depositDeadline;
    // 확인
    assert.ok(deadline);

    // 준비
    tx.contracts[0] = {
      ...active,
      paymentStatus: 'DEPOSITED',
      totalDeposited: 3_255_000,
    };

    // 실행
    const broken = await breakExpiredContracts(uow, {
      now: new Date(deadline.getTime() + 1),
    });
    // 확인
    assert.equal(broken, 0);
    assert.equal(tx.contracts[0]?.status, 'ACTIVE');
  });

  it('사유에 맞는 당사자만 결렬을 요청할 수 있다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);

    // 실행 및 확인
    await assert.rejects(
      breakContract(uow, {
        contractId: contract.id,
        reason: 'SIGN_REFUSED',
        actor: CLIENT,
        now: beforeDeadline,
      }),
      isContractError(403, 'FORBIDDEN_BREAK_REASON'),
    );
    await assert.rejects(
      breakContract(uow, {
        contractId: contract.id,
        reason: 'CLIENT_CANCELLED',
        actor: SUPPLIER,
        now: beforeDeadline,
      }),
      isContractError(403, 'FORBIDDEN_BREAK_REASON'),
    );
    // 확인
    assert.equal(tx.contracts[0]?.status, 'PENDING_CONSENT');
  });

  it('이미 결렬된 계약은 다시 결렬되지 않는다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);
    await breakContract(uow, {
      contractId: contract.id,
      reason: 'SIGN_REFUSED',
      actor: SUPPLIER,
      now: beforeDeadline,
    });

    // 실행 및 확인
    await assert.rejects(
      breakContract(uow, {
        contractId: contract.id,
        reason: 'CLIENT_CANCELLED',
        actor: CLIENT,
        now: beforeDeadline,
      }),
      isContractError(409, 'CONTRACT_NOT_BREAKABLE'),
    );
    // 확인
    assert.equal(
      tx.notifications.filter((notification) => notification.type === 'CONTRACT_BROKEN')
        .length,
      2,
    );
    assert.equal(
      tx.events.filter((event) => event.type === 'CONTRACT_BROKEN').length,
      2,
    );
  });
});

describe('B-05-T07 PDF 해시·접근권한·개인정보', () => {
  it('당사자만 문서를 열 수 있고 해시가 계약과 일치한다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);

    const forClient = contractDocumentFor(contract, CLIENT);
    const forSupplier = contractDocumentFor(contract, SUPPLIER);

    // 확인
    assert.equal(forClient.contentHash, contract.contentHash);
    assert.equal(forSupplier.contentHash, contract.contentHash);
    assert.equal(forClient.depositAmount, 3_255_000);
    assert.equal(forClient.supplierPayout, 2_945_000);
    assert.equal(forClient.interimRatio, 60);
    assert.equal(forClient.items.length, 2);

    // 준비
    const serialized = JSON.stringify(forClient);
    // 확인
    for (const sensitive of ['@', '010-', 'account', 'email', 'phone']) {
      assert.equal(serialized.includes(sensitive), false, `${sensitive} 포함`);
    }

    // 실행 및 확인
    assert.throws(
      () => contractDocumentFor(contract, INTRUDER),
      isContractError(404, 'CONTRACT_NOT_FOUND'),
    );
  });

  it('같은 내용은 같은 해시, 조건 텍스트가 바뀌면 다른 해시다', async () => {
    // 실행
    const base = prepareProvisionalContract({
      application: applicationRecord(),
      agreement: agreementDraft(),
      items: sources(),
      now: FIXED_NOW,
    });
    const reversedSources = prepareProvisionalContract({
      application: applicationRecord(),
      agreement: agreementDraft(),
      items: [...sources()].reverse(),
      now: FIXED_NOW,
    });
    const changed = prepareProvisionalContract({
      application: applicationRecord(),
      agreement: agreementDraft({
        items: agreementDraft().items.map((item, index) =>
          index === 0
            ? {
                ...item,
                conditions: item.conditions.map((condition) =>
                  condition.key === 'warranty'
                    ? { ...condition, text: '버그 수정 기간 6개월' }
                    : condition,
                ),
              }
            : item,
        ),
      }),
      items: sources(),
      now: FIXED_NOW,
    });

    // 확인
    assert.equal(base.contentHash, reversedSources.contentHash);
    assert.notEqual(base.contentHash, changed.contentHash);
  });

  it('예치 기한은 체결일과 무관하게 KST 기준 일자로 계산한다', () => {
    // 준비
    const earlyKst = new Date('2026-11-03T00:30:00.000Z');
    const lateKst = new Date('2026-11-03T14:30:00.000Z');

    // 확인
    assert.equal(
      depositDeadlineFrom(earlyKst).toISOString(),
      '2026-11-06T14:59:59.999Z',
    );
    assert.equal(
      depositDeadlineFrom(lateKst).toISOString(),
      '2026-11-06T14:59:59.999Z',
    );
  });
});

describe('B-05-T08 계약 중 명세 변경 거부', () => {
  it('임시 계약·계약 중에는 범위를 바꿀 수 없다', async () => {
    // 준비
    const { tx, uow } = setup();
    // 실행
    const contract = await accept(tx, uow);

    // 실행 및 확인
    assert.throws(
      () => assertScopeMutable(contract),
      isContractError(409, 'CONTRACT_SCOPE_FROZEN'),
    );
    assert.throws(
      () => assertScopeMutable({ ...contract, status: 'ACTIVE' }),
      isContractError(409, 'CONTRACT_SCOPE_FROZEN'),
    );
    assert.throws(
      () => assertScopeMutable({ ...contract, status: 'CANCEL_REQUESTED' }),
      isContractError(409, 'CONTRACT_SCOPE_FROZEN'),
    );

    assert.doesNotThrow(() => assertScopeMutable(null));
    assert.doesNotThrow(() => assertScopeMutable({ ...contract, status: 'CANCELLED' }));
    assert.doesNotThrow(() => assertScopeMutable({ ...contract, status: 'COMPLETED' }));

    // 실행
    const active = await signBoth(uow, contract);
    // 확인
    assert.equal(active.status, 'ACTIVE');
  });
});

describe('B-05-T09 기본 합의 초안 자동 생성', () => {
  it('저장된 초안이 없으면 현재 명세 기준 기본 초안을 만들어 저장한다', async () => {
    // 준비
    const { tx, uow } = setup();

    // 실행
    const result = await acceptAgreement(uow, {
      actor: CLIENT,
      application: applicationRecord(),
      spec: spec(),
      items: sources(),
      now: FIXED_NOW,
    });

    // 준비
    const saved = tx.agreementDrafts.get('app-1');
    // 확인
    assert.ok(saved !== undefined);
    assert.equal(saved.ratioState, 'UNDECIDED');
    assert.equal(saved.interimRatio, 50);
    assert.ok(saved.items.every((item) => item.conditions.every((condition) => condition.state === 'UNDECIDED')));
    assert.equal(result.contract.status, 'PENDING_CONSENT');
    assert.equal(result.plan.interimRatio, 50);
    assert.equal(tx.applications[0]?.status, 'ACCEPTED');
    assert.equal(tx.projects[0]?.status, 'ACCEPTED');
    assert.equal(tx.notifications.length, 1);
    assert.equal(tx.systemMessages.length, 1);
  });

  it('저장된 유효 초안이 있으면 그 초안을 재사용한다', async () => {
    // 준비
    const { tx, uow } = setup();
    const stored = agreementDraft({ interimRatio: 60, ratioState: 'DECIDED' });
    tx.agreementDrafts.set('app-1', stored);

    // 실행
    const result = await acceptAgreement(uow, {
      actor: CLIENT,
      application: applicationRecord(),
      spec: spec(),
      items: sources(),
      now: FIXED_NOW,
    });

    // 확인
    assert.equal(result.plan.interimRatio, 60);
    assert.deepEqual(tx.agreementDrafts.get('app-1'), stored);
  });
});
