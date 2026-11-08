/** B-07: 1:1 문의. 첨부 실파일은 C의 비공개 저장소 Port에서 제공한다. */
export const INQUIRY_CATEGORIES = ['USAGE', 'PAYMENT', 'INSPECTION', 'CANCEL', 'ACCOUNT', 'OTHER'] as const;
export type InquiryCategory = (typeof INQUIRY_CATEGORIES)[number];
export type InquiryStatus = 'WAITING' | 'ANSWERED';

export interface InquiryAttachment {
  /** presign으로 먼저 올린 파일을 문의 생성 시 연결할 때 쓴다. */
  readonly fileId?: string;
  readonly url: string;
  readonly name: string;
  readonly size: number;
}

export interface InquiryRecord {
  readonly id: string;
  readonly userId: string;
  readonly category: InquiryCategory;
  readonly contractId: string | null;
  readonly title: string;
  readonly body: string;
  readonly attachments: readonly InquiryAttachment[];
  readonly status: InquiryStatus;
  readonly answer: string | null;
  readonly answeredById: string | null;
  readonly answeredAt: Date | null;
  readonly createdAt: Date;
  /** 운영자 목록에서만 채워지는 문의자 표시명. */
  readonly authorName?: string | null;
}

export interface InquiryTx {
  canAccessContract(input: { readonly contractId: string; readonly userId: string }): Promise<boolean>;
  createInquiry(input: {
    readonly userId: string;
    readonly category: InquiryCategory;
    readonly contractId: string | null;
    readonly title: string;
    readonly body: string;
    readonly attachments: readonly InquiryAttachment[];
    readonly createdAt: Date;
  }): Promise<InquiryRecord>;
  /** presign으로 올린 SUPPORT_INQUIRY 파일을 문의에 귀속한다. 반환값은 갱신된 파일 수. */
  bindInquiryFiles(input: {
    readonly inquiryId: string;
    readonly userId: string;
    readonly fileIds: readonly string[];
  }): Promise<number>;
  findInquiry(inquiryId: string): Promise<InquiryRecord | null>;
  listInquiries(input: { readonly userId?: string; readonly status?: InquiryStatus }): Promise<readonly InquiryRecord[]>;
  answerInquiry(input: {
    readonly inquiryId: string;
    readonly answeredById: string;
    readonly answer: string;
    readonly answeredAt: Date;
  }): Promise<InquiryRecord | null>;
  notifyAuthor(input: { readonly userId: string; readonly inquiryId: string }): Promise<void>;
  logEvent(input: {
    readonly userId: string;
    readonly type: 'INQUIRY_OPENED' | 'SUPPORT_INQUIRY_SUBMITTED' | 'SUPPORT_INQUIRY_ANSWERED';
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

export interface InquiryUnitOfWork {
  run<T>(work: (tx: InquiryTx) => Promise<T>): Promise<T>;
}

export class InquiryError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'InquiryError';
    this.status = status;
    this.code = code;
  }
}

export interface InquiryActor {
  readonly userId: string;
  readonly role: 'CLIENT' | 'SUPPLIER' | 'ADMIN';
}

export interface CreateInquiryInput {
  readonly actor: InquiryActor;
  readonly category: InquiryCategory;
  readonly contractId?: string | null;
  readonly title: string;
  readonly body: string;
  readonly attachments?: readonly InquiryAttachment[];
  readonly now: Date;
}

export function createInquiry(uow: InquiryUnitOfWork, input: CreateInquiryInput): Promise<InquiryRecord> {
  return createInquiryImpl(uow, input);
}

export function listMyInquiries(
  _uow: InquiryUnitOfWork,
  _input: { readonly actor: InquiryActor },
): Promise<readonly InquiryRecord[]> {
  if (_input.actor.role === 'ADMIN') return Promise.reject(new InquiryError(403, 'USER_ONLY', '본인 문의에서 사용할 기능입니다.'));
  return _uow.run((tx) => tx.listInquiries({ userId: _input.actor.userId }));
}

export function getInquiry(
  _uow: InquiryUnitOfWork,
  _input: { readonly actor: InquiryActor; readonly inquiryId: string },
): Promise<InquiryRecord> {
  return getInquiryImpl(_uow, _input);
}

export function listInquiriesForAdmin(
  _uow: InquiryUnitOfWork,
  _input: { readonly actor: InquiryActor; readonly status?: InquiryStatus },
): Promise<readonly InquiryRecord[]> {
  if (_input.actor.role !== 'ADMIN') return Promise.reject(new InquiryError(403, 'ADMIN_ONLY', '운영자만 문의 목록을 볼 수 있습니다.'));
  return _uow.run((tx) => tx.listInquiries({ status: _input.status }));
}

export function answerInquiry(
  _uow: InquiryUnitOfWork,
  _input: {
    readonly actor: InquiryActor;
    readonly inquiryId: string;
    readonly answer: string;
    readonly now: Date;
  },
): Promise<InquiryRecord> {
  return answerInquiryImpl(_uow, _input);
}

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const SAFE_ATTACHMENT_URL = /^\/(?!\/)[A-Za-z0-9/_:.-]+$/;
const SAFE_ATTACHMENT_NAME = /^[^/\\\u0000-\u001f]{1,255}$/;
const SAFE_FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(code: string, message: string): InquiryError {
  return new InquiryError(400, code, message);
}

function validCategory(value: unknown): value is InquiryCategory {
  return INQUIRY_CATEGORIES.some((category) => category === value);
}

function validateAttachments(attachments: readonly InquiryAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENTS) throw invalid('TOO_MANY_ATTACHMENTS', '첨부 파일은 최대 3개입니다.');
  const fileIds = new Set<string>();
  for (const attachment of attachments) {
    if (attachment.fileId !== undefined) {
      if (!SAFE_FILE_ID.test(attachment.fileId) || fileIds.has(attachment.fileId)) {
        throw invalid('INVALID_ATTACHMENT', '첨부 파일 정보가 올바르지 않습니다.');
      }
      fileIds.add(attachment.fileId);
    } else if (!SAFE_ATTACHMENT_URL.test(attachment.url)) {
      throw invalid('INVALID_ATTACHMENT', '첨부 파일 정보가 올바르지 않습니다.');
    }
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || !SAFE_ATTACHMENT_NAME.test(attachment.name)) {
      throw invalid('INVALID_ATTACHMENT', '첨부 파일 정보가 올바르지 않습니다.');
    }
    if (attachment.size > MAX_ATTACHMENT_BYTES) throw invalid('ATTACHMENT_TOO_LARGE', '첨부 파일은 개당 10MB 이하여야 합니다.');
  }
}

async function createInquiryImpl(uow: InquiryUnitOfWork, input: CreateInquiryInput): Promise<InquiryRecord> {
  if (input.actor.role === 'ADMIN' || input.actor.userId.trim().length === 0) {
    throw new InquiryError(403, 'USER_ONLY', '로그인한 사용자만 문의할 수 있습니다.');
  }
  if (!validCategory(input.category)) throw invalid('INVALID_CATEGORY', '문의 유형이 올바르지 않습니다.');
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length === 0) throw invalid('INVALID_TITLE', '제목을 입력해 주세요.');
  if (body.length === 0) throw invalid('INVALID_BODY', '문의 내용을 입력해 주세요.');
  const rawAttachments = input.attachments ?? [];
  const attachments = rawAttachments.map((attachment) =>
    attachment.fileId === undefined
      ? attachment
      : { ...attachment, url: `/api/v1/uploads/${attachment.fileId}/download` },
  );
  validateAttachments(attachments);
  const contractId = input.contractId?.trim() || null;

  return uow.run(async (tx) => {
    if (contractId !== null && !(await tx.canAccessContract({ contractId, userId: input.actor.userId }))) {
      throw new InquiryError(404, 'CONTRACT_NOT_FOUND', '관련 계약을 찾을 수 없습니다.');
    }
    const inquiry = await tx.createInquiry({
      userId: input.actor.userId, category: input.category, contractId,
      title, body, attachments: [...attachments], createdAt: input.now,
    });
    const fileIds = attachments.flatMap((attachment) => attachment.fileId === undefined ? [] : [attachment.fileId]);
    if (fileIds.length > 0) {
      const bound = await tx.bindInquiryFiles({ inquiryId: inquiry.id, userId: input.actor.userId, fileIds });
      if (bound !== fileIds.length) throw invalid('INVALID_ATTACHMENT', '첨부 파일을 확인할 수 없습니다.');
    }
    await tx.logEvent({ userId: input.actor.userId, type: 'SUPPORT_INQUIRY_SUBMITTED',
      payload: { inquiryId: inquiry.id, category: inquiry.category } });
    return inquiry;
  });
}

async function getInquiryImpl(uow: InquiryUnitOfWork, input: { actor: InquiryActor; inquiryId: string }): Promise<InquiryRecord> {
  const inquiry = await uow.run((tx) => tx.findInquiry(input.inquiryId));
  if (inquiry === null || (input.actor.role !== 'ADMIN' && inquiry.userId !== input.actor.userId)) {
    throw new InquiryError(404, 'INQUIRY_NOT_FOUND', '문의를 찾을 수 없습니다.');
  }
  return inquiry;
}

async function answerInquiryImpl(uow: InquiryUnitOfWork, input: {
  readonly actor: InquiryActor; readonly inquiryId: string; readonly answer: string; readonly now: Date;
}): Promise<InquiryRecord> {
  if (input.actor.role !== 'ADMIN') throw new InquiryError(403, 'ADMIN_ONLY', '운영자만 답변할 수 있습니다.');
  const answer = input.answer.trim();
  if (answer.length === 0) throw invalid('ANSWER_REQUIRED', '답변을 입력해 주세요.');

  return uow.run(async (tx) => {
    const existing = await tx.findInquiry(input.inquiryId);
    if (existing === null) throw new InquiryError(404, 'INQUIRY_NOT_FOUND', '문의를 찾을 수 없습니다.');
    if (existing.status !== 'WAITING') throw new InquiryError(409, 'INQUIRY_ALREADY_ANSWERED', '이미 답변한 문의입니다.');
    const answered = await tx.answerInquiry({
      inquiryId: existing.id, answeredById: input.actor.userId, answer, answeredAt: input.now,
    });
    if (answered === null) throw new InquiryError(409, 'INQUIRY_STATE_CHANGED', '문의 상태가 변경되었습니다.');
    await tx.notifyAuthor({ userId: existing.userId, inquiryId: existing.id });
    await tx.logEvent({ userId: input.actor.userId, type: 'SUPPORT_INQUIRY_ANSWERED',
      payload: { inquiryId: existing.id } });
    return answered;
  });
}
