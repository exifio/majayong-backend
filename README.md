# Majayong Backend — 개발 문서 v0.7.3

마자용은 AI 화면 초안을 고쳐 명세를 만들고 공급자의 견적·채팅·계약·검수로 연결하는 플랫폼이다. 이 저장소는 Node.js 22, Express 5, TypeScript, Prisma/PostgreSQL 기반의 단일 통합 백엔드다. 프런트엔드 화면 소스는 별도 저장소에서 관리한다.

## 작업 문서 6개

| 문서 | 관리하는 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | 작업·코딩·보안·테스트·공유 규칙 |
| [README.md](README.md) | 설치·실행 명령과 문서 지도 |
| [docs/PRD.md](docs/PRD.md) | 제품 범위·정책·수용 기준·현재 결정 |
| [docs/DESIGN.md](docs/DESIGN.md) | 시스템·API·DB·UI 상태 설계 |
| [docs/PLAN.md](docs/PLAN.md) | 구현 순서·의존성·릴리스 조건 |
| [docs/TASKS.md](docs/TASKS.md) | 현재 할 일·진행 상태·검증 결과 |

처음에는 AGENTS와 이 파일을 읽고, PRD → DESIGN → PLAN → TASKS에서 작업 ID를 고른다. 이후에는 그 작업에 필요한 절과 코드/계약만 확인한다. 현재 브랜치·HEAD·배포 상태는 작업 시작 시 직접 확인한다.

> `docs/`와 `AGENTS.md`는 내부 작업 기록이라 공유 승인 전에는 Git에 올리지 않는다(AGENTS §6). 그래서 원격 저장소를 clone하면 위 링크가 404일 수 있다. 진행 상태는 로컬 작업 트리의 `docs/TASKS.md`가 기준이다.

## 반영한 입력과 시작 순서

2026-11-05 전달된 v0.7.3 문서 12개의 요구사항·디자인 분류·33개 티켓을 위 6개 문서에 통합했다. 기본/분리 작업표는 같은 ID의 다른 보기이므로 TASKS 하나만 갱신한다. 원본과 적용 차이는 [입력·보관 기록](docs/old/2026-11-05-v0.7.3-import/ARCHIVE.md)에 있다.

이 저장소에서는 TASKS의 BE 티켓을 선택한다. FE 티켓은 실제 FE 저장소에서, 공동 계약·실HTTP 검증은 Integration 범위에서 진행한다. 첫 순서는 INT-00 → BE-00/FE-00 → BE-01 → FE-01/02다. 문의와 PG의 선후 관계는 PLAN을 따른다. 이번 반영은 문서 작업이며 33개 기능 티켓은 완료 처리하지 않았다.

입력 문서는 FE f9427a9 / BE a188fb2 / 디자인 4360783을 기준으로 한다. 이번 확인 시점의 로컬 BE는 main@2dedfa2, 이웃 FE는 main@aaa93ae다(2026-11-08). API v1.0.1은 더 이전 FE 97c9112를 참조한다. 배포 버전은 별도로 확인해야 한다.

## 로컬 실행

Node.js 22와 별도 PostgreSQL 개발 환경을 준비한다. 기존 `.env`를 덮어쓰지 말고 `.env.example`의 키 목록을 참고해 로컬 값을 설정한다. `DATABASE_URL`과 32바이트 이상 `TOKEN_SECRET`이 필요하며 값을 출력/커밋하지 않는다.

```bash
npm ci
npm run db:generate
npm run dev
```

`dev`는 빌드 후 `.env`를 로드해 서버를 실행한다. `npm start`는 빌드된 `dist/index.js`를 실행하며 환경 변수는 실행 환경에서 전달한다. `PORT` 기본값은 3000이다. 마이그레이션은 [DESIGN의 DB 이전 절](docs/DESIGN.md#4-db-이전과-보안)을 읽고 대상/기존 데이터/승인을 확인한 뒤 별도로 수행한다.

데모/시연 fixture는 `npm run db:seed:demo -- --dry-run`으로 계획만 확인하고, 로컬 `*_test`/`*_check`/`*_staging` DB에서만 `--reset`으로 A(모집·지원3·채팅)/B(예치·납품) 세트를 만들거나 지운다. 운영·공유 DB는 guard가 거부하며 `ALLOW_DEMO_SEED=1` 없이는 실행되지 않는다. 이어서 `npm run build` 후 `DEMO_PASSWORD=... npm run db:seed:demo:accounts`를 실행하면 `demo.client@majayong.local`·`demo.supplier@majayong.local`·`demo.admin@majayong.local`로 로그인할 수 있고, 앞의 두 계정은 A·B세트의 당사자라 시연 데이터가 그대로 보인다.

## 검사 명령

| 명령 | 실제 범위 |
|---|---|
| `npm run test:a` | Jest, `src/**/*.jest.test.ts`; A DB 테스트는 로컬 `majayong_a00_test` 및 해당 TEST_DATABASE_URL/DATABASE_URL 필요 |
| `npm run test:b` | node:test, `src`/`openapi`의 `*.b.test.ts` |
| `npm run test:c` | node:test, `src`의 `*.c.test.ts` |
| `npm run test:integration` | node:test, `src/**/*.int.test.ts`; DB 없는 Prisma skip는 PASS 아님 |
| `npm test` | B → C → A, integration 제외 |
| `npm run test:typecheck` / `npm run typecheck` | 테스트 포함 / 소스 타입 검사 |
| `npm run build` | TypeScript 빌드, 소스의 테스트 파일 제외 |
| `npm run db:validate` | Prisma 스키마 검증, 실DB 적용 검증과 별개 |
| `npm run db:verify:b` | 마이그레이션한 별도 테스트 PG의 제약 검사 |
| `npm run check:rules` | Git 추적 파일의 일부 금지 패턴 검사 |

현재 lint 스크립트는 없다. 실행 전 최신 `package.json`을 확인하고 필요한 범위만 검사한다.

## FE 저장소에서 사용할 명령

별도 FE는 React/Vite·pnpm 워크스페이스다. 로컬 사본의 package.json에서 `pnpm install`, `pnpm dev`, `pnpm typecheck`, `pnpm test`, `pnpm build`를 확인했다. 해당 FE 폴더에서만 실행하고, 평소에는 변경한 파일의 Vitest 범위 검사부터 수행한다. 이 BE 저장소에서 FE 명령을 실행하거나 FE 소스를 새로 만들지 않는다.

## 계약·원본·이력

- 최신 [API v1.0.1 설명](docs/sources/API_SPEC_v1.0.1_demo_stabilization.md)·[PDF](docs/sources/API_SPEC_v1.0.1_demo_stabilization.pdf)·[YAML](docs/sources/API_SPEC_v1.0.1_demo_stabilization.yaml)은 새 출처 자료다. 업무 119개 + health 1개를 기록하지만 일부 DTO·실HTTP는 미검증이다. 기존 실행 계약을 덮어쓴 것이 아니다.
- [OpenAPI](openapi/openapi.yaml), [A 상세 계약](openapi/a-project-detail.yaml), [C 계약](openapi/c-api-contract.md), [원본 API 인벤토리](openapi/API_INDEX.md)는 API 자료다. 전체 계약 범위와 사용법은 DESIGN에 있다.
- 실행 DB는 [Prisma 스키마](prisma/schema.prisma)와 `prisma/migrations/`다. 변경 전 원본 [ERD](docs/sources/ERD_v0.7.md)·[스키마](docs/sources/schema_v0.7.prisma)와 대조한다.
- [원본 PRD](docs/sources/PRD_v0.7.md), RFP/PDF 등은 `docs/sources/`에 보존한다. 체크섬은 `docs`에서 `sha256sum -c SOURCES_SHA256.txt`로 확인한다.
- 과거 지시·결정·감사·실행 결과는 [docs/old/README.md](docs/old/README.md)에 보관한다. 작업 기준과 과거 기록을 구분한다.

`openapi/API_INDEX.md`도 내부 원본에서 파생한 로컬 전용 자료다. 위치를 바꾼 것이 GitHub 공유 승인을 뜻하지 않는다.

배포 화면: <https://majayong-frontend.vercel.app/>. 현재 검증 범위와 남은 일은 TASKS에서 관리한다. 내부 문서 공유는 AGENTS의 업로드 제한을 따른다.
