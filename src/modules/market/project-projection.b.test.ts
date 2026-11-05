import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  APPLICATION_TRANSITIONS,
  ApplicationAccessError,
  applicationDisplayStatus,
  requireApplicationParty,
} from '../application/dto.ts';
import {
  CONTRACT_DB_STATUSES,
  CONTRACT_DISPLAY_STATUSES,
  CONTRACT_TRANSITIONS,
  deriveContractDisplayStatus,
} from '../contract/display-status.ts';
import {
  MarketError,
  PublicProjectContractError,
  errorResponse,
  readPublicProject,
  toPublicProjectSummary,
  type ProjectReadPort,
} from './public-project.ts';
import {
  baseProject,
  contractStatusInput,
  createTestClock,
  projectDetail,
} from '../../../tests/b/fixtures.ts';

const PROJECT_READ_INPUT = { projectId: 'prj-1', viewerId: 'supplier-1' };

function portReturning(response: unknown): ProjectReadPort {
  return { findPublicProject: async () => response };
}

describe('B-00-T01 Project 공개 projection', () => {
  it('공개 projection에 없는 필드는 UNKNOWN_FIELD 계약 오류다', () => {
    // 실행 및 확인
    assert.throws(
      () => toPublicProjectSummary({ ...baseProject(), internalNote: 'not public' }),
      (error: unknown) =>
        error instanceof PublicProjectContractError &&
        error.status === 502 &&
        error.reason === 'UNKNOWN_FIELD' &&
        error.field === 'internalNote',
    );
  });

  it('민감 필드는 값과 무관하게 SENSITIVE_FIELD로 거부한다', () => {
    // 준비
    const sensitiveFields = [
      'clientEmail',
      'unitPrice',
      'aiUnitPrice',
      'clientUtterance',
      'payoutAccount',
    ];

    // 확인
    for (const field of sensitiveFields) {
      assert.throws(
        () => toPublicProjectSummary({ ...baseProject(), [field]: 'secret-value' }),
        (error: unknown) =>
          error instanceof PublicProjectContractError &&
          error.reason === 'SENSITIVE_FIELD' &&
          error.field === field,
      );
    }
  });

  it('검증된 응답에는 민감 필드가 남지 않는다', () => {
    // 실행
    const summary = toPublicProjectSummary(baseProject());
    // 준비
    const serialized = JSON.stringify(summary);

    // 확인
    assert.equal(serialized.includes('secret-value'), false);
    assert.equal('unitPrice' in summary, false);
    assert.equal('clientEmail' in summary, false);
  });

  it('상세 projection fixture는 SpecItem versionNo를 포함한다', () => {
    // 준비
    const detail = projectDetail();

    // 확인
    assert.equal(detail.currentSpecVersion, 1);
    assert.equal(detail.specItems.length, detail.specItemCount);
    assert.equal(detail.specItems[0]?.versionNo, 1);
  });
});

describe('B-00-T02 A 서비스 응답 없음', () => {
  it('null/undefined/예외는 계약된 503 PROJECT_READ_UNAVAILABLE로 매핑한다', async () => {
    // 준비
    const expected = (error: unknown): boolean =>
      error instanceof MarketError &&
      error.status === 503 &&
      error.code === 'PROJECT_READ_UNAVAILABLE';

    // 실행 및 확인
    await assert.rejects(readPublicProject(portReturning(null), PROJECT_READ_INPUT), expected);
    await assert.rejects(readPublicProject(portReturning(undefined), PROJECT_READ_INPUT), expected);
    await assert.rejects(
      readPublicProject(
        {
          findPublicProject: async () => {
            throw new Error('A service timeout');
          },
        },
        PROJECT_READ_INPUT,
      ),
      expected,
    );
  });

  it('A가 NOT_FOUND를 주면 404 PROJECT_NOT_FOUND다', async () => {
    // 실행 및 확인
    await assert.rejects(
      readPublicProject(portReturning({ kind: 'NOT_FOUND' }), PROJECT_READ_INPUT),
      (error: unknown) =>
        error instanceof MarketError &&
        error.status === 404 &&
        error.code === 'PROJECT_NOT_FOUND',
    );
  });

  it('정상 응답은 공개 projection으로 좁혀 반환한다', async () => {
    // 실행
    const project = await readPublicProject(
      portReturning({ kind: 'FOUND', project: baseProject() }),
      PROJECT_READ_INPUT,
    );

    // 확인
    assert.equal(project.id, 'prj-1');
    assert.equal(project.currentSpecVersion, 1);
    assert.equal('unitPrice' in project, false);
  });

  it('오류 응답은 { error: { code, message, requestId } } 계약을 지킨다', () => {
    // 실행
    const body = errorResponse(
      new MarketError(503, 'PROJECT_READ_UNAVAILABLE', '프로젝트 정보를 불러오지 못했습니다.'),
      'req-b00',
    );

    // 확인
    assert.deepEqual(body, {
      error: {
        code: 'PROJECT_READ_UNAVAILABLE',
        message: '프로젝트 정보를 불러오지 못했습니다.',
        requestId: 'req-b00',
      },
    });

    // 실행
    const ownershipBody = errorResponse(new ApplicationAccessError(), 'req-owner');
    // 확인
    assert.deepEqual(ownershipBody, {
      error: {
        code: 'APPLICATION_NOT_FOUND',
        message: '지원 정보를 찾을 수 없습니다.',
        requestId: 'req-owner',
      },
    });
  });
});

describe('B-00-T03 계약 표시 상태 파생', () => {
  it('화면 표시 상태는 DB ContractStatus enum과 겹치지 않는다', () => {
    // 준비
    const dbStatuses: readonly string[] = CONTRACT_DB_STATUSES;

    // 확인
    for (const displayStatus of CONTRACT_DISPLAY_STATUSES) {
      assert.equal(dbStatuses.includes(displayStatus), false);
    }
  });

  it('계약 상태 표는 예치 전 취소 요청을 허용하지 않는다', () => {
    // 실행 및 확인
    assert.deepEqual(CONTRACT_TRANSITIONS.PENDING_CONSENT, ['ACTIVE', 'CANCELLED']);
    assert.deepEqual(CONTRACT_TRANSITIONS.CANCEL_REQUESTED, ['CANCELLED']);
    assert.equal(
      CONTRACT_TRANSITIONS.ACTIVE.some((status) => status === 'CANCEL_REQUESTED'),
      true,
    );
    assert.deepEqual(CONTRACT_TRANSITIONS.CANCELLED, []);
  });

  it('저장 상태·결제·기한으로만 화면 상태를 계산한다', () => {
    // 실행 및 확인
    assert.equal(deriveContractDisplayStatus(contractStatusInput()), 'SIGNING');
    assert.equal(
      deriveContractDisplayStatus(
        contractStatusInput({ clientSignedAt: new Date('2026-11-04T00:00:00.000Z') }),
      ),
      'COUNTERPART_SIGNATURE_PENDING',
    );
    assert.equal(
      deriveContractDisplayStatus(
        contractStatusInput({ status: 'ACTIVE', paymentStatus: 'PENDING' }),
      ),
      'AWAITING_DEPOSIT',
    );
    assert.equal(
      deriveContractDisplayStatus(
        contractStatusInput({ status: 'ACTIVE', paymentStatus: 'DEPOSITED' }),
      ),
      'IN_PROGRESS',
    );
    assert.equal(
      deriveContractDisplayStatus(
        contractStatusInput({
          status: 'ACTIVE',
          paymentStatus: 'DEPOSITED',
          finalDelivered: true,
        }),
      ),
      'INSPECTION_DUE',
    );
    assert.equal(
      deriveContractDisplayStatus(
        contractStatusInput({
          status: 'ACTIVE',
          paymentStatus: 'PARTIALLY_RELEASED',
          workDueAt: new Date('2026-11-01T00:00:00.000Z'),
        }),
      ),
      'WORK_OVERDUE',
    );
    assert.equal(
      deriveContractDisplayStatus(
        contractStatusInput({ status: 'ACTIVE', paymentStatus: 'RELEASED' }),
      ),
      'CONTRACT_COMPLETED',
    );
    assert.equal(
      deriveContractDisplayStatus(contractStatusInput({ status: 'CANCEL_REQUESTED' })),
      'CANCEL_IN_PROGRESS',
    );
    assert.equal(
      deriveContractDisplayStatus(contractStatusInput({ status: 'CANCELLED' })),
      'CONTRACT_CANCELLED',
    );
    assert.equal(
      deriveContractDisplayStatus(contractStatusInput({ status: 'COMPLETED' })),
      'CONTRACT_COMPLETED',
    );
  });
});

describe('B-00 보조: 소유권과 보류 파생', () => {
  it('비당사자에게는 404로 존재를 숨긴다', () => {
    // 준비
    const parties = { clientUserId: 'client-1', supplierUserId: 'supplier-1' };

    // 실행 및 확인
    assert.throws(
      () => requireApplicationParty({ userId: 'intruder', role: 'CLIENT' }, parties),
      (error: unknown) =>
        error instanceof ApplicationAccessError &&
        error.status === 404 &&
        error.code === 'APPLICATION_NOT_FOUND',
    );
    assert.doesNotThrow(() =>
      requireApplicationParty({ userId: 'supplier-1', role: 'SUPPLIER' }, parties),
    );
    assert.doesNotThrow(() =>
      requireApplicationParty({ userId: 'admin-1', role: 'ADMIN' }, parties),
    );
  });

  it('보류는 저장 상태가 아니라 예치 전 파생 상태다', () => {
    // 실행 및 확인
    assert.equal(
      applicationDisplayStatus({
        status: 'SUBMITTED',
        hasAcceptedApplication: true,
        depositCompleted: false,
      }),
      'ON_HOLD',
    );
    assert.equal(
      applicationDisplayStatus({
        status: 'STALE',
        hasAcceptedApplication: true,
        depositCompleted: false,
      }),
      'ON_HOLD',
    );
    assert.equal(
      applicationDisplayStatus({
        status: 'SUBMITTED',
        hasAcceptedApplication: true,
        depositCompleted: true,
      }),
      'SUBMITTED',
    );
    assert.equal(
      applicationDisplayStatus({
        status: 'ACCEPTED',
        hasAcceptedApplication: true,
        depositCompleted: false,
      }),
      'ACCEPTED',
    );
  });

  it('Application 상태 표는 v0.7 전이만 허용한다', () => {
    // 실행 및 확인
    assert.deepEqual(APPLICATION_TRANSITIONS.ACCEPTED, ['REJECTED']);
    assert.deepEqual(APPLICATION_TRANSITIONS.REJECTED, []);
    assert.equal(
      APPLICATION_TRANSITIONS.SUBMITTED.some((status) => status === 'AUTO_REJECTED'),
      true,
    );
  });

  it('테스트 시계는 UTC 기준으로 고정·전진한다', () => {
    // 준비
    const clock = createTestClock('2026-11-03T00:00:00.000Z');

    // 확인
    assert.equal(clock.now().toISOString(), '2026-11-03T00:00:00.000Z');
    // 준비
    clock.advanceDays(3);
    // 확인
    assert.equal(clock.now().toISOString(), '2026-11-06T00:00:00.000Z');
    // 준비
    clock.set('2026-11-10T14:59:59.000Z');
    // 확인
    assert.equal(clock.now().toISOString(), '2026-11-10T14:59:59.000Z');
  });
});
