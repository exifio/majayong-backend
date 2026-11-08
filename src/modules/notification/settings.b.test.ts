import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  mergeNotificationSettings,
  readNotificationSettings,
} from './settings.js';

describe('B-06-D38 알림 설정', () => {
  it('저장값이 없거나 손상되면 기본값을 쓴다', () => {
    assert.deepEqual(readNotificationSettings(null), DEFAULT_NOTIFICATION_SETTINGS);
    assert.deepEqual(readNotificationSettings({ contract: 'yes' }), DEFAULT_NOTIFICATION_SETTINGS);
    assert.equal(readNotificationSettings({ marketing: true }).marketing, true);
  });

  it('PATCH는 boolean 필드만 반영하고 나머지는 유지한다', () => {
    const merged = mergeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS, {
      chat: false,
      marketing: true,
    });
    assert.equal(merged.chat, false);
    assert.equal(merged.marketing, true);
    assert.equal(merged.contract, true);
  });

  it('알 수 없는 키나 boolean이 아닌 값은 거부한다', () => {
    assert.throws(() => mergeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS, { unknown: true }));
    assert.throws(() => mergeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS, { contract: 1 }));
    assert.throws(() => mergeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS, null));
  });
});
