/**
 * Gate 0: 지원·견적 HTTP 라우터 (API_INDEX #050~#056).
 *
 * 도메인 함수는 그대로 호출하고, HTTP 계층은 입력 파싱·역할 검사·봉투만 담당한다.
 * 프로젝트 상태/명세 버전은 A가 소유하므로 Port로만 읽는다.
 */
import { Router, type Request } from 'express';

import type { Actor, ApplicationRecord } from './dto.js';
import { ApplicationAccessError } from './dto.js';
import type { ProjectSpecVersion } from '../market/public-project.js';
import {
  getApplicationDetail,
  listApplicationRevisions,
  listMyApplications,
  listProjectApplicationCards,
  type ApplicationReadPort,
  type ProjectApplicationsPort,
} from './queries.js';
import {
  rejectApplication,
  reviseApplication,
  submitApplication,
  withdrawApplication,
  type ApplicationUnitOfWork,
} from './submission.js';
import { HttpError, sendCreated, sendData } from '../../http/envelope.js';
import {
  bodyObject,
  integer,
  items,
  nullableText,
  questions,
  text,
} from '../../http/parse.js';

export interface ProjectStateForApplication extends ProjectSpecVersion {
  readonly clientUserId: string;
}

/** A 소유 Project/SpecItem 읽기 Port. */
export interface ProjectStateReadPort {
  getForApplication(projectId: string): Promise<ProjectStateForApplication | null>;
}

export interface ApplicationHttpPorts {
  readonly uow: ApplicationUnitOfWork;
  readonly reads: ApplicationReadPort;
  readonly projectApplications: ProjectApplicationsPort;
  readonly projectState: ProjectStateReadPort;
  readonly now: () => Date;
}

function actorOf(request: Request): Actor {
  const actor = request.actor;
  if (actor === undefined) throw new HttpError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  return actor;
}

function requireRole(actor: Actor, role: Actor['role']): void {
  if (actor.role !== role) {
    throw new HttpError(403, 'FORBIDDEN', '이 작업을 수행할 권한이 없습니다.');
  }
}

async function projectState(
  ports: ApplicationHttpPorts,
  projectId: string,
): Promise<ProjectStateForApplication> {
  const state = await ports.projectState.getForApplication(projectId);
  if (state === null) throw new ApplicationAccessError();
  return state;
}

const SUBMIT_FIELDS = ['totalAmount', 'durationDays', 'message', 'questions', 'items'];
const REVISE_FIELDS = [
  'totalAmount',
  'durationDays',
  'message',
  'questions',
  'items',
  'revisionReason',
];

function parsePricing(record: Readonly<Record<string, unknown>>) {
  return {
    totalAmount: integer(record.totalAmount, 'totalAmount', { min: 1 }),
    durationDays: integer(record.durationDays, 'durationDays', { min: 1, max: 3650 }),
    message: nullableText(record.message, 'message', 4000),
    questions: questions(record.questions, 3),
    items: items(record.items),
  };
}

export function createApplicationRouter(ports: ApplicationHttpPorts): Router {
  const router = Router();

  router.get('/projects/:projectId/applications', async (request, response) => {
    const actor = actorOf(request);
    requireRole(actor, 'CLIENT');
    const cards = await listProjectApplicationCards(ports.projectApplications, {
      actor,
      projectId: request.params.projectId as string,
    });
    sendData(response, cards);
  });

  router.post('/projects/:projectId/applications', async (request, response) => {
    const actor = actorOf(request);
    requireRole(actor, 'SUPPLIER');
    const projectId = request.params.projectId as string;
    const body = bodyObject(request.body, SUBMIT_FIELDS);
    const parsed = parsePricing(body);
    if (parsed.items === undefined) {
      throw new HttpError(400, 'INVALID_REQUEST', 'items가 필요합니다.');
    }
    const state = await projectState(ports, projectId);

    const created = await submitApplication(ports.uow, {
      projectId,
      clientUserId: state.clientUserId,
      supplierId: actor.userId,
      projectStatus: state.status,
      specVersionNo: state.currentVersion,
      specItemIds: state.specItemIds,
      totalAmount: parsed.totalAmount,
      durationDays: parsed.durationDays,
      message: parsed.message,
      questions: parsed.questions,
      items: parsed.items,
      now: ports.now(),
    });
    sendCreated(response, created);
  });

  router.get('/me/applications', async (request, response) => {
    const rows = await listMyApplications(ports.reads, { actor: actorOf(request) });
    sendData(response, rows);
  });

  router.get('/applications/:applicationId', async (request, response) => {
    const revision = await getApplicationDetail(ports.reads, {
      actor: actorOf(request),
      applicationId: request.params.applicationId as string,
    });
    sendData(response, revision);
  });

  router.get('/applications/:applicationId/revisions', async (request, response) => {
    const rows = await listApplicationRevisions(ports.reads, {
      actor: actorOf(request),
      applicationId: request.params.applicationId as string,
    });
    sendData(response, rows);
  });

  router.post('/applications/:applicationId/withdraw', async (request, response) => {
    const actor = actorOf(request);
    requireRole(actor, 'SUPPLIER');
    bodyObject(request.body, []);
    const result = await withdrawApplication(ports.uow, {
      applicationId: request.params.applicationId as string,
      supplierId: actor.userId,
    });
    sendData(response, result);
  });

  router.post('/applications/:applicationId/reject', async (request, response) => {
    const actor = actorOf(request);
    requireRole(actor, 'CLIENT');
    bodyObject(request.body, []);
    const result = await rejectApplication(ports.uow, {
      applicationId: request.params.applicationId as string,
      clientUserId: actor.userId,
      now: ports.now(),
    });
    sendData(response, result);
  });

  router.post('/applications/:applicationId/revisions', async (request, response) => {
    const actor = actorOf(request);
    requireRole(actor, 'SUPPLIER');
    const applicationId = request.params.applicationId as string;
    const body = bodyObject(request.body, REVISE_FIELDS);
    const parsed = parsePricing(body);
    if (parsed.items === undefined) {
      throw new HttpError(400, 'INVALID_REQUEST', 'items가 필요합니다.');
    }
    const current = await ports.reads.findRevision(applicationId);
    if (current === null) throw new ApplicationAccessError();
    if (current.supplierId !== actor.userId) throw new ApplicationAccessError();

    const state = await projectState(ports, current.projectId);
    const result = await reviseApplication(ports.uow, {
      applicationId,
      supplierId: actor.userId,
      specVersionNo: state.currentVersion,
      specItemIds: state.specItemIds,
      totalAmount: parsed.totalAmount,
      durationDays: parsed.durationDays,
      items: parsed.items,
      revisionReason: text(body.revisionReason, 'revisionReason', { max: 200 }) as string,
      message: parsed.message,
      questions: parsed.questions,
      now: ports.now(),
    });
    sendCreated(response, result);
  });

  return router;
}
