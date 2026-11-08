-- D-38: 알림 설정. NULL이면 기본값(모두 수신, 마케팅 제외)을 사용한다.
ALTER TABLE "users" ADD COLUMN "notificationSettings" JSONB;
