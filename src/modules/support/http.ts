/** Gate 0: 고객센터 문의 HTTP 라우터 (API_INDEX #101~#103, #116~#117). */
import { Router, type Request } from 'express';

import { HttpError, sendCreated, sendData } from '../../http/envelope.js';
import { bodyObject, integer, nullableText, oneOf, text } from '../../http/parse.js';
import {
  INQUIRY_CATEGORIES,
  answerInquiry,
  createInquiry,
  getInquiry,
  listInquiriesForAdmin,
  listMyInquiries,
  type InquiryActor,
  type InquiryAttachment,
  type InquiryStatus,
  type InquiryUnitOfWork,
} from './inquiries.js';

export interface SupportHttpPorts {
  readonly uow: InquiryUnitOfWork;
  readonly now: () => Date;
}

function actorOf(request: Request): InquiryActor {
  const actor = request.actor;
  if (actor === undefined) throw new HttpError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  return actor;
}

function statusOf(request: Request): InquiryStatus | undefined {
  const raw = request.query.status;
  if (raw === undefined) return undefined;
  if (raw !== 'WAITING' && raw !== 'ANSWERED') {
    throw new HttpError(400, 'INVALID_REQUEST', 'status 값이 올바르지 않습니다.');
  }
  return raw;
}

function attachmentsOf(value: unknown): readonly InquiryAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'attachments는 배열이어야 합니다.');
  }
  return value.map((item) => {
    const record = bodyObject(item, ['fileId', 'url', 'name', 'size']);
    const fileId = text(record.fileId, 'fileId', { max: 64, optional: true });
    const url = nullableText(record.url, 'url', 2048);
    if (fileId === undefined && (url === undefined || url === null)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'url 또는 fileId가 필요합니다.');
    }
    return {
      ...(fileId === undefined ? {} : { fileId }),
      url: url ?? '',
      name: text(record.name, 'name', { max: 255 }) as string,
      size: integer(record.size, 'size', { min: 1, max: 10 * 1024 * 1024 }),
    };
  });
}

export function createSupportRouter(ports: SupportHttpPorts): Router {
  const router = Router();

  router.post('/support/inquiries', async (request, response) => {
    const body = bodyObject(request.body, ['category', 'contractId', 'title', 'body', 'attachments']);
    const inquiry = await createInquiry(ports.uow, {
      actor: actorOf(request),
      category: oneOf(body.category, 'category', INQUIRY_CATEGORIES),
      contractId: nullableText(body.contractId, 'contractId', 64),
      title: text(body.title, 'title', { max: 200 }) as string,
      body: text(body.body, 'body', { max: 5000 }) as string,
      attachments: attachmentsOf(body.attachments),
      now: ports.now(),
    });
    sendCreated(response, inquiry);
  });

  router.get('/support/inquiries', async (request, response) => {
    const rows = await listMyInquiries(ports.uow, { actor: actorOf(request) });
    sendData(response, rows);
  });

  router.get('/support/inquiries/:inquiryId', async (request, response) => {
    const inquiry = await getInquiry(ports.uow, {
      actor: actorOf(request),
      inquiryId: request.params.inquiryId as string,
    });
    sendData(response, inquiry);
  });

  router.get('/admin/support/inquiries', async (request, response) => {
    const rows = await listInquiriesForAdmin(ports.uow, {
      actor: actorOf(request),
      status: statusOf(request),
    });
    sendData(response, rows);
  });

  router.post('/admin/support/inquiries/:inquiryId/answer', async (request, response) => {
    const body = bodyObject(request.body, ['answer']);
    const inquiry = await answerInquiry(ports.uow, {
      actor: actorOf(request),
      inquiryId: request.params.inquiryId as string,
      answer: text(body.answer, 'answer', { max: 5000 }) as string,
      now: ports.now(),
    });
    sendData(response, inquiry);
  });

  return router;
}
