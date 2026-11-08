/** Gate 0: 알림 HTTP 라우터 (API_INDEX #096~#098). */
import { Router, type Request } from 'express';

import { HttpError, sendData } from '../../http/envelope.js';
import { bodyObject } from '../../http/parse.js';
import type { Actor } from '../application/dto.js';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationUnitOfWork,
} from './notifications.js';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  mergeNotificationSettings,
  readNotificationSettings,
  type NotificationSettingsStore,
} from './settings.js';

export interface NotificationHttpPorts {
  readonly uow: NotificationUnitOfWork;
  readonly settings?: NotificationSettingsStore;
  readonly now: () => Date;
}

function actorOf(request: Request): Actor {
  const actor = request.actor;
  if (actor === undefined) throw new HttpError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  return actor;
}

export function createNotificationRouter(ports: NotificationHttpPorts): Router {
  const router = Router();

  router.get('/me/notifications', async (request, response) => {
    const actor = actorOf(request);
    const unreadOnly = request.query.unreadOnly === 'true';
    const list = await listNotifications(ports.uow, {
      userId: actor.userId,
      now: ports.now(),
      unreadOnly,
    });
    sendData(response, list.items, { unreadCount: list.unreadCount });
  });

  router.patch('/me/notifications/:notificationId/read', async (request, response) => {
    const actor = actorOf(request);
    bodyObject(request.body, []);
    await markNotificationRead(ports.uow, {
      notificationId: request.params.notificationId as string,
      userId: actor.userId,
      now: ports.now(),
    });
    sendData(response, { isRead: true });
  });

  router.post('/me/notifications/read-all', async (request, response) => {
    const actor = actorOf(request);
    bodyObject(request.body, []);
    const updated = await markAllNotificationsRead(ports.uow, {
      userId: actor.userId,
      now: ports.now(),
    });
    sendData(response, { updated });
  });

  router.get('/me/notification-settings', async (request, response) => {
    const actor = actorOf(request);
    if (ports.settings === undefined) {
      throw new HttpError(503, 'NOTIFICATION_SETTINGS_UNAVAILABLE', '알림 설정을 사용할 수 없습니다.');
    }
    sendData(response, readNotificationSettings(await ports.settings.get(actor.userId)));
  });

  router.patch('/me/notification-settings', async (request, response) => {
    const actor = actorOf(request);
    const body = bodyObject(request.body, [
      'contract',
      'chat',
      'recruiting',
      'review',
      'support',
      'marketing',
    ]);
    if (ports.settings === undefined) {
      throw new HttpError(503, 'NOTIFICATION_SETTINGS_UNAVAILABLE', '알림 설정을 사용할 수 없습니다.');
    }
    const current = readNotificationSettings(await ports.settings.get(actor.userId));
    let next;
    try {
      next = mergeNotificationSettings(current, body);
    } catch {
      throw new HttpError(400, 'INVALID_REQUEST', '알림 설정 값을 확인해 주세요.');
    }
    await ports.settings.save(actor.userId, next);
    sendData(response, next);
  });

  return router;
}
