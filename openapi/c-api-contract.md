# C API HTTP 계약 (D-21 A안, 2026-11-05)

사용자용 C API는 A/B와 같은 공통 HTTP 봉투를 사용한다. C 서비스 내부 DTO와 비즈니스 로직은 그대로이며, `src/c-app.ts` HTTP 경계에서만 정규화한다.

## 공통 봉투

성공:

```json
{ "data": { } }
```

목록 성공:

```json
{ "data": [ ] }
```

오류:

```json
{ "error": { "code": "FORBIDDEN", "message": "계약 당사자만 조회할 수 있습니다.", "requestId": "..." } }
```

- 모든 사용자용 C 응답은 `x-request-id` 헤더를 포함한다. 요청에 없으면 서버가 생성한다.
- 성공 상태 코드는 기존과 동일하게 `200`/`201`을 유지한다.
- 오류 상태 코드와 업무 의미는 기존과 동일하다. 500은 내부 예외 메시지를 노출하지 않고 `요청을 처리할 수 없습니다.`로 응답한다.
- C 서비스 오류에 `code`가 있으면 그 값을, 없으면 상태 코드 기반 기본 코드를 쓴다.

## 기본 오류 코드

| status | code |
|---|---|
| 400 | `INVALID_REQUEST` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `UNPROCESSABLE_ENTITY` |
| 503 | `SERVICE_UNAVAILABLE` |
| 500 | `INTERNAL_ERROR` |

예치 요청은 다음 세부 코드를 사용한다: `CLIENT_ONLY`, `CONTRACT_NOT_FOUND`, `CONTRACT_NOT_DEPOSITABLE`, `DEPOSIT_DEADLINE_EXPIRED`, `AMOUNT_MISMATCH`, `IDEMPOTENCY_KEY_REUSED`, `DEPOSIT_ALREADY_COMPLETED`, `FORBIDDEN`, `WEBHOOK_FORBIDDEN`, `WEBHOOK_AUTH_FAILED`, `INVALID_WEBHOOK_PAYLOAD`.

## 사용자용 C routes

| Method | Path | 성공 | 성공 DTO |
|---|---|---|---|
| POST | `/contracts/{contractId}/deposits` | 201 | `{ deposit: EscrowDeposit, isNew: boolean }` |
| POST | `/contracts/{contractId}/deposits/{depositId}/confirm` | 200 | `{ deposit, contract, installments }` — PG 승인 확인 후 완료 |
| GET | `/contracts/{contractId}/deposits` | 200 | `EscrowDeposit[]` |
| GET | `/me/payment-statements` | 200 | `{ simulated, transferNote, statements }` |
| GET | `/contracts/{contractId}/statement` | 200 | `ClientStatementView \| SupplierStatementView` |
| GET | `/contracts/{contractId}/installments` | 200 | `PaymentInstallment[]` |
| POST | `/installments/{installmentId}/tax-invoice-issued` | 200 | 세금계산서 발행 결과 |
| POST | `/installments/{installmentId}/deliveries` | 201 | `DeliveryEntity` |
| GET | `/installments/{installmentId}/deliveries` | 200 | `DeliveryEntity[]` |
| GET | `/deliveries/{deliveryId}` | 200 | `DeliveryEntity` |
| POST | `/contract-items/{contractItemId}/approve` | 200 | 승인 결과 |
| POST | `/contract-items/{contractItemId}/rework-requests` | 201 | 보완 요청 |
| GET | `/contract-items/{contractItemId}/rework-requests` | 200 | 보완 요청 목록 |
| POST | `/inspection-requests/{inspectionRequestId}/escalate` | 200 | 검수 이의 |
| POST | `/contracts/{contractId}/cancellation` | 201 | `CancellationRecord` |
| GET | `/contracts/{contractId}/cancellation` | 200 | `CancellationRecord` |
| POST | `/contracts/{contractId}/cancellation/agree` | 200 | `CancellationRecord` |
| POST | `/contracts/{contractId}/cancellation/object` | 200 | `CancellationRecord` |
| POST | `/contracts/{contractId}/reviews` | 201 | `ReviewEntity` |
| GET | `/contracts/{contractId}/reviews` | 200 | `PublicReviewDto[]` |
| GET | `/profiles/suppliers/{supplierId}/reviews` | 200 | `PublicReviewDto[]` |
| GET | `/projects/{projectId}/client-reviews` | 200 | `PublicReviewDto[]` |
| POST | `/uploads/presign` | 201 | 업로드 URL |
| GET | `/uploads/{fileId}/download` | 200 | 다운로드 URL |
| GET | `/admin/blocks` | 200 | `AdminBlockDetail[]`(설명·조건·단가 근거·태그·출처 프로젝트 수 포함) |
| POST | `/admin/blocks/{blockId}/actions` | 200 | 블록 action 결과 |
| GET | `/admin/deposits/held` | 200 | `AdminHeldDeposit[]` |
| POST | `/admin/deposits/{depositId}/resolve` | 200 | 예치 판정 결과 |
| GET | `/admin/inspection-requests/escalated` | 200 | `AdminEscalatedInspectionDetail[]`(당사자·조건·주장·이력·납품 포함) |
| POST | `/admin/inspection-requests/{inspectionRequestId}/decision` | 200 | 검수 판정 결과 |
| GET | `/admin/contracts/cancellation-queue` | 200 | `AdminCancellationContract[]` |
| POST | `/admin/contracts/{contractId}/cancellation/decide` | 200 | 취소 판정 결과 |
| POST | `/admin/contracts/{contractId}/settlement/mark-processed` | 200 | 정산 처리 결과 |
| POST | `/admin/installments/{installmentId}/release` | 200 | 수동 지급 결과(`PaymentInstallment`, 실제 이체 없음) |
| GET | `/admin/event-logs` | 200 | `EventLogEntity[]` |
| POST | `/admin/jobs/run` | 200 | `DueJobResult`(ADMIN 전용 수동 배치) |

**수동 정산 지급(D-29)**: `POST /admin/installments/{installmentId}/release`는 ADMIN 전용이며 body `{reason}`이 필수다. 실제 이체/환불 없이 구간을 `RELEASED`로 기록하고 감사 로그(`SETTLEMENT_MANUAL_RELEASED`)를 남긴다. 공급자 정산 계좌가 인증(`payoutVerifiedAt`)되어야 하고, 최종 구간은 중간 구간이 먼저 `RELEASED`여야 한다. 이미 지급된 구간 재요청은 400이다.

**수동 배치 실행(D-30)**: `POST /admin/jobs/run`은 ADMIN 전용이다. 누락 Toss 웹훅 복구를 포함한 due job을 한 번 실행하고 `{success, actionsCount, failures}`를 돌려준다. 상시 scheduler를 켜지 않은 staging에서 복구 경로를 검증하는 용도이며, 자동 실행을 뜻하지 않는다. 복구는 15분 주기·1분 window의 PENDING 예치만 조회한다.

**관리자 목록 DTO 확장(D-31)**: `GET /admin/reports`(B API)는 신고 기록에 `reporter`·`target`(id/role/displayName)와 `message`(body/createdAt/projectId/projectTitle)를 더한다. `GET /admin/blocks`와 `GET /admin/inspection-requests/escalated`는 위 표의 상세 필드를 더한다. 기존 필드는 유지하며 ADMIN 응답에만 적용한다.

## Webhook 예외

`POST /integrations/toss/payment-events`는 외부 PG 프로토콜이므로 공통 봉투를 적용하지 않는다. `PAYMENT_STATUS_CHANGED`를 수신하면 [Toss signature 규격](https://docs.tosspayments.com/reference/using-api/webhook-events)에 따라 원문 body와 `tosspayments-webhook-transmission-time`으로 `tosspayments-webhook-signature`의 v1 HMAC-SHA256을 검증한 뒤 정규화한다. 키는 Toss API 개별 연동의 보안 키(`TOSS_WEBHOOK_SECRET`, 64자리 hex)이며, 누락·불일치 서명은 401이다. 결제 완료는 서버 PG GET 결과가 저장된 orderId/paymentKey/금액과 일치할 때만 처리한다. 명시적 불일치는 HELD, 일시적인 PG 조회 장애나 조회 어댑터 부재는 HTTP 503과 PENDING으로 남겨 Toss 재전송을 허용한다. 자동 재전송은 Toss의 [웹훅 재시도 정책](https://docs.tosspayments.com/guides/v2/webhook)을 사용한다. 누락된 웹훅은 기존 due-job scheduler가 15분 age bucket의 PENDING 주문을 `GET /v1/payments/orders/{orderId}`로 확인해 복구한다. 주문 조회는 API 개별 `test_sk`/`live_sk`가 필요하고, 결제 없음은 PENDING 유지·DONE이 아닌 결과는 건너뛰며, 식별자/금액 불일치는 HELD다. scheduler 비활성 환경에서는 이 배치가 실행되지 않는다.

## 예치 상태

`EscrowDeposit.status`: `PENDING | HELD | COMPLETED | FAILED`(스키마 enum 기준). `POST /contracts/{id}/deposits`의 201은 **결제 요청 생성**이며 완료가 아니다. 실제 완료는 검증된 PG 콜백/재조회 후 `COMPLETED`로 바뀌고, 그 시점에 계약 `paymentStatus`/`totalDeposited`와 다른 보류 지원자 자동 거절이 갱신된다.

`POST /contracts/{contractId}/deposits/{depositId}/confirm`(D-25)은 Toss SDK 성공 리다이렉트 뒤 서버가 `POST /v1/payments/confirm`으로 승인을 확인하는 경로다. body는 `{ paymentKey, amount }`이며, `amount`는 서버에 저장된 예치 금액과 일치해야 한다. `PENDING` 예치만 대상이고 `HELD`는 운영자 판정 전용이다. 같은 `paymentKey` 재요청은 200 멱등, 완료 후 다른 키는 409다. 일시적인 PG 승인/재조회 실패는 `503 PG_UNAVAILABLE`로 예치를 `PENDING`에 유지해 재시도할 수 있고, 확인된 PG 근거가 없거나 불일치하면 `422 PAYMENT_VERIFICATION_FAILED`로 완료하지 않는다. `VITE_ENABLE_DEPOSIT`는 PAY-01~06 검증 전까지 OFF다.
