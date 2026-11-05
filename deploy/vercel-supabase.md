# Vercel Functions + Supabase PostgreSQL 배포 런북

- 백엔드 저장소: `https://github.com/exifio/majayong-backend`
- 배포 브랜치: `main`
- 이 문서는 Vercel/Supabase 기준이다. `deploy/staging.md`는 Railway 시절 기록이며 이 배포에서 사용하지 않는다.

## 1. 구성

```text
Browser
  → Vercel Frontend (majayong-frontend)
  → Vercel Function proxy /api/v1/*
  → Vercel Backend Function (majayong-backend)
  → Supabase PostgreSQL (private)
```

- 프론트엔드는 기존 `apps/web/api/v1/[...path].js` 프록시로 공개 HTTPS 백엔드에 전달한다.
- 백엔드는 Express 앱을 그대로 Vercel Function handler로 사용한다.
- Vercel Function은 DB에 직접 붙지 않고, Supabase의 Postgres 연결 문자열로 붙는다.
- Supabase Data API(PostgREST)는 공개하지 않는다. Prisma는 Postgres 연결만 사용한다.

## 2. Vercel 백엔드 프로젝트

기존 `majayong-deploy`(실패한 설정)를 재사용하지 않고 **새 프로젝트**를 만든다.

- Project name: `majayong-backend-staging`
- Git repository: `exifio/majayong-backend`
- Production branch: `main`
- Root Directory: `.`
- Framework Preset: `Other`
- Node.js: `22.x`
- Build Command: `npx prisma generate && npm run build`
- Output Directory: 비움
- Install Command: 기본값

`vercel.json`이 build/function 설정을 함께 정의한다.

```json
{
  "buildCommand": "npx prisma generate && npm run build",
  "functions": { "api/**/*.js": { "maxDuration": 60, "memory": 1024 } },
  "rewrites": [{ "source": "/health", "destination": "/api/health" }]
}
```

- `api/v1/[...path].js`가 `/api/v1/*`를 Express 앱으로 전달한다.
- Vercel 파일 라우터는 `[...path]`를 단일 세그먼트로만 매칭하므로 `vercel.json`의 `/api/v1/:path*` rewrite가 원래 경로를 `?path=`로 넘기고 핸들러가 복원한다. 이 rewrite를 제거하면 `/api/v1/auth/login` 같은 다중 세그먼트가 404가 된다.
- `api/health.js`는 `/health`를 200 `{data:{status:"ok"}}`로 응답한다.
- `src/index.ts`는 로컬 listen/스케줄러 전용이고, Vercel handler는 `app.listen`을 호출하지 않는다.
- PrismaClient는 `src/server-app.ts` module scope에서 한 번 생성한다.

## 3. Supabase PostgreSQL

- Supabase 프로젝트의 **Postgres 연결 문자열**을 사용한다.
- 런타임 `DATABASE_URL`: **Session Pooler**(5432) + `?connection_limit=1&sslmode=require`
  - Prisma interactive transaction(`$transaction`)이 Transaction Pooler(6543)에서 `P2028 Transaction not found`로 실패하는 것을 스테이징에서 확인했다. 초안 생성처럼 여러 쓰기를 한 트랜잭션으로 묶는 경로가 있으므로 런타임도 Session Pooler를 쓴다.
- 마이그레이션 `MIGRATION_DATABASE_URL`: **Direct connection**(5432) 우선. Direct가 IPv6/네트워크 문제로 불가하면 공식 문서에 따라 **Session Pooler**(5432, shared pooler)를 사용한다.
- Session Pooler는 prepared statement와 session state를 지원하므로 migration/pg_dump/런타임 interactive transaction에 사용할 수 있다. **Transaction Pooler(6543)는 migration과 interactive transaction에 사용하지 않는다.**
- Prisma 6은 PgBouncer transaction mode에서 prepared statement를 쓰지 않도록 `pgbouncer=true`를 사용한다. SSL은 `sslmode=require`를 사용한다.
- Pooler host/username은 Supabase Dashboard의 **Connect**에서 복사한다. `aws-[INDEX]-[REGION].pooler.supabase.com`의 index/region은 임의로 조합하지 않는다.
- Data API/anon key로 테이블을 공개하지 않는다. RLS/스키마 노출 설정을 확인한다.
- Vercel Function은 Supabase 내부 private network에 직접 붙는 것이 아니라, 공개 Postgres endpoint(또는 pooler)로 TLS 연결한다.

### migration·seed (Function 시작 시 실행 금지)

별도 배포/운영 단계에서 한 번만 실행한다.

```bash
MIGRATION_DATABASE_URL='postgresql://...:5432/postgres' npm run db:migrate:staging
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:seed:staging
```

- `prisma migrate deploy` 4개 migration 적용을 확인한다.
- `db:seed:staging`은 승인된 catalog block 36개를 upsert한다.
- Vercel Function의 cold start/매 요청에서 migration을 실행하지 않는다.
- 실패 시 배포를 중단하고, 이전 Vercel deployment로 rollback한다. DB migration은 forward-only이므로 배포 전 백업을 남긴다.

## 4. 환경변수 (값 제외)

필수:
`DATABASE_URL`, `MIGRATION_DATABASE_URL`(배포 단계에서만), `TOKEN_SECRET`, `PROFILE_DATA_KEY`, `PROJECT_DISCLOSURE_CONSENT_VERSION`, `SUPPLIER_NDA_VERSION`, `NODE_ENV=production`, `JOB_SCHEDULER_ENABLED=false`.

선택:
`OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_USD_TO_KRW_RATE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`.

결제 완료 검증 전 비활성:
`TOSS_SECRET_KEY`, `TOSS_SANDBOX_BASE_URL`, `TOSS_WEBHOOK_SECRET`.

FE Vercel:
`BACKEND_API_URL=https://<backend-domain>` (`/api/v1` 제외).

## 5. 스테이징 접근 보호

- Vercel 프로젝트에 Deployment Protection(Standard Protection 또는 Password Protection)을 적용한다.
- FE는 `apps/web/api/v1/[...path].js` **서버 함수 프록시**로 백엔드에 접근한다.
- 보호가 켜져 있으면 FE Vercel 프로젝트의 서버 환경변수에 `VERCEL_AUTOMATION_BYPASS_SECRET`을 두고, 프록시 요청에 `x-vercel-protection-bypass` 헤더를 추가한다. 이 값은 브라우저에 노출하지 않는다.
- 프록시가 보호를 통과하지 못하면 `BACKEND_API_URL`만으로는 401/403이 난다. 배포 후 실제 프록시 경로로 확인한다.

## 6. 검증

1. `GET https://<backend-domain>/health` 200
2. `POST /api/v1/auth/login` 200
3. `POST /api/v1/auth/refresh` 200 (refresh rotation)
4. `GET /api/v1/me` 200
5. 프로젝트·지원·채팅·알림·합의·계약·서명
6. C API `{data}`/`{error:{code,message,requestId}}` 봉투
7. `GET /api/v1/contracts/{id}/deposits` 200 `{data:[]}` 또는 PENDING
8. Vercel Function logs에 Prisma connection error/secret 노출이 없는지 확인
9. `api/v1/[...path].js`가 `/api/v1/auth/login` 같은 다중 세그먼트를 404 없이 처리하는지 확인

## 6. 제한·차단

- Vercel Function `maxDuration` 60초, `memory` 1024MB. 장시간 배치/대용량 작업은 별도 worker 필요.
- `JOB_SCHEDULER_ENABLED=false`이므로 서명·예치 기한 자동 결렬/마감 배치는 실행되지 않는다.
- Toss 실제 결제·webhook 완료는 비활성. 예치 요청은 PENDING까지만.
- 실제 송금·정산·환불, PDF 렌더링, 이메일 발송은 범위 밖/미연결.
- Supabase DB 연결 문자열과 Vercel 프로젝트 연결은 별도 승인·자격이 필요하다.
