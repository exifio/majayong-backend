/** D-38: 알림 설정 저장 어댑터. `users.notificationSettings` JSON 컬럼만 사용한다. */
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettingsStore } from './settings.js';

export interface NotificationSettingsDb {
  readonly user: {
    findUnique(input: {
      readonly where: { readonly id: string };
      readonly select: { readonly notificationSettings: true };
    }): Promise<{ readonly notificationSettings: unknown } | null>;
    update(input: {
      readonly where: { readonly id: string };
      readonly data: { readonly notificationSettings: Record<string, boolean> };
    }): Promise<unknown>;
  };
}

export function createPrismaNotificationSettingsStore(
  db: NotificationSettingsDb,
): NotificationSettingsStore {
  return {
    async get(userId) {
      const row = await db.user.findUnique({
        where: { id: userId },
        select: { notificationSettings: true },
      });
      return row?.notificationSettings ?? DEFAULT_NOTIFICATION_SETTINGS;
    },
    async save(userId, settings) {
      await db.user.update({
        where: { id: userId },
        data: { notificationSettings: { ...settings } },
      });
    },
  };
}
