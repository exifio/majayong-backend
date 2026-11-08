/**
 * B-07: 1:1 문의 Port의 Prisma 어댑터.
 *
 * 첨부는 `{url,name,size}` JSON으로만 저장하고 파일 원문은 다루지 않는다.
 */
import type {
  InquiryAttachment,
  InquiryCategory,
  InquiryRecord,
  InquiryStatus,
  InquiryTx,
  InquiryUnitOfWork,
} from './inquiries.js';
import { notificationTargetUrl } from '../notification/notifications.js';

export interface InquiryRow {
  readonly id: string;
  readonly userId: string;
  readonly category: InquiryCategory;
  readonly contractId: string | null;
  readonly title: string;
  readonly body: string;
  readonly attachments: unknown;
  readonly status: InquiryStatus;
  readonly answer: string | null;
  readonly answeredById: string | null;
  readonly answeredAt: Date | null;
  readonly createdAt: Date;
  readonly user?: { readonly name: string | null };
}

export interface InquiryDbClient {
  readonly supportInquiry: {
    findUnique(input: {
      readonly where: { readonly id: string };
    }): Promise<InquiryRow | null>;
    findMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly orderBy?: readonly Readonly<Record<string, 'asc' | 'desc'>>[];
      readonly include?: { readonly user: { readonly select: { readonly name: true } } };
    }): Promise<readonly InquiryRow[]>;
    create(input: { readonly data: Readonly<Record<string, unknown>> }): Promise<InquiryRow>;
    update(input: {
      readonly where: { readonly id: string };
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<InquiryRow>;
  };
  readonly contract: {
    findFirst(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly select: { readonly id: true };
    }): Promise<{ readonly id: string } | null>;
  };
  readonly eventLog: {
    create(input: { readonly data: Readonly<Record<string, unknown>> }): Promise<unknown>;
  };
  readonly fileAttachment: {
    updateMany(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<{ readonly count: number }>;
  };
  readonly notification: {
    findUnique(input: {
      readonly where: {
        readonly userId_type_targetId: {
          readonly userId: string;
          readonly type: string;
          readonly targetId: string;
        };
      };
    }): Promise<unknown | null>;
    create(input: { readonly data: Readonly<Record<string, unknown>> }): Promise<unknown>;
  };
}

export interface InquiryPrismaClient extends InquiryDbClient {
  $transaction<T>(work: (tx: InquiryDbClient) => Promise<T>): Promise<T>;
}

function readAttachments(value: unknown): readonly InquiryAttachment[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('INVALID_INQUIRY_ATTACHMENTS');
  return value.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as { url?: unknown }).url !== 'string' ||
      typeof (item as { name?: unknown }).name !== 'string' ||
      typeof (item as { size?: unknown }).size !== 'number'
    ) {
      throw new Error('INVALID_INQUIRY_ATTACHMENTS');
    }
    const record = item as { fileId?: unknown; url: string; name: string; size: number };
    return {
      ...(typeof record.fileId === 'string' ? { fileId: record.fileId } : {}),
      url: record.url,
      name: record.name,
      size: record.size,
    };
  });
}

export function toInquiryRecord(row: InquiryRow): InquiryRecord {
  return {
    id: row.id,
    userId: row.userId,
    category: row.category,
    contractId: row.contractId,
    title: row.title,
    body: row.body,
    attachments: readAttachments(row.attachments),
    status: row.status,
    answer: row.answer,
    answeredById: row.answeredById,
    answeredAt: row.answeredAt,
    createdAt: row.createdAt,
    ...(row.user === undefined ? {} : { authorName: row.user.name }),
  };
}

export function createInquiryTx(db: InquiryDbClient, now: () => Date): InquiryTx {
  return {
    async canAccessContract(input) {
      const contract = await db.contract.findFirst({
        where: {
          id: input.contractId,
          application: {
            OR: [
              { supplierId: input.userId },
              { project: { draft: { clientId: input.userId } } },
            ],
          },
        },
        select: { id: true },
      });
      return contract !== null;
    },

    async createInquiry(input) {
      return toInquiryRecord(
        await db.supportInquiry.create({
          data: {
            userId: input.userId,
            category: input.category,
            contractId: input.contractId,
            title: input.title,
            body: input.body,
            attachments:
              input.attachments.length === 0
                ? null
                : input.attachments.map((attachment) => ({ ...attachment })),
            createdAt: input.createdAt,
          },
        }),
      );
    },

    async bindInquiryFiles(input) {
      if (input.fileIds.length === 0) return 0;
      const result = await db.fileAttachment.updateMany({
        where: {
          id: { in: [...input.fileIds] },
          uploaderId: input.userId,
          purpose: 'SUPPORT_INQUIRY',
          inquiryId: null,
        },
        data: { inquiryId: input.inquiryId },
      });
      return result.count;
    },

    async findInquiry(inquiryId) {
      const row = await db.supportInquiry.findUnique({ where: { id: inquiryId } });
      return row === null ? null : toInquiryRecord(row);
    },

    async listInquiries(input) {
      const where: Record<string, unknown> = {};
      if (input.userId !== undefined) where.userId = input.userId;
      if (input.status !== undefined) where.status = input.status;
      const rows = await db.supportInquiry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...(input.userId === undefined
          ? { include: { user: { select: { name: true } } } }
          : {}),
      });
      return rows.map(toInquiryRecord);
    },

    async answerInquiry(input) {
      const exists = await db.supportInquiry.findUnique({ where: { id: input.inquiryId } });
      if (exists === null) return null;
      return toInquiryRecord(
        await db.supportInquiry.update({
          where: { id: input.inquiryId },
          data: {
            status: 'ANSWERED',
            answer: input.answer,
            answeredById: input.answeredById,
            answeredAt: input.answeredAt,
          },
        }),
      );
    },

    async notifyAuthor(input) {
      const existing = await db.notification.findUnique({
        where: { userId_type_targetId: { userId: input.userId, type: 'INQUIRY_ANSWERED', targetId: input.inquiryId } },
      });
      if (existing !== null) return;
      try {
        await db.notification.create({
          data: {
            userId: input.userId,
            type: 'INQUIRY_ANSWERED',
            targetUrl: notificationTargetUrl('INQUIRY_ANSWERED', input.inquiryId),
            targetId: input.inquiryId,
            payload: null,
            createdAt: now(),
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
      }
    },

    async logEvent(input) {
      await db.eventLog.create({
        data: { userId: input.userId, type: input.type, payload: input.payload },
      });
    },
  };
}

export function createPrismaInquiryUnitOfWork(
  prisma: InquiryPrismaClient,
  now: () => Date,
): InquiryUnitOfWork {
  return {
    run<T>(work: (tx: InquiryTx) => Promise<T>): Promise<T> {
      return prisma.$transaction((tx) => work(createInquiryTx(tx, now)));
    },
  };
}
