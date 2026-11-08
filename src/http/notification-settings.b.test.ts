import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApp } from './create-app.ts';
import { createDevAuthVerifier } from './auth.ts';
import { createNotificationRouter } from '../modules/notification/http.ts';
import type { Actor } from '../modules/application/dto.ts';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '../modules/notification/settings.ts';
import { FIXED_NOW } from '../../tests/b/fixtures.ts';
import { withServer } from '../../tests/b/http-helpers.ts';

const CLIENT: Actor = { userId: 'client-1', role: 'CLIENT' };

const unused = async (): Promise<never> => {
  throw new Error('unused');
};

function buildRouter(rows: Map<string, unknown>, withStore = true) {
  return createNotificationRouter({
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
    ...(withStore
      ? {
          settings: {
            async get(userId: string) {
              return rows.get(userId) ?? null;
            },
            async save(userId: string, settings: NotificationSettings) {
              rows.set(userId, settings);
            },
          },
        }
      : {}),
    now: () => FIXED_NOW,
  });
}

function appWith(router: ReturnType<typeof createNotificationRouter>) {
  return createApp({
    auth: createDevAuthVerifier([{ token: 'client-token', actor: CLIENT }]),
    routers: [{ basePath: '', router }],
  });
}

describe('D-38 알림 설정 HTTP', () => {
  it('저장값이 없으면 기본값을 반환한다', async () => {
    const rows = new Map<string, unknown>();
    await withServer(appWith(buildRouter(rows)), async (call) => {
      const response = await call({ method: 'GET', path: '/api/v1/me/notification-settings', token: 'client-token' });
      assert.equal(response.status, 200);
      assert.deepEqual((response.body as { data: unknown }).data, DEFAULT_NOTIFICATION_SETTINGS);
    });
  });

  it('PATCH는 일부 필드만 바꾸고 저장한다', async () => {
    const rows = new Map<string, unknown>();
    await withServer(appWith(buildRouter(rows)), async (call) => {
      const response = await call({
        method: 'PATCH',
        path: '/api/v1/me/notification-settings',
        token: 'client-token',
        body: { chat: false },
      });
      assert.equal(response.status, 200);
      assert.equal((response.body as { data: { chat: boolean } }).data.chat, false);
      assert.equal((response.body as { data: { contract: boolean } }).data.contract, true);
      assert.equal((rows.get('client-1') as { chat: boolean }).chat, false);
    });
  });

  it('알 수 없는 키는 400이고 설정 포트가 없으면 503이다', async () => {
    const rows = new Map<string, unknown>();
    await withServer(appWith(buildRouter(rows)), async (call) => {
      const bad = await call({
        method: 'PATCH',
        path: '/api/v1/me/notification-settings',
        token: 'client-token',
        body: { unknown: true },
      });
      assert.equal(bad.status, 400);
    });
    await withServer(appWith(buildRouter(rows, false)), async (call) => {
      const response = await call({ method: 'GET', path: '/api/v1/me/notification-settings', token: 'client-token' });
      assert.equal(response.status, 503);
    });
  });
});
