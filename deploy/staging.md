# 백엔드 스테이징 배포 런북

기준 커밋: `22d0280`. 공식 로컬 서버: `http://localhost:3100`.

## 1. 권장 호스팅

**Railway + Railway PostgreSQL**을 권장한다.

- Node.js 22 LTS (`.nvmrc`), Express 5 + Prisma 6의 장기 실행 프로세스에 맞다.
- 서버리스(Vercel Functions)보다 Prisma 연결·스케줄러·긴 요청에 적합하다.
- PostgreSQL은 같은 Railway 프로젝트의 private network로 붙이고, 외부에는 공개하지 않는다.
- 스테이징은 **1 replica**로 운영한다. 스케줄러 중복 실행과 migration 경합을 막는다.

대안: Render/Fly.io + 관리형 PostgreSQL. 구조는 동일하다.

## 2. 빌드·시작·health

`railway.json` 기준:

```text
build: npx prisma generate && npm run build
start: npm run db:migrate && npm start
healthcheck: GET /health (200)
```

- `PORT`는 플랫폼이 주입한다. 코드는 `process.env.PORT ?? 3000`을 사용한다.
- migration 실패 시 `npm run db:migrate`가 실패하고 프로세스가 뜨지 않아 배포가 실패한다.
- 런타임에 `prisma` CLI가 필요하므로 `npm ci --omit=dev`만으로 시작하지 않는다. Nixpacks 기본 설치(빌드용 devDependencies 포함)를 사용하거나 migration을 pre-deploy 단계로 분리한다.
- `GET /health`는 인증 없이 `{data:{status:"ok"}}`를 반환한다.
- 데이터는 PostgreSQL에만 있으므로 재시작해도 유지된다. access token은 `TOKEN_SECRET`이 같으면 유효하다.

## 3. 필수 환경변수 (값 제외)

| 이름 | 필수 | 비고 |
|---|---|---|
| `DATABASE_URL` | 예 | Railway Postgres private URL |
| `TOKEN_SECRET` | 예 | 32바이트 이상, staging 전용 |
| `PROFILE_DATA_KEY` | 예 | base64 32바이트, staging 전용 |
| `PROJECT_DISCLOSURE_CONSENT_VERSION` | 예 | `project-disclosure-v0.1-draft` |
| `SUPPLIER_NDA_VERSION` | 예 | staging NDA 버전 |
| `NODE_ENV` | 예 | `production` |
| `JOB_SCHEDULER_ENABLED` | 예 | 1차 `false` (1 replica 확인 후 `true`) |
| `OPENAI_*` | 선택 | 없으면 DEFAULT_DRAFT/seed 사용 |
| `GOOGLE_*` | 선택 | 이메일 로그인은 없어도 됨 |
| `SUPABASE_*` | 선택 | 없으면 파일 API 503 |
| `TOSS_*` | **비활성** | 실제 결제 완료 검증 전까지 unset |

FE 쪽 `BACKEND_API_URL`은 Vercel 서버 함수에만 설정한다(값은 백엔드 base URL, `/api/v1` 제외).

## 4. 스테이징 DB 계획

- Railway PostgreSQL 별도 인스턴스. 로컬 DB·fixture·계정을 복사하지 않는다.
- 접근: Railway private network만 사용. 공개 TCP proxy를 만들지 않는다.
- migration: `npm run db:migrate` (= `prisma migrate deploy`). 배포 전 `pg_dump` 백업을 남긴다.
- 초기화: staging에서만 `prisma migrate reset` 허용. 운영 DB에는 금지.
- 백업: 배포 전 `pg_dump` + Railway 백업 정책 확인. 덤프는 Git 밖에 보관한다.
- 카탈로그 seed: `npm run build` 후 `node scripts/seed-staging.mjs` (기본 초안 블록 36개).
- 데모 계정/프로젝트: staging에서 새로 만든다.
  1. `POST /auth/register`로 CLIENT/SUPPLIER 생성 (staging 전용 비밀번호).
  2. `PATCH /me/client-profile`에 `businessName`·`industryField` 설정.
  3. `POST /drafts` `{ "entryType": "DEFAULT_DRAFT" }` → `POST /drafts/{id}/publish`로 프로젝트 생성.
  4. SUPPLIER는 `PATCH /me/supplier-profile` `{displayName, ndaConsent:true}` 후 상세 열람·지원.
- 로컬 `accounts.json`/`fixture.json`/DB 덤프는 staging에 올리지 않는다.

## 5. 프론트엔드 연결

FE는 `apps/web/api/v1/[...path].js` Vercel Function 프록시를 사용한다.

- Vercel 환경변수: `BACKEND_API_URL=https://<staging-backend>` (`/api/v1` 제외).
- 브라우저는 same-origin `/api/v1/*`로 호출하므로 **CORS 불필요**.
- 프록시는 `authorization`, `content-type`, `accept`를 전달하고 `x-request-id`를 echo한다.
- 인증은 Bearer access token + body의 refresh token이며 쿠키를 쓰지 않는다.
- 직접 cross-origin 호출로 바꾸면 CORS 허용 Origin 설정이 필요하다(현재 미구현).
- `VITE_USE_MOCK=false`, staging flag(`VITE_ENABLE_*`)를 실제 연동 범위에 맞춘다.

## 6. 1차 스테이징 범위

포함: 인증/프로필, 프로젝트·지원, 채팅·알림, 합의·계약, 양측 서명, 예치 **상태 조회/요청(PENDING)**.

제외/비활성: 실제 송금·환불, PDF 렌더링, 이메일 발송(비밀번호 재설정/이메일 변경), 파일 저장소(미설정 시 503), 상시 scheduler/worker.

`POST /contracts/{id}/deposits`의 201은 **PENDING 요청**이며 완료가 아니다. `paymentStatus`/`totalDeposited`가 바뀌고 자동 거절이 일어나는 시점은 검증된 webhook 또는 사용자 confirm의 PG 재조회 완료 후다.

### Toss 웹훅 등록

- 등록 주소는 **백엔드 도메인**이다: `https://<backend-domain>/api/v1/integrations/toss/payment-events`. 이벤트는 `PAYMENT_STATUS_CHANGED`.
- 프론트 도메인(`majayong.vercel.app/api/v1/...`)으로 등록하면 실패한다. `apps/web/api/proxy.js`가 `authorization`·`content-type`·`accept`만 넘기고 본문을 `JSON.stringify`로 다시 만들어 서명 헤더가 사라지고 raw body가 바뀐다 → 백엔드가 401.
- 백엔드는 `tosspayments-webhook-signature`·`tosspayments-webhook-transmission-time` 헤더로 원본 본문 HMAC을 검증한다. 키는 `TOSS_WEBHOOK_SECRET`이며 바꾸면 재배포가 필요하다.
- 검증 기록(2026-11-07, staging): 정상 서명 200 `COMPLETED`, 위조 서명 401, 재전송 200 멱등. **등록된 실제 URL은 저장소에 기록이 없다** — 등록/변경 시 이 절에 주소와 일자를 남긴다.
- 누락 웹훅 복구: Vercel Cron 15분 `/api/v1/internal/jobs/run` 또는 ADMIN 수동 `POST /admin/jobs/run`. staging은 상시 worker가 없어 수동 실행으로만 검증했다.

## 7. 배포 후 확인

1. `GET /health` 200.
2. `POST /auth/login` staging 계정 200.
3. `GET /me` 200, `GET /projects`(SUPPLIER) 200.
4. `GET /me/chats`, `GET /me/notifications` 200.
5. `GET /me/contracts` 200, `GET /contracts/{id}` 200.
6. `GET /contracts/{id}/deposits` 200 `{data:[]}` 또는 PENDING.
7. C 오류 봉투 `{error:{code,message,requestId}}`와 `x-request-id` 확인.
8. `JOB_SCHEDULER_ENABLED=true`로 바꾸기 전 1 replica인지 확인.

## 8. 차단 요소·남은 작업

- Toss sandbox 서명 웹훅은 검증됐다(2026-11-07). 남은 차단은 상시 scheduler/worker 부재와 **Toss 대시보드의 실제 등록 주소 미기록**이다. 운영 결제는 유효한 키 확인 전 켜지 않는다.
- 이메일 발송 어댑터 미연결(`DELIVERY_UNAVAILABLE`).
- OpenAI 미설정 시 AI 생성 대신 DEFAULT_DRAFT/seed만 사용.
- Supabase 미설정 시 파일 API 503.
- 스케줄러는 프로세스 내 `setInterval`이므로 다중 replica/재시작 보장은 미검증.
- G3-02 A/C 전수 검증은 PARTIAL.
