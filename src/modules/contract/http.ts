/** Gate 0: 합의·계약 HTTP 라우터 (API_INDEX #066~#073). */
import { Router, type Request } from 'express';

import { HttpError, sendCreated, sendData } from '../../http/envelope.js';
import { bodyObject, text } from '../../http/parse.js';
import type { AgreementMessage, AgreementSpec } from '../agreement/draft.js';
import { previewAgreementDraft } from '../agreement/draft.js';
import { calculateClientDeposit } from '../settlement/policy.js';
import type { AgreementDraftStore } from '../agreement/prisma-adapter.js';
import {
  refreshAgreementDraft,
  type AgreementExtractionPort,
} from '../agreement/draft.js';
import type { ApplicationRevision } from '../application/submission.js';
import {
  acceptAgreement,
  breakContract,
  contractDocumentFor,
  signContract,
  type ContractActor,
  type ContractItemSource,
  type ContractRecord,
  type ContractUnitOfWork,
} from './lifecycle.js';
import {
  getContractDetail,
  listMyContracts,
  type ContractReadPort,
} from './queries.js';
import { deriveContractDisplayStatus, type ContractDisplayStatus } from './display-status.js';
import type { ContractPartyFields, ContractViewPort } from './view.js';

export interface ContractHttpPorts {
  readonly uow: ContractUnitOfWork;
  readonly reads: ContractReadPort;
  readonly views?: ContractViewPort;
  readonly applications: {
    findRevision(applicationId: string): Promise<ApplicationRevision | null>;
  };
  readonly agreements: AgreementDraftStore;
  readonly extractor?: AgreementExtractionPort;
  readonly items: {
    listSources(applicationId: string): Promise<readonly ContractItemSource[]>;
  };
  readonly preview: {
    getSpec(applicationId: string): Promise<AgreementSpec | null>;
    getMessages(applicationId: string): Promise<readonly AgreementMessage[]>;
  };
  readonly now: () => Date;
}

function actorOf(request: Request): ContractActor {
  const actor = request.actor;
  if (actor === undefined) throw new HttpError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  return actor;
}

interface ContractView extends ContractRecord, ContractPartyFields {
  readonly displayStatus: ContractDisplayStatus;
}

function viewOf(
  contract: ContractRecord,
  party: ContractPartyFields | undefined,
  now: Date,
): ContractView {
  return {
    ...contract,
    projectTitle: party?.projectTitle ?? null,
    counterpartName: party?.counterpartName ?? null,
    reviewWrittenByMe: party?.reviewWrittenByMe ?? false,
    // WORK_OVERDUE·INSPECTION_DUE는 납품/검수 데이터가 필요하므로 별도 API에서 판단한다.
    displayStatus: deriveContractDisplayStatus({
      status: contract.status,
      paymentStatus: contract.paymentStatus,
      clientSignedAt: contract.clientSignedAt,
      supplierSignedAt: contract.supplierSignedAt,
      workDueAt: null,
      finalDelivered:
        contract.status === 'COMPLETED' || contract.paymentStatus === 'RELEASED',
      now,
    }),
  };
}

async function requireApplication(
  ports: ContractHttpPorts,
  applicationId: string,
  actor: ContractActor,
): Promise<ApplicationRevision> {
  const application = await ports.applications.findRevision(applicationId);
  if (
    application === null ||
    (actor.userId !== application.clientUserId && actor.userId !== application.supplierId)
  ) {
    throw new HttpError(404, 'APPLICATION_NOT_FOUND', '지원 정보를 찾을 수 없습니다.');
  }
  return application;
}

export function createContractRouter(ports: ContractHttpPorts): Router {
  const router = Router();

  router.get('/applications/:applicationId/agreement-preview', async (request, response) => {
    const actor = actorOf(request);
    const applicationId = request.params.applicationId as string;
    const application = await requireApplication(ports, applicationId, actor);
    const spec = await ports.preview.getSpec(applicationId);
    if (spec === null) {
      throw new HttpError(404, 'APPLICATION_NOT_FOUND', '지원 정보를 찾을 수 없습니다.');
    }
    const [messages, cached] = await Promise.all([
      ports.preview.getMessages(applicationId),
      ports.agreements.get(applicationId),
    ]);
    let preview = previewAgreementDraft({ spec, messages, cached, now: ports.now() });
    // D-38: 캐시가 없거나 낡았고 추출기가 연결된 경우에만 내부 캐시를 갱신한다.
    // 사용자가 합의 내용을 고치는 경로는 여전히 없으며 응답은 읽기 전용이다.
    if (ports.extractor !== undefined && (cached === null || preview.stale)) {
      const refreshed = await refreshAgreementDraft(ports.extractor, {
        spec,
        messages,
        now: ports.now(),
        previous: cached,
      });
      if (refreshed.refreshed) {
        await ports.agreements.save(applicationId, refreshed.draft);
      }
      preview = {
        draft: refreshed.draft,
        stale: refreshed.stale,
        readOnly: true,
      };
    }
    // F-20 하단: 견적 최종 금액 + 수수료 5% = 예치할 금액. 저장값이 아니라 기존 계산 함수로 파생한다.
    const deposit =
      application.totalAmount > 0 ? calculateClientDeposit(application.totalAmount) : null;
    sendData(response, {
      ...preview,
      quote:
        deposit === null
          ? null
          : {
              totalAmount: deposit.principal,
              durationDays: application.durationDays,
              clientFee: deposit.clientFee,
              depositAmount: deposit.depositAmount,
            },
    });
  });

  router.post('/applications/:applicationId/agreement/confirm', async (request, response) => {
    const actor = actorOf(request);
    if (actor.role !== 'CLIENT') {
      throw new HttpError(403, 'CLIENT_ONLY', '의뢰인만 합의를 완료할 수 있습니다.');
    }
    bodyObject(request.body, []);
    const applicationId = request.params.applicationId as string;
    const application = await requireApplication(ports, applicationId, actor);
    const [spec, items] = await Promise.all([
      ports.preview.getSpec(applicationId),
      ports.items.listSources(applicationId),
    ]);
    if (spec === null) {
      throw new HttpError(404, 'APPLICATION_NOT_FOUND', '지원 정보를 찾을 수 없습니다.');
    }
    const result = await acceptAgreement(ports.uow, {
      actor,
      application,
      spec,
      items,
      now: ports.now(),
    });
    sendCreated(response, result);
  });

  router.get('/me/contracts', async (request, response) => {
    const actor = actorOf(request);
    const rows = await listMyContracts(ports.reads, { actor });
    const parties =
      ports.views === undefined
        ? new Map<string, ContractPartyFields>()
        : await ports.views.describe({ contracts: rows, actor });
    sendData(
      response,
      rows.map((contract) => viewOf(contract, parties.get(contract.id), ports.now())),
    );
  });

  router.get('/contracts/:contractId', async (request, response) => {
    const actor = actorOf(request);
    const contract = await getContractDetail(ports.reads, {
      actor,
      contractId: request.params.contractId as string,
    });
    const parties =
      ports.views === undefined
        ? new Map<string, ContractPartyFields>()
        : await ports.views.describe({ contracts: [contract], actor });
    sendData(response, viewOf(contract, parties.get(contract.id), ports.now()));
  });

  router.get('/contracts/:contractId/document', async (request, response) => {
    const actor = actorOf(request);
    const contract = await getContractDetail(ports.reads, {
      actor,
      contractId: request.params.contractId as string,
    });
    sendData(response, contractDocumentFor(contract, actor));
  });

  router.post('/contracts/:contractId/sign', async (request, response) => {
    const body = bodyObject(request.body, ['expectedContentHash']);
    const result = await signContract(ports.uow, {
      contractId: request.params.contractId as string,
      actor: actorOf(request),
      expectedContentHash: text(body.expectedContentHash, 'expectedContentHash', { max: 128 }) as string,
      now: ports.now(),
    });
    sendData(response, result);
  });

  router.post('/contracts/:contractId/decline', async (request, response) => {
    const actor = actorOf(request);
    if (actor.role !== 'SUPPLIER') {
      throw new HttpError(403, 'FORBIDDEN', '공급자만 서명을 거절할 수 있습니다.');
    }
    bodyObject(request.body, []);
    const result = await breakContract(ports.uow, {
      contractId: request.params.contractId as string,
      reason: 'SIGN_REFUSED',
      actor,
      now: ports.now(),
    });
    sendData(response, result);
  });

  router.post('/contracts/:contractId/cancel-provisional', async (request, response) => {
    const actor = actorOf(request);
    if (actor.role !== 'CLIENT') {
      throw new HttpError(403, 'FORBIDDEN', '의뢰인만 임시 계약을 취소할 수 있습니다.');
    }
    bodyObject(request.body, []);
    const result = await breakContract(ports.uow, {
      contractId: request.params.contractId as string,
      reason: 'CLIENT_CANCELLED',
      actor,
      now: ports.now(),
    });
    sendData(response, result);
  });

  return router;
}
