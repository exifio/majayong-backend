import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApp } from './create-app.ts';
import { createDevAuthVerifier } from './auth.ts';
import type { Actor } from '../modules/application/dto.ts';
import { createChatRouter } from '../modules/chat/http.ts';
import { createContractRouter } from '../modules/contract/http.ts';
import { createMarketRouter } from '../modules/market/http.ts';
import { createNotificationRouter } from '../modules/notification/http.ts';
import { createReportRouter } from '../modules/report/http.ts';
import { createSupportRouter } from '../modules/support/http.ts';
import { FIXED_NOW } from '../../tests/b/fixtures.ts';
import { withServer } from '../../tests/b/http-helpers.ts';

const CLIENT: Actor = { userId: 'client-1', role: 'CLIENT' };
const SUPPLIER: Actor = { userId: 'supplier-1', role: 'SUPPLIER' };

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

function summary(id: string) {
  return {
    id,
    title: '예약 사이트',
    summary: '예약 기능',
    industryCode: 'FOOD',
    requiredSkills: ['React'],
    hopeBudgetRange: null,
    deadline: new Date('2026-12-01T00:00:00.000Z'),
    status: 'RECRUITING' as const,
    publishedAt: FIXED_NOW,
    currentSpecVersion: 1,
    specItemCount: 1,
    specItemTitles: ['예약'],
  };
}

function appWith(router: ReturnType<typeof createMarketRouter>) {
  return createApp({
    auth: createDevAuthVerifier([
      { token: 'client-token', actor: CLIENT },
      { token: 'supplier-token', actor: SUPPLIER },
    ]),
    routers: [{ basePath: '', router }],
  });
}

describe('Gate 0 HTTP: 북마크·추천', () => {
  it('북마크 저장·목록·해제가 봉투와 상태 코드로 동작한다', async () => {
    // 준비
    const rows = new Map<string, { supplierId: string; projectId: string; createdAt: Date }>();
    const router = createMarketRouter({
      bookmarks: {
        async findByKey(input) {
          return rows.get(`${input.supplierId}:${input.projectId}`) ?? null;
        },
        async create(input) {
          rows.set(`${input.supplierId}:${input.projectId}`, input);
          return input;
        },
        async delete(input) {
          return rows.delete(`${input.supplierId}:${input.projectId}`);
        },
        async listBySupplier(supplierId) {
          return [...rows.values()].filter((row) => row.supplierId === supplierId);
        },
      },
      projects: { listPublicProjectsByIds: async () => [summary('prj-1')] },
      recommendations: {
        getSupplier: async () => ({ supplierId: 'supplier-1', industryCodes: ['FOOD'], skills: [] }),
        listOpenProjects: async () => [summary('prj-1')],
        listAppliedProjectIds: async () => [],
      },
      now: () => FIXED_NOW,
    });

    await withServer(appWith(router), async (call) => {
      // 실행
      const created = await call({
        method: 'PUT',
        path: '/api/v1/projects/prj-1/bookmark',
        token: 'supplier-token',
        body: {},
      });
      // 확인
      assert.equal(created.status, 201);

      // 실행
      const list = await call({ method: 'GET', path: '/api/v1/me/bookmarks', token: 'supplier-token' });
      // 확인
      assert.equal(list.status, 200);
      const items = (list.body as { data: { project: { id: string }; applicationOpen: boolean }[] }).data;
      assert.equal(items.length, 1);
      assert.equal(items[0]?.project.id, 'prj-1');
      assert.equal(items[0]?.applicationOpen, true);

      // 실행
      const removed = await call({
        method: 'DELETE',
        path: '/api/v1/projects/prj-1/bookmark',
        token: 'supplier-token',
      });
      // 확인
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.body, { data: { removed: true } });
    });
  });
});

describe('Gate 0 HTTP: 나머지 모듈 라우터 장착', () => {
  it('채팅방 목록·알림 목록·계약 목록이 data 봉투로 응답한다', async () => {
    // 준비
    const chat = createChatRouter({
      repository: {
        findApplication: unused,
        findThreadMessages: unused,
        hasMessageFrom: unused,
        createMessage: unused,
        markRead: unused,
      },
      rooms: { listRoomsForUser: async () => [] },
      accounts: { getAccountState: async () => ({ suspendedAt: null, withdrawnAt: null, chatRestrictedUntil: null }) },
      events: { recordInquiryOpenedOnce: async () => true },
      now: () => FIXED_NOW,
    });
    const notification = createNotificationRouter({
      uow: {
        run: async (work) =>
          work({
            findByKey: unused,
            create: unused,
            refreshBundled: unused,
            listRecent: async () => [],
            countUnread: async () => 0,
            markRead: unused,
            markAllRead: unused,
          }),
      },
      now: () => FIXED_NOW,
    });
    const contract = createContractRouter({
      uow: { run: unused },
      reads: { listForUser: async () => [], findById: unused },
      applications: { findRevision: unused },
      agreements: { get: async () => null, save: unused, invalidate: unused },
      items: { listSources: async () => [] },
      preview: { getSpec: async () => null, getMessages: async () => [] },
      now: () => FIXED_NOW,
    });

    // 실행 및 확인
    for (const router of [chat, notification, contract]) {
      await withServer(appWith(router), async (call) => {
        const path =
          router === chat ? '/api/v1/me/chats' : router === notification ? '/api/v1/me/notifications' : '/api/v1/me/contracts';
        const response = await call({ method: 'GET', path, token: 'client-token' });
        assert.equal(response.status, 200, path);
        assert.ok((response.body as { data: unknown }).data !== undefined);
      });
    }
  });

  it('운영자 전용 신고·문의 목록은 일반 사용자에게 403이다', async () => {
    // 준비
    const report = createReportRouter({
      uow: {
        run: async (work) =>
          work({
            findReportableMessage: unused,
            findOpenReport: unused,
            createReport: unused,
            listReports: async () => [],
            findReport: unused,
            findWarningCount: async () => 0,
            resolveReport: unused,
            applyAccountAction: unused,
            notifyReporter: unused,
            logEvent: unused,
          }),
      },
      myReports: { listByReporter: async () => [] },
      now: () => FIXED_NOW,
    });
    const support = createSupportRouter({
      uow: {
        run: async (work) =>
          work({
            canAccessContract: async () => true,
            createInquiry: unused,
            bindInquiryFiles: async () => 0,
            findInquiry: unused,
            listInquiries: async () => [],
            answerInquiry: unused,
            notifyAuthor: unused,
            logEvent: unused,
          }),
      },
      now: () => FIXED_NOW,
    });

    // 실행 및 확인
    await withServer(appWith(report), async (call) => {
      const response = await call({
        method: 'GET',
        path: '/api/v1/admin/reports',
        token: 'supplier-token',
      });
      assert.equal(response.status, 403);
      assert.equal((response.body as { error: { code: string } }).error.code, 'ADMIN_ONLY');
    });

    // 실행 및 확인
    await withServer(appWith(support), async (call) => {
      const response = await call({
        method: 'GET',
        path: '/api/v1/admin/support/inquiries',
        token: 'client-token',
      });
      assert.equal(response.status, 403);
      assert.equal((response.body as { error: { code: string } }).error.code, 'ADMIN_ONLY');
    });
  });
});

describe('G2-02 계약 미리보기 권한', () => {
  it('당사자만 합의 미리보기를 읽고 비당사자에게는 존재를 숨긴다', async () => {
    // 준비
    const router = createContractRouter({
      uow: { run: unused },
      reads: { listForUser: async () => [], findById: unused },
      applications: {
        async findRevision(id) {
          return id === 'app-1'
            ? {
                id: 'app-1', projectId: 'prj-1', clientUserId: 'client-1', supplierId: 'supplier-1',
                revisionNo: 1, specVersionNo: 1, status: 'SUBMITTED', totalAmount: 10_000,
                durationDays: 1, message: null, questions: [], isMessageMasked: false,
                revisionReason: null, firstViewedAt: FIXED_NOW, submittedAt: FIXED_NOW, items: [],
              }
            : null;
        },
      },
      agreements: { get: async () => null, save: unused, invalidate: unused },
      items: { listSources: async () => [] },
      preview: {
        getSpec: async () => ({ items: [], defaultInterimRatio: 50 }),
        getMessages: async () => [],
      },
      now: () => FIXED_NOW,
    });
    const app = createApp({
      auth: createDevAuthVerifier([
        { token: 'client-token', actor: CLIENT },
        { token: 'supplier-token', actor: SUPPLIER },
        { token: 'outsider-token', actor: { userId: 'outsider-1', role: 'CLIENT' } },
      ]),
      routers: [{ basePath: '', router }],
    });

    await withServer(app, async (call) => {
      // 실행
      const own = await call({
        method: 'GET', path: '/api/v1/applications/app-1/agreement-preview', token: 'client-token',
      });
      // 확인
      assert.equal(own.status, 200);

      // 실행 및 확인
      const other = await call({
        method: 'GET', path: '/api/v1/applications/app-1/agreement-preview', token: 'supplier-token',
      });
      assert.equal(other.status, 200);

      const outsider = await call({
        method: 'GET', path: '/api/v1/applications/app-1/agreement-preview', token: 'outsider-token',
      });
      assert.equal(outsider.status, 404);

      const missing = await call({
        method: 'GET', path: '/api/v1/applications/ghost/agreement-preview', token: 'client-token',
      });
      assert.equal(missing.status, 404);
    });
  });
});
