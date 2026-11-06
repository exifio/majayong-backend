import { randomUUID } from "node:crypto";

export class FileHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FileHttpError";
    this.status = status;
  }
}

export type FilePurpose = "DELIVERY" | "PORTFOLIO" | "SUPPORT_INQUIRY" | "CONTRACT_DOCUMENT";

export interface FileEntity {
  id: string;
  purpose: FilePurpose;
  contractId?: string;
  inquiryId?: string;
  uploaderId: string;
  objectKey: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: Date;
}

export interface FileContractEntity {
  id: string;
  clientUserId: string;
  supplierUserId: string;
}

/** Gate 0 공통 StoragePort 이름. C FileService는 이 Port만 사용한다. */
export type StoragePort = FileStorageAdapter;

export interface FileStorageAdapter {
  createUploadUrl(
    bucket: string,
    objectKey: string,
    expiresInSec: number,
  ): Promise<{ uploadUrl: string; expiresInSec: number }>;
  createDownloadUrl(
    bucket: string,
    objectKey: string,
    expiresInSec: number,
  ): Promise<{ downloadUrl: string; expiresInSec: number }>;
}

export interface FileRepository {
  seedContract(contract: FileContractEntity): void;
  getContract(id: string): Promise<FileContractEntity | null>;
  saveFileMetadata(data: Omit<FileEntity, "id" | "createdAt">): Promise<FileEntity>;
  getFileMetadata(id: string): Promise<FileEntity | null>;
  countFilesInquiry(inquiryId: string): Promise<number>;
}

export function createInMemoryFileRepository(): FileRepository {
  const contracts = new Map<string, FileContractEntity>();
  const files = new Map<string, FileEntity>();
  let idCounter = 1;

  return {
    seedContract(contract) {
      contracts.set(contract.id, { ...contract });
    },
    async getContract(id) {
      return contracts.get(id) ?? null;
    },
    async saveFileMetadata(data) {
      const id = `file-${idCounter++}`;
      const rec: FileEntity = { ...data, id, createdAt: new Date() };
      files.set(id, rec);
      return rec;
    },
    async getFileMetadata(id) {
      return files.get(id) ?? null;
    },
    async countFilesInquiry(inquiryId) {
      let count = 0;
      for (const f of files.values()) {
        if (f.inquiryId === inquiryId) count++;
      }
      return count;
    },
  };
}

const ALLOWED_EXTENSIONS: Record<string, true> = {
  ".png": true,
  ".jpg": true,
  ".jpeg": true,
  ".webp": true,
  ".pdf": true,
  ".zip": true,
  ".mp4": true,
  ".txt": true,
};

const ALLOWED_MIME_BY_EXTENSION: Record<string, readonly string[]> = {
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".webp": ["image/webp"],
  ".pdf": ["application/pdf"],
  ".zip": ["application/zip", "application/x-zip-compressed"],
  ".mp4": ["video/mp4"],
  ".txt": ["text/plain"],
};

const FILE_PURPOSES: readonly FilePurpose[] = [
  "DELIVERY",
  "PORTFOLIO",
  "SUPPORT_INQUIRY",
  "CONTRACT_DOCUMENT",
];

export function sanitizeFileName(name: string): string {
  const base = name.replace(/[\/\\]/g, "").replace(/\.\./g, "").replace(/\0/g, "");
  return base.trim() || "unnamed";
}

export interface FileServiceOptions {
  repo: FileRepository;
  storageAdapter: FileStorageAdapter;
  bucket?: string;
  clock?: { now(): Date };
  /** 문의 첨부 권한 확인. 미주입 시 기존 동작(권한 확인 없음)을 유지한다. */
  inquiryOwner?: (inquiryId: string) => Promise<string | null>;
}

export class FileService {
  private readonly repo: FileRepository;
  private readonly storageAdapter: FileStorageAdapter;
  private readonly bucket: string;
  private readonly clock: { now(): Date };
  private readonly inquiryOwner?: FileServiceOptions["inquiryOwner"];

  constructor(options: FileServiceOptions) {
    this.repo = options.repo;
    this.storageAdapter = options.storageAdapter;
    this.bucket = options.bucket ?? "private-assets";
    this.clock = options.clock ?? { now: () => new Date() };
    this.inquiryOwner = options.inquiryOwner;
  }

  async createPresignedUpload(
    actor: { userId: string; role: string },
    input: {
      purpose: FilePurpose;
      contractId?: string;
      inquiryId?: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
    },
  ): Promise<{ fileId: string; uploadUrl: string; objectKey: string; expiresInSec: number }> {
    if (!actor.userId || actor.role === "UNKNOWN") {
      throw new FileHttpError(403, "파일 업로드 권한이 없습니다. 유효한 로그인 계정이 필요합니다.");
    }
    if (!FILE_PURPOSES.includes(input.purpose)) {
      throw new FileHttpError(400, "허용되지 않은 파일 목적입니다.");
    }
    if (
      typeof input.fileName !== "string" ||
      input.fileName.trim().length === 0 ||
      typeof input.fileSize !== "number" ||
      Number.isSafeInteger(input.fileSize) === false ||
      input.fileSize <= 0
    ) {
      throw new FileHttpError(400, "파일 이름과 크기가 올바르지 않습니다.");
    }

    const lowerName = input.fileName.toLowerCase();
    const extMatch = lowerName.match(/\.[a-z0-9]+$/);
    const ext = extMatch ? extMatch[0] : "";

    if (!ALLOWED_EXTENSIONS[ext]) {
      throw new FileHttpError(400, `지원하지 않는 파일 형식입니다: ${ext || "알 수 없음"}`);
    }
    const allowedMimes = ALLOWED_MIME_BY_EXTENSION[ext];
    if (typeof input.mimeType !== "string" || !allowedMimes.includes(input.mimeType.trim().toLowerCase())) {
      throw new FileHttpError(400, `파일 확장자와 MIME 형식이 일치하지 않습니다: ${input.mimeType || "빈 값"}`);
    }

    // 목적별 필수 식별자가 없으면 권한 검사를 우회하지 못하게 먼저 거부한다.
    if ((input.purpose === "DELIVERY" || input.purpose === "CONTRACT_DOCUMENT") && !input.contractId) {
      throw new FileHttpError(400, "계약 파일은 contractId가 필요합니다.");
    }
    // 문의 첨부는 문의 생성 전에 업로드할 수 있다. inquiryId가 있으면 소유권·개수를 추가 검증한다.

    const isSupportInquiry = input.purpose === "SUPPORT_INQUIRY";
    const maxLimit = isSupportInquiry ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
    const limitLabel = isSupportInquiry ? "10MB" : "50MB";

    if (input.fileSize > maxLimit) {
      throw new FileHttpError(400, `파일 크기가 제한(${limitLabel})을 초과합니다.`);
    }

    if (input.purpose === "PORTFOLIO" && actor.role !== "SUPPLIER") {
      throw new FileHttpError(403, "포트폴리오 파일은 공급자만 업로드할 수 있습니다.");
    }

    if (input.contractId) {
      const contract = await this.repo.getContract(input.contractId);
      if (!contract) throw new FileHttpError(404, "계약을 찾을 수 없습니다.");
      if (input.purpose === "DELIVERY" && actor.userId !== contract.supplierUserId) {
        throw new FileHttpError(403, "계약 납품 파일은 담당 공급자만 업로드할 수 있습니다.");
      }
      if (
        input.purpose === "CONTRACT_DOCUMENT" &&
        actor.userId !== contract.clientUserId &&
        actor.userId !== contract.supplierUserId
      ) {
        throw new FileHttpError(403, "계약 문서는 계약 당사자만 업로드할 수 있습니다.");
      }
    }

    if (isSupportInquiry && input.inquiryId) {
      if (this.inquiryOwner !== undefined) {
        const owner = await this.inquiryOwner(input.inquiryId);
        if (owner !== actor.userId) {
          throw new FileHttpError(403, "문의 작성자만 첨부파일을 올릴 수 있습니다.");
        }
      }
      const count = await this.repo.countFilesInquiry(input.inquiryId);
      if (count >= 3) {
        throw new FileHttpError(400, "1:1 문의 첨부파일은 최대 3개까지만 업로드할 수 있습니다.");
      }
    }

    const safeBaseName = sanitizeFileName(input.fileName);
    const scopeFolder = input.contractId ?? input.inquiryId ?? actor.userId;
    const objectKey = `${input.purpose.toLowerCase()}/${scopeFolder}/${randomUUID()}/${safeBaseName}`;

    const expiresInSec = 300;
    const presign = await this.storageAdapter.createUploadUrl(this.bucket, objectKey, expiresInSec);

    const file = await this.repo.saveFileMetadata({
      purpose: input.purpose,
      ...(input.contractId === undefined ? {} : { contractId: input.contractId }),
      ...(input.inquiryId === undefined ? {} : { inquiryId: input.inquiryId }),
      uploaderId: actor.userId,
      objectKey,
      fileName: safeBaseName,
      fileSize: input.fileSize,
      mimeType: input.mimeType,
    });

    return {
      fileId: file.id,
      uploadUrl: presign.uploadUrl,
      objectKey,
      expiresInSec: presign.expiresInSec,
    };
  }

  async createPresignedDownload(
    actor: { userId: string; role: string },
    fileId: string,
  ): Promise<{ downloadUrl: string; expiresInSec: number }> {
    const file = await this.repo.getFileMetadata(fileId);
    if (!file) throw new FileHttpError(404, "파일 메타데이터를 찾을 수 없습니다.");

    if (file.contractId) {
      const contract = await this.repo.getContract(file.contractId);
      if (!contract) throw new FileHttpError(404, "관련 계약을 찾을 수 없습니다.");

      const isParty =
        actor.role === "ADMIN" ||
        actor.userId === contract.clientUserId ||
        actor.userId === contract.supplierUserId;

      if (!isParty) {
        throw new FileHttpError(403, "해당 파일에 대한 접근 권한이 없습니다.");
      }
    } else {
      if (actor.role !== "ADMIN" && actor.userId !== file.uploaderId) {
        throw new FileHttpError(403, "본인이 업로드한 파일만 다운로드할 수 있습니다.");
      }
    }

    const expiresInSec = 180;
    return this.storageAdapter.createDownloadUrl(this.bucket, file.objectKey, expiresInSec);
  }
}
