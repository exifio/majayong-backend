import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDevAuthVerifier } from './http/auth.ts';
import { buildBApp, type BPrismaPorts, type ExternalPorts } from './server.ts';
import type { Actor } from './modules/application/dto.ts';
import { FIXED_NOW } from '../tests/b/fixtures.ts';
import { withServer } from '../tests/b/http-helpers.ts';

const CLIENT: Actor = { userId: 'client-1', role: 'CLIENT' };
const unused = async (): Promise<never> => {
  throw new Error('unused');
};

const notificationDelegate = {
  findUnique: unused,
  create: unused,
  update: unused,
  findMany: unused,
  count: unused,
  updateMany: unused,
};

const notificationTx = {
  findByKey: async () => null,
  findUnique: async () => null,
  create: unused,
  refreshBundled: unused,
  listRecent: async () => [],
  countUnread: async () => 0,
  markRead: async () => false,
  markAllRead: async () => 0,
};

function prismaPorts(): BPrismaPorts {
  return {
    application: {
      $queryRaw: async <T = unknown>() => [] as T,
      application: {
        findMany: unused,
        findUnique: unused,
        create: unused,
        updateMany: unused,
      },
      project: { findUnique: unused },
      specItem: { findMany: unused },
      applicationMessage: { create: unused },
      eventLog: { findFirst: unused },
      notification: notificationDelegate,
      $transaction: unused,
    },
    applicationRead: {
      application: { findMany: unused, findUnique: unused },
      project: { findUnique: unused },
    },
    agreement: { application: { findUnique: unused, update: unused } },
    chat: {
      application: { findUnique: unused, findMany: unused },
      applicationMessage: {
        findMany: unused,
        findFirst: unused,
        create: unused,
        updateMany: unused,
      },
    },
    contract: {
      contract: {
        findUnique: unused,
        findMany: unused,
        create: unused,
        update: unused,
        updateMany: unused,
      },
      application: { findFirst: unused, findMany: unused, findUnique: unused, update: unused, updateMany: unused },
      project: { findUnique: unused, updateMany: unused },
      applicationMessage: { create: unused },
      eventLog: { create: unused },
      notification: notificationDelegate,
      $transaction: unused,
    },
    report: {
      applicationMessage: { findUnique: unused },
      report: {
        findFirst: unused,
        findMany: unused,
        findUnique: unused,
        create: unused,
        update: unused,
        count: unused,
      },
      eventLog: { create: unused },
      notification: notificationDelegate,
      $transaction: unused,
    },
    support: {
      supportInquiry: {
        findUnique: unused,
        findMany: unused,
        create: unused,
        update: unused,
      },
      contract: { findFirst: unused },
      eventLog: { create: unused },
      fileAttachment: { updateMany: unused },
      notification: notificationTx,
      $transaction: unused,
    },
    market: {
      bookmark: {
        findUnique: unused,
        create: unused,
        delete: unused,
        findMany: unused,
      },
    },
    notification: {
      notification: notificationDelegate,
      $transaction: unused,
    },
    databaseNull: Object.freeze({ dbNull: true }),
  };
}

function externalPorts(): ExternalPorts {
  return {
    projectState: { getForApplication: async () => null },
    projects: { listPublicProjectsByIds: async () => [] },
    recommendations: {
      getSupplier: async () => null,
      listOpenProjects: async () => [],
      listAppliedProjectIds: async () => [],
    },
    chatAccounts: {
      getAccountState: async () => ({
        suspendedAt: null,
        withdrawnAt: null,
        chatRestrictedUntil: null,
      }),
    },
    chatEvents: { recordInquiryOpenedOnce: async () => false },
    reportAccounts: { applyAccountAction: async () => {} },
    contractItems: { listSources: async () => [] },
    agreementPreview: { getSpec: async () => null, getMessages: async () => [] },
    depositAttempts: { hasDepositAttempt: async () => false },
    now: () => FIXED_NOW,
  };
}

describe('Gate 0 서버 조립', () => {
  it('B 앱을 조립하면 health가 열리고 인증 없는 API는 401 봉투다', async () => {
    // 준비
    const app = buildBApp(
      prismaPorts(),
      externalPorts(),
      createDevAuthVerifier([{ token: 'client-token', actor: CLIENT }]),
    );

    await withServer(app, async (call) => {
      // 실행
      const health = await call({ method: 'GET', path: '/health' });
      // 확인
      assert.equal(health.status, 200);
      assert.deepEqual(health.body, { data: { status: 'ok' } });

      const unauthorized = await call({ method: 'GET', path: '/api/v1/me/notifications' });
      assert.equal(unauthorized.status, 401);
      assert.equal(
        (unauthorized.body as { error: { code: string } }).error.code,
        'UNAUTHENTICATED',
      );
    });
  });

  it('알 수 없는 API 경로는 404 오류 봉투다', async () => {
    // 준비
    const app = buildBApp(
      prismaPorts(),
      externalPorts(),
      createDevAuthVerifier([{ token: 'client-token', actor: CLIENT }]),
    );

    await withServer(app, async (call) => {
      // 실행
      const missing = await call({
        method: 'GET',
        path: '/api/v1/unknown',
        token: 'client-token',
      });
      // 확인
      assert.equal(missing.status, 404);
      assert.equal((missing.body as { error: { code: string } }).error.code, 'NOT_FOUND');
    });
  });
});
