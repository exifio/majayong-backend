# Majayong — 개발 및 배포 안정화 안내

기준: 2026-11-05 · v0.7.1 문서 적용본. 이 폴더는 **단일 통합 백엔드**다. Node.js 22, Express 5, TypeScript, Prisma/PostgreSQL을 사용한다. React 화면 소스와 프런트엔드 패키지는 이 폴더에 없다.

마자용은 AI 화면 초안을 고쳐 명세를 만들고 공급자의 견적·문의 채팅·합의·계약·검수로 연결하는 플랫폼이다. 배포 화면은 <https://majayong-frontend.vercel.app/>이며, 2026-11-05 [브라우저 감사](docs/DEPLOYMENT_AUDIT.md)는 공개 화면과 무인증 API 경계만 확인했다. 인증 후 기능과 배포 sandbox 흐름은 별도 검증이 필요하다.

## 작업을 시작하는 문서

| 문서 | 역할 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI/개발자의 공통 규칙, 보안, 인접 테스트, 검증·업로드 제한 |
| [docs/PRD.md](docs/PRD.md) | v0.7.1 안정화 수용 기준 + 변경하지 않은 v0.7 원문 부록 |
| [docs/DESIGN.md](docs/DESIGN.md) | 변경 대상 화면의 입력·동의·오류·표현·접근성 |
| [docs/PLAN.md](docs/PLAN.md) | 작업 순서·의존성·시연/릴리스 게이트 |
| [docs/TASKS.md](docs/TASKS.md) | Now/Next/Later/Done, 담당 영역·수용 기준·기존 백엔드 잔여 작업 |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | HTTP 경계와 승인된 API 변경; 상세는 OpenAPI와 실제 라우터 |

`AGENTS.md` → 이 파일 → PRD 변경부 → DESIGN → PLAN → TASKS를 읽고 작업 ID 하나를 선택한다. 기존 구현·테스트를 검색한 뒤 변경 범위를 정한다. FE 티켓은 T-00에서 실제 프런트엔드 저장소와 배포 소스를 확인한 후 그 저장소에서 수행한다.

## 현재 폴더에서 확인한 사실

| 항목 | 기준과 한계 |
|---|---|
| Git | 이 폴더는 Git 저장소이며 `main`이 `origin/main`을 추적한다. 문서의 `c82e68e`는 과거 Gate 2 기준이며 현재 배포 SHA가 아니다. |
| 런타임 | [src/server-app.ts](src/server-app.ts)가 A/B/C 서비스를 조립하고 [src/index.ts](src/index.ts)가 listen·선택적 scheduler·종료 처리를 한다. |
| API | `/api/v1`, Bearer 인증. 공급자 목록/상세는 SUPPLIER 권한, 상세는 유효한 NDA가 필요하다. |
| health | 로컬 앱 `/health`와 [api/health.js](api/health.js)는 JSON을 반환하도록 정의돼 있다. health 응답은 DB/외부 provider 상태까지 증명하지 않는다. |
| Vercel | [vercel.json](vercel.json)이 `/health`와 `/api/v1/:path*`를 function으로 rewrite한다. 실제 프런트엔드 배포에 같은 설정이 적용됐는지는 T-00/T-10에서 확인한다. |
| 포트 | `PORT` 환경 변수, 기본 3000. 3100/3101은 과거 로컬 검증 인스턴스 기록이며 고정 배포 주소가 아니다. |
| 결제 | sandbox/검증된 mock. 실제 자동 이체·환불 API는 범위 밖이며 수동 운영을 구분한다. |
| 테스트 | A/B/C/통합 테스트는 현재 `src` 인접형 수집 패턴을 사용한다. [테스트 실행 기준](docs/TESTING.md)을 확인한다. |

이 표는 파일 확인 결과다. 이번 문서 정리에서 서버·DB·배포·테스트를 실행해 새 PASS를 얻은 것은 아니다.

## 로컬 실행

Node.js 22와 별도 PostgreSQL 개발 환경이 필요하다. 기존 `.env`를 덮어쓰지 말고, 최초 설정 시 `.env.example`의 키 목록을 참고해 로컬 값을 준비한다. `DATABASE_URL`, 32바이트 이상의 `TOKEN_SECRET`이 필요하고 실제 값은 출력/커밋하지 않는다.

```bash
npm ci
npm run db:generate
npm run dev
```

`dev`는 빌드 후 `node --env-file=.env dist/index.js`를 실행한다. `npm start`는 이미 빌드된 서버를 시작하며 `.env`를 자동 로드하지 않는다. 마이그레이션이 필요하면 [DB 이전 기준](docs/DATA_MIGRATION.md)에 따라 대상 DB·기존 데이터·승인을 먼저 확인한다. `npm run db:migrate`는 현재 지정된 DB에 적용하므로 실행 절차에 무조건 끼워 넣지 않는다.

## 검사 명령

| 명령 | 의미 / 전제 |
|---|---|
| `npm run test:a` | Jest, `src/**/*.jest.test.ts`; A DB 테스트는 전용 로컬 `majayong_a00_test`와 `TEST_DATABASE_URL`/`DATABASE_URL` 필요 |
| `npm run test:b` | node:test, `src`/`openapi`의 `b-*.test.ts` |
| `npm run test:c` | node:test, `src`의 `c??-*.test.ts` |
| `npm run test:integration` | node:test, `src/**/*.int.test.ts`; DB 없는 Prisma skip은 PASS 아님 |
| `npm test` | B → C → A. 통합 테스트는 포함하지 않음 |
| `npm run test:typecheck` / `npm run typecheck` | 테스트 포함 / 소스 타입 검사 |
| `npm run build` | TypeScript 빌드; `src/**/*.test.ts` 제외 |
| `npm run db:validate` | Prisma 스키마 검증; 마이그레이션·실DB 검증을 뜻하지 않음 |
| `npm run db:verify:b` | 마이그레이션한 별도 테스트 PostgreSQL의 B 제약 검사 |
| `npm run check:rules` | Git 추적 파일 기반 정적 금지 패턴 검사; `.git` 없는 현재 복사본에서는 실행 전제 미충족 |

`lint`, `test:node`, `test:coverage`는 현재 `package.json`에 없다. 작업 시작 시 scripts를 다시 읽는다. 코드 변경은 관련 검사부터 수행하고 DB·PG·보안·배치 변경은 격리 DB의 경합/롤백 검증을 포함한다. 문서 전용 변경은 링크·출처·해시를 검증한다.

## 제품·API·DB 참고 자료

- [원본 PRD](docs/sources/PRD_v0.7.md), [ERD](docs/sources/ERD_v0.7.md), [원본 Prisma](docs/sources/schema_v0.7.prisma), [체크섬](docs/SOURCES_SHA256.txt)은 보존한다. `docs/PRD.md` 부록은 원본 PRD와 바이트 단위로 동일해야 한다.
- [API 인벤토리](docs/API_INDEX.md), [B 중심 OpenAPI](openapi/openapi.yaml), [A 상세 계약](openapi/a-project-detail.yaml), [C HTTP 계약](openapi/c-api-contract.md), [결정 기록](docs/DECISIONS.md)을 함께 확인한다. B YAML 하나가 전체 118개 작업의 완성 명세는 아니다.
- [DB 이전](docs/DATA_MIGRATION.md), [현재 구조 안내](docs/ARCHITECTURE.md), [코드 기준 안내](docs/CODE_STANDARDS.md)는 관련 작업에 필요한 보조 문서다.
- [기존 검증 기록](docs/VERIFICATION.md)과 A/BC operation status 등은 당시 실행 증거다. 현재 TASKS의 상태와 배포 검증을 대신하지 않는다. D-21은 승인·구현 기록이 있으므로 오류 봉투를 새로 만들기 전에 확인한다. D-22는 결정 대기다.

## 현재 시작점과 보관함

T-00에서 실제 프런트/백엔드 소스·배포 버전을 확인한다. T-01/02는 가입·재설정 초기값, T-03/04는 정책·결제 표현, T-05/08/09/11은 승인된 환경의 역할별 통합 검증이다. 기존 **G3-02 API/보안 전수 대조와 G3-04 스테이징/배치 검증도 남아 있다.** 새 안정화 작업표가 완료된 백엔드 구현을 초기화하지 않는다.

기존 가이드·계획·작업표·Gate 2 스냅샷은 [2026-11-05 보관함](docs/old/2026-11-05-before-v0.7.1/ARCHIVE.md)에 원문과 SHA-256으로 보존했다. 전체 과거 문서 목록은 [docs/old/README.md](docs/old/README.md)를 본다. Desktop에서 받은 다섯 원본 파일은 그대로 두고 이 폴더용 경로·명령·잔여 작업을 적용본에 반영했다.

내부 PRD/작업표/감사/원본/보관함은 local-only다. 이 정리는 GitHub 공유·커밋·푸시·배포 승인이 아니며 [업로드 제한](AGENTS.md#7-github-업로드-제한)을 따른다.
