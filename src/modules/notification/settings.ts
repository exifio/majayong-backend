/** D-38: 알림 카테고리별 수신 설정. */
export interface NotificationSettings {
  readonly contract: boolean;
  readonly chat: boolean;
  readonly recruiting: boolean;
  readonly review: boolean;
  readonly support: boolean;
  readonly marketing: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  contract: true,
  chat: true,
  recruiting: true,
  review: true,
  support: true,
  // 마케팅은 선택 동의이므로 기본값은 수신하지 않는다.
  marketing: false,
};

const KEYS = Object.keys(DEFAULT_NOTIFICATION_SETTINGS) as Array<keyof NotificationSettings>;

export interface NotificationSettingsStore {
  get(userId: string): Promise<unknown>;
  save(userId: string, settings: NotificationSettings): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 저장된 JSON을 기본값 위에 덮어 읽는다. 손상된 값은 기본값으로 안전 실패한다. */
export function readNotificationSettings(raw: unknown): NotificationSettings {
  if (!isRecord(raw)) return DEFAULT_NOTIFICATION_SETTINGS;
  const result: Record<string, boolean> = { ...DEFAULT_NOTIFICATION_SETTINGS };
  for (const key of KEYS) {
    if (typeof raw[key] === "boolean") result[key] = raw[key] as boolean;
  }
  return result as unknown as NotificationSettings;
}

/** PATCH 입력은 boolean 필드만 허용하고, 없는 필드는 기존 값을 유지한다. */
export function mergeNotificationSettings(
  current: NotificationSettings,
  patch: unknown,
): NotificationSettings {
  if (!isRecord(patch)) throw new NotificationSettingsError("INVALID_REQUEST");
  const unknownKey = Object.keys(patch).find((key) => !KEYS.includes(key as keyof NotificationSettings));
  if (unknownKey !== undefined) throw new NotificationSettingsError("INVALID_REQUEST");
  const result: Record<string, boolean> = { ...current };
  for (const key of KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new NotificationSettingsError("INVALID_REQUEST");
    result[key] = value;
  }
  return result as unknown as NotificationSettings;
}

export class NotificationSettingsError extends Error {
  readonly status = 400;
  readonly code: string;

  constructor(code: string) {
    super("알림 설정 값을 확인해 주세요.");
    this.name = "NotificationSettingsError";
    this.code = code;
  }
}
