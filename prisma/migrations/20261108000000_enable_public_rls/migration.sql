-- public 스키마 테이블은 서버(Prisma)만 사용한다. anon/authenticated에는 grant가 없고,
-- Supabase advisor의 `rls_disabled_in_public`(ERROR)를 없애기 위해 RLS를 켠다.
-- 정책은 추가하지 않는다: 비소유·비superuser 역할은 전부 거부하는 것이 의도다.
-- 테이블 소유자(postgres/majayong_app)와 superuser는 RLS를 우회하므로 Prisma 쿼리는 영향이 없다.
-- _prisma_migrations도 소유자(postgres)가 migrate를 실행하므로 함께 켠다.

ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "block_catalog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bookmarks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_utterances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "draft_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "escrow_deposits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "file_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inspection_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_installments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spec_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_inquiries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
