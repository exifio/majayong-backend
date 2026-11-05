import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApp } from '../../http/create-app.ts';
import { createDevAuthVerifier } from '../../http/auth.ts';
import type { Actor, ApplicationRecord } from './dto.ts';
import {
  createApplicationRouter,
  type ApplicationHttpPorts,
  type ProjectStateForApplication,
} from './http.ts';
import type { ApplicationReadPort } from './queries.ts';
import {
  createApplicationNotificationPort,
  type ApplicationNotificationPort,
  type ApplicationRevision,
  type ApplicationTx,
  type ApplicationUnitOfWork,
  type NewApplicationRevision,
} from './submission.ts';
import type { NewNotification, NotificationRecord, NotificationTx } from '../notification/notifications.ts';
import { applicationRevision, FIXED_NOW } from '../../../tests/b/fixtures.ts';
import { withServer } from '../../../tests/b/http-helpers.ts';

const CLIENT: Actor = { userId: 'client-1', role: 'CLIENT' };
const SUPPLIER: Actor = { userId: 'supplier-1', role: 'SUPPLIER' };
const INTRUDER: Actor = { userId: 'supplier-2', role: 'SUPPLIER' };

class NoopNotificationTx implements NotificationTx {
  readonly rows: NewNotification[] = [];
  async findByKey(input: {
    readonly userId: string;
    readonly type: NewNotification['type'];
    readonly targetId: string;
  }): Promise<NotificationRecord | null> {
    return this.rows.find(
      (row) => row.userId === input.userId && row.type === input.type && row.targetId === input.targetId,
    ) === undefined
      ? null
      : {
          id: 'notification-1',
          userId: input.userId,
          type: input.type,
          targetUrl: '/x',
          targetId: input.targetId,
          payload: null,
          isRead: false,
          createdAt: FIXED_NOW,
        };
  }
  async create(input: NewNotification): Promise<NotificationRecord> {
    this.rows.push(input);
    return { ...input, id: `notification-${this.rows.length}`, isRead: false };
  }
  async refreshBundled(): Promise<NotificationRecord> {
    throw new Error('not a chat notification');
  }
  async listRecent() {
    return [];
  }
  async countUnread() {
    return 0;
  }
  async markRead() {
    return false;
  }
  async markAllRead() {
    return 0;
  }
}

class MemoryAppTx implements ApplicationTx {
  rows: ApplicationRevision[] = [];
  projectSpec: ProjectStateForApplication = {
    clientUserId: 'client-1',
    status: 'RECRUITING',
    currentVersion: 1,
    specItemIds: ['spec-1', 'spec-2'],
  };
  readonly notificationTx = new NoopNotificationTx();
  readonly notifications: ApplicationNotificationPort = createApplicationNotificationPort(
    this.notificationTx,
  );

  async findFirstDetailView(): Promise<Date | null> {
    return FIXED_NOW;
  }

  async findProjectSpec() {
    const { currentVersion, status, specItemIds } = this.projectSpec;
    return { currentVersion, status, specItemIds };
  }

  async findLatestRevision(input: {
    readonly projectId: string;
    readonly supplierId: string;
  }): Promise<ApplicationRevision | null> {
    const matches = this.rows.filter(
      (row) => row.projectId === input.projectId && row.supplierId === input.supplierId,
    );
    return matches.reduce<ApplicationRevision | null>(
      (latest, row) => (latest === null || row.revisionNo > latest.revisionNo ? row : latest),
      null,
    );
  }

  async findById(applicationId: string): Promise<ApplicationRevision | null> {
    return this.rows.find((row) => row.id === applicationId) ?? null;
  }

  async listByProject(projectId: string): Promise<readonly ApplicationRevision[]> {
    return this.rows.filter((row) => row.projectId === projectId);
  }

  async createRevision(input: NewApplicationRevision): Promise<ApplicationRevision> {
    const row = applicationRevision({
      ...input,
      id: `app-${this.rows.length + 1}`,
      revisionNo: 1,
      status: 'SUBMITTED',
      submittedAt: FIXED_NOW,
    });
    this.rows.push(row);
    return row;
  }

  async updateStatus(input: {
    readonly applicationId: string;
    readonly from: readonly ApplicationRevision['status'][];
    readonly to: ApplicationRevision['status'];
  }): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.id === input.applicationId);
    const row = this.rows[index];
    if (row === undefined || !input.from.includes(row.status)) return false;
    this.rows[index] = { ...row, status: input.to };
    return true;
  }

  async appendSystemMessage(): Promise<void> {}
}

class MemoryUow implements ApplicationUnitOfWork {
  readonly tx: MemoryAppTx;

  constructor(tx: MemoryAppTx) {
    this.tx = tx;
  }

  run<T>(work: (tx: ApplicationTx) => Promise<T>): Promise<T> {
    return work(this.tx);
  }
}

function buildApp(options: { readonly advanceSpecAfterRead?: boolean } = {}): {
  app: ReturnType<typeof createApp>;
  tx: MemoryAppTx;
} {
  const tx = new MemoryAppTx();
  tx.rows.push(applicationRevision({ id: 'app-1', status: 'REJECTED' }));
  const reads: ApplicationReadPort = {
    async listForUser(input) {
      return tx.rows.filter((row) =>
        input.role === 'CLIENT' ? row.clientUserId === input.userId : row.supplierId === input.userId,
      ) as readonly ApplicationRecord[];
    },
    async findRevision(applicationId) {
      return tx.rows.find((row) => row.id === applicationId) ?? null;
    },
  };
  const ports: ApplicationHttpPorts = {
    uow: new MemoryUow(tx),
    reads,
    projectApplications: {
      findProjectClientId: async (projectId) => (projectId === 'prj-1' ? 'client-1' : null),
      listRevisionsByProject: async (projectId) =>
        tx.rows.filter((row) => row.projectId === projectId),
      listSupplierProfileSummaries: async () => [],
    },
    projectState: {
      getForApplication: async (projectId) => {
        if (projectId !== 'prj-1') return null;
        const state = { ...tx.projectSpec, specItemIds: [...tx.projectSpec.specItemIds] };
        if (options.advanceSpecAfterRead === true) {
          tx.projectSpec = { ...tx.projectSpec, currentVersion: 2, specItemIds: ['spec-new'] };
        }
        return state;
      },
    },
    now: () => FIXED_NOW,
  };
  const app = createApp({
    auth: createDevAuthVerifier([
      { token: 'client-token', actor: CLIENT },
      { token: 'supplier-token', actor: SUPPLIER },
      { token: 'intruder-token', actor: INTRUDER },
    ]),
    routers: [{ basePath: '', router: createApplicationRouter(ports) }],
  });
  return { app, tx };
}

describe('Gate 0 HTTP: 지원·견적 라우터', () => {
  it('공급자 지원 제출은 201과 data 봉투를 돌려주고 의뢰인 알림을 만든다', async () => {
    // 준비
    const { app, tx } = buildApp();

    // 실행 및 확인
    await withServer(app, async (call) => {
      const response = await call({
        method: 'POST',
        path: '/api/v1/projects/prj-1/applications',
        token: 'supplier-token',
        body: {
          totalAmount: 3_100_000,
          durationDays: 42,
          items: [{ specItemId: 'spec-1', isAvailable: true }],
        },
      });

      assert.equal(response.status, 201);
      const body = response.body as { data: { status: string; totalAmount: number } };
      assert.equal(body.data.status, 'SUBMITTED');
      assert.equal(body.data.totalAmount, 3_100_000);
      assert.equal(tx.notificationTx.rows.length, 1);
      assert.equal(tx.notificationTx.rows[0]?.userId, 'client-1');
      assert.equal(response.headers.get('x-request-id')?.length, 36);
    });
  });

  it('명세가 HTTP 읽기와 지원 쓰기 사이에 바뀌면 제출하지 않는다', async () => {
    // 준비
    const { app, tx } = buildApp({ advanceSpecAfterRead: true });

    // 실행 및 확인
    await withServer(app, async (call) => {
      const response = await call({
        method: 'POST',
        path: '/api/v1/projects/prj-1/applications',
        token: 'supplier-token',
        body: {
          totalAmount: 3_100_000,
          durationDays: 42,
          items: [{ specItemId: 'spec-1', isAvailable: true }],
        },
      });

      assert.equal(response.status, 409);
      assert.equal((response.body as { error: { code: string } }).error.code, 'PROJECT_SPEC_CHANGED');
      assert.equal(tx.rows.length, 1);
    });
  });

  it('명세가 HTTP 읽기와 견적 수정 사이에 바뀌면 회차를 대체하지 않는다', async () => {
    // 준비
    const { app, tx } = buildApp({ advanceSpecAfterRead: true });
    tx.rows[0] = applicationRevision({ id: 'app-1', status: 'SUBMITTED' });

    // 실행 및 확인
    await withServer(app, async (call) => {
      const response = await call({
        method: 'POST',
        path: '/api/v1/applications/app-1/revisions',
        token: 'supplier-token',
        body: {
          totalAmount: 3_300_000,
          durationDays: 40,
          revisionReason: '명세 변경 반영',
          items: [{ specItemId: 'spec-1', isAvailable: true }],
        },
      });

      assert.equal(response.status, 409);
      assert.equal((response.body as { error: { code: string } }).error.code, 'PROJECT_SPEC_CHANGED');
      assert.equal(tx.rows.length, 1);
      assert.equal(tx.rows[0]?.status, 'SUBMITTED');
    });
  });

  it('토큰이 없으면 401 오류 봉투다', async () => {
    // 준비
    const { app } = buildApp();

    // 실행 및 확인
    await withServer(app, async (call) => {
      const response = await call({
        method: 'GET',
        path: '/api/v1/me/applications',
      });

      assert.equal(response.status, 401);
      const body = response.body as { error: { code: string; requestId: string } };
      assert.equal(body.error.code, 'UNAUTHENTICATED');
      assert.equal(body.error.requestId, response.headers.get('x-request-id'));
    });
  });

  it('의뢰인이 지원을 제출하면 403 FORBIDDEN이다', async () => {
    // 준비
    const { app } = buildApp();

    // 실행 및 확인
    await withServer(app, async (call) => {
      const response = await call({
        method: 'POST',
        path: '/api/v1/projects/prj-1/applications',
        token: 'client-token',
        body: {
          totalAmount: 1_000_000,
          durationDays: 10,
          items: [{ specItemId: 'spec-1', isAvailable: true }],
        },
      });

      assert.equal(response.status, 403);
      assert.equal((response.body as { error: { code: string } }).error.code, 'FORBIDDEN');
    });
  });

  it('의뢰인만 프로젝트 지원 목록을 보고, 공급자는 403이다', async () => {
    // 준비
    const { app } = buildApp();

    // 실행 및 확인
    await withServer(app, async (call) => {
      const client = await call({
        method: 'GET',
        path: '/api/v1/projects/prj-1/applications',
        token: 'client-token',
      });
      assert.equal(client.status, 200);
      assert.equal((client.body as { data: unknown[] }).data.length, 1);

      const supplier = await call({
        method: 'GET',
        path: '/api/v1/projects/prj-1/applications',
        token: 'supplier-token',
      });
      assert.equal(supplier.status, 403);
    });
  });

  it('비당사자 상세 조회는 404 봉투로 존재를 숨긴다', async () => {
    // 준비
    const { app } = buildApp();

    // 실행 및 확인
    await withServer(app, async (call) => {
      const response = await call({
        method: 'GET',
        path: '/api/v1/applications/app-1',
        token: 'intruder-token',
      });

      assert.equal(response.status, 404);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        'APPLICATION_NOT_FOUND',
      );
    });
  });
});
