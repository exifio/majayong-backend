import { ContractStatus, EventType, PortfolioSummaryStatus, Prisma, ProjectStatus, Role, type PrismaClient } from "@prisma/client";
import type { Request, RequestHandler, Response, Router } from "express";
import type { Actor } from "../identity/session.js";
import { decryptProfileValue, encryptProfileValue, maskProfileValue } from "./crypto.js";
import { ProfileError } from "./errors.js";

export type PortfolioItem = { type: "LINK" | "FILE"; url: string; title?: string };
export type PortfolioSummaryResult = { summary: string; model: string; tokens: { input: number; output: number }; costKrw: number };
export type ProfilePorts = {
  encryptionKey?: string;
  supplierNdaVersion?: string;
  payoutVerification?: {
    verify(input: { userId: string; bank: string; accountNo: string; holder: string; code: string }): Promise<boolean>;
  };
  // Adapters must restrict network reads to safe HTTPS destinations and files to the owner's private storage paths.
  portfolioSourceReader?: { read(userId: string, items: PortfolioItem[]): Promise<string[]> };
  portfolioSummaryGenerator?: { generate(sources: string[]): Promise<PortfolioSummaryResult> };
  portfolioFileSigner?: { createSignedUrl(userId: string, objectKey: string, expiresInSeconds: number): Promise<string> };
};

type AuthenticatedRoute = (handler: (req: Request, res: Response, actor: Actor) => Promise<void>) => RequestHandler;
type ProfileAccount = { userId: string; displayName: string; industryCodes: string[]; skills: string[]; careerYears: number | null; portfolioItems: Prisma.JsonValue | null; portfolioSummary: string | null; portfolioSummaryStatus: PortfolioSummaryStatus | null; portfolioConsentAt: Date | null; ndaAgreedAt: Date | null; ndaVersion: string | null; businessType: "BUSINESS" | "INDIVIDUAL" | null; bizRegNo: string | null; taxInvoiceEmail: string | null; payoutBank: string | null; payoutAccountNo: string | null; payoutHolder: string | null; payoutVerifiedAt: Date | null; ratingAvg: number | null; reviewCount: number; createdAt: Date };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function body(req: Request, fields: string[]): Record<string, unknown> {
  if (!isRecord(req.body) || Object.keys(req.body).some(key => !fields.includes(key))) throw new ProfileError("INVALID_REQUEST", 400);
  return req.body;
}

function text(value: unknown, field: string, max: number, nullable = false): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value.length > max) throw new ProfileError("INVALID_REQUEST", 400);
  const trimmed = value.trim();
  return trimmed || (nullable ? null : undefined);
}

function requiredText(value: unknown, field: string, max: number): string {
  const result = text(value, field, max);
  if (!result) throw new ProfileError("INVALID_REQUEST", 400);
  return result;
}

function nullableUrl(value: unknown, field: string): string | null | undefined {
  const result = text(value, field, 2048, true);
  if (typeof result === "string") {
    let parsed: URL;
    try { parsed = new URL(result); } catch { throw new ProfileError("INVALID_REQUEST", 400); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new ProfileError("INVALID_REQUEST", 400);
  }
  return result;
}

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ProfileError("INVALID_REQUEST", 400);
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 40 || value.some(item => typeof item !== "string" || !item.trim() || item.length > 100))
    throw new ProfileError("INVALID_REQUEST", 400);
  return [...new Set(value.map(item => (item as string).trim()))];
}

function safePortfolioLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      url.hostname.includes(".") && !/(^|\.)(localhost|local|internal)$/.test(url.hostname.toLowerCase()) &&
      !/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) && !url.hostname.includes(":");
  } catch { return false; }
}

function portfolioItems(value: unknown, userId: string): PortfolioItem[] {
  if (!Array.isArray(value) || value.length > 30) throw new ProfileError("INVALID_REQUEST", 400);
  return value.map(item => {
    if (!isRecord(item) || Object.keys(item).some(key => !["type", "url", "title"].includes(key)) ||
        (item.type !== "LINK" && item.type !== "FILE") || typeof item.url !== "string" || item.url.length > 2048)
      throw new ProfileError("INVALID_REQUEST", 400);
    const title = item.title === undefined ? undefined : text(item.title, "title", 120, true);
    if (item.type === "LINK") {
      if (!safePortfolioLink(item.url)) throw new ProfileError("INVALID_REQUEST", 400);
    } else {
      const prefix = `${userId}/portfolio/`;
      const path = item.url.startsWith(prefix) ? item.url.slice(prefix.length) : "";
      if (!path || !/^[A-Za-z0-9._/-]+$/.test(path) || path.split("/").some(part => !part || part === "." || part === ".."))
        throw new ProfileError("INVALID_REQUEST", 400);
    }
    return { type: item.type, url: item.url, ...(title ? { title } : {}) };
  });
}

function storedPortfolioItems(value: Prisma.JsonValue | null, userId: string): PortfolioItem[] {
  if (value === null) return [];
  try { return portfolioItems(value, userId); } catch { return []; }
}

function normalizePrivateNumber(value: string, field: string): string {
  if (!/^[0-9\-\s]+$/.test(value)) throw new ProfileError("INVALID_REQUEST", 400);
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4 || digits.length > 32) throw new ProfileError("INVALID_REQUEST", 400);
  return digits;
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function publicText(value: string | null): string | null {
  return value?.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[연락처 비공개]")
    .replace(/(?:\+?82[-\s]?)?0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, "[연락처 비공개]") ?? null;
}

function ownSupplierData(row: ProfileAccount, user: { name: string | null; bio: string | null; profileImageUrl: string | null }, ports: ProfilePorts) {
  return {
    name: user.name,
    profileImageUrl: user.profileImageUrl,
    bio: user.bio,
    displayName: row.displayName,
    industryCodes: row.industryCodes,
    skills: row.skills,
    careerYears: row.careerYears,
    portfolioItems: row.portfolioItems,
    portfolioSummary: row.portfolioSummary,
    portfolioSummaryStatus: row.portfolioSummaryStatus,
    portfolioConsentAt: row.portfolioConsentAt,
    ndaAgreedAt: row.ndaAgreedAt,
    ndaVersion: row.ndaVersion,
    businessType: row.businessType,
    bizRegNoMasked: maskProfileValue(row.bizRegNo, ports.encryptionKey),
    payoutBank: row.payoutBank,
    payoutAccountMasked: maskProfileValue(row.payoutAccountNo, ports.encryptionKey),
    payoutHolder: row.payoutHolder,
    payoutVerifiedAt: row.payoutVerifiedAt,
    ratingAvg: row.ratingAvg,
    reviewCount: row.reviewCount,
  };
}

type SupplierProfileStore = Pick<PrismaClient, "user" | "supplierProfile">;

async function upsertSupplier(db: SupplierProfileStore, userId: string, data: Prisma.SupplierProfileUpdateInput, createDisplayName?: string): Promise<ProfileAccount> {
  const [account, existing] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { name: true } }),
    db.supplierProfile.findUnique({ where: { userId }, select: { displayName: true } }),
  ]);
  // 기존 프로필의 displayName은 유효한 값이므로 부분 수정(NDA 동의 등)에서 다시 요구하지 않는다.
  const displayName = createDisplayName ?? account?.name ?? existing?.displayName;
  if (!displayName) throw new ProfileError("SUPPLIER_PROFILE_INCOMPLETE", 422);
  return db.supplierProfile.upsert({
    where: { userId },
    create: { userId, displayName, industryCodes: [], skills: [], ...data } as Prisma.SupplierProfileUncheckedCreateInput,
    update: data,
  }) as Promise<ProfileAccount>;
}

export function createPayoutAccountStatusPort(db: PrismaClient) {
  const isVerified = async (userId: string): Promise<boolean> => {
    const row = await db.supplierProfile.findUnique({ where: { userId }, select: { payoutVerifiedAt: true } });
    return row?.payoutVerifiedAt !== null && row?.payoutVerifiedAt !== undefined;
  };
  return {
    isVerified,
    async requireVerified(userId: string): Promise<void> {
      if (!await isVerified(userId)) throw new ProfileError("PAYOUT_ACCOUNT_UNVERIFIED", 409);
    },
  };
}

export function createProfileRatingPort(db: PrismaClient) {
  async function refreshInTransaction(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user || (user.role !== Role.CLIENT && user.role !== Role.SUPPLIER)) return;
    if (user.role === Role.CLIENT) {
      await tx.$queryRaw`SELECT "userId" FROM client_profiles WHERE "userId" = ${userId} FOR UPDATE`;
      if (!await tx.clientProfile.findUnique({ where: { userId }, select: { userId: true } })) return;
      const [rating, reviewCount] = await Promise.all([
        tx.review.aggregate({ where: { revieweeId: userId }, _avg: { rating: true } }),
        tx.review.count({ where: { revieweeId: userId } }),
      ]);
      await tx.clientProfile.update({ where: { userId }, data: { ratingAvg: rating._avg.rating, reviewCount } });
      return;
    }
    await tx.$queryRaw`SELECT "userId" FROM supplier_profiles WHERE "userId" = ${userId} FOR UPDATE`;
    if (!await tx.supplierProfile.findUnique({ where: { userId }, select: { userId: true } })) return;
    const [rating, reviewCount] = await Promise.all([
      tx.review.aggregate({ where: { revieweeId: userId }, _avg: { rating: true } }),
      tx.review.count({ where: { revieweeId: userId } }),
    ]);
    await tx.supplierProfile.update({ where: { userId }, data: { ratingAvg: rating._avg.rating, reviewCount } });
  }

  return {
    /** 같은 tx를 넘기면 그 tx에서 평점을 갱신한다(리뷰 생성과 원자적). */
    async refresh(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
      if (tx !== undefined) return refreshInTransaction(tx, userId);
      await db.$transaction((inner) => refreshInTransaction(inner, userId));
    },
  };
}

export function mountProfileApi(router: Router, db: PrismaClient, ports: ProfilePorts, now: () => Date, authenticated: AuthenticatedRoute): void {
  router.get("/me/client-profile", authenticated(async (_req, res, actor) => {
    if (actor.role !== Role.CLIENT) throw new ProfileError("ROLE_MISMATCH", 403);
    const row = await db.clientProfile.findUnique({ where: { userId: actor.userId } });
    const user = await db.user.findUnique({ where: { id: actor.userId }, select: { name: true, profileImageUrl: true, bio: true } });
    res.json({ data: row && user ? {
      name: user.name, profileImageUrl: user.profileImageUrl, bio: user.bio,
      businessName: row.businessName, industryField: row.industryField, storeAddress: row.storeAddress,
      websiteUrl: row.websiteUrl, profileCompleted: row.profileCompleted,
    } : null });
  }));

  router.patch("/me/client-profile", authenticated(async (req, res, actor) => {
    if (actor.role !== Role.CLIENT) throw new ProfileError("ROLE_MISMATCH", 403);
    const input = body(req, ["name", "profileImageUrl", "bio", "businessName", "industryField", "storeAddress", "websiteUrl"]);
    const userData: Prisma.UserUpdateInput = {};
    for (const field of ["name", "bio", "profileImageUrl"] as const) {
      if (!(field in input)) continue;
      const value = field === "profileImageUrl" ? nullableUrl(input[field], field) : text(input[field], field, field === "bio" ? 2000 : 100, true);
      if (value !== undefined) userData[field] = value;
    }
    const profileData: Prisma.ClientProfileUpdateInput = {};
    for (const field of ["businessName", "industryField", "storeAddress", "websiteUrl"] as const) {
      if (!(field in input)) continue;
      const value = field === "websiteUrl" ? nullableUrl(input[field], field) : text(input[field], field, field === "storeAddress" ? 500 : 200, true);
      if (value !== undefined) profileData[field] = value;
    }
    if (!Object.keys(userData).length && !Object.keys(profileData).length) throw new ProfileError("INVALID_REQUEST", 400);
    await db.$transaction(async tx => {
      if (Object.keys(userData).length) await tx.user.update({ where: { id: actor.userId }, data: userData });
      if (Object.keys(profileData).length) {
        const existing = await tx.clientProfile.findUnique({ where: { userId: actor.userId }, select: { businessName: true } });
        const nextName = profileData.businessName === undefined ? existing?.businessName : profileData.businessName;
        await tx.clientProfile.upsert({
          where: { userId: actor.userId },
          create: { userId: actor.userId, ...profileData, profileCompleted: typeof nextName === "string" && nextName.trim().length > 0 } as Prisma.ClientProfileUncheckedCreateInput,
          update: { ...profileData, profileCompleted: typeof nextName === "string" && nextName.trim().length > 0 },
        });
      }
    });
    const row = await db.clientProfile.findUnique({ where: { userId: actor.userId } });
    const user = await db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true, profileImageUrl: true, bio: true } });
    res.json({ data: row ? {
      name: user.name, profileImageUrl: user.profileImageUrl, bio: user.bio,
      businessName: row.businessName, industryField: row.industryField, storeAddress: row.storeAddress,
      websiteUrl: row.websiteUrl, profileCompleted: row.profileCompleted,
    } : null });
  }));

  router.get("/me/supplier-profile", authenticated(async (_req, res, actor) => {
    if (actor.role !== Role.SUPPLIER) throw new ProfileError("ROLE_MISMATCH", 403);
    const [row, user] = await Promise.all([
      db.supplierProfile.findUnique({ where: { userId: actor.userId } }) as Promise<ProfileAccount | null>,
      db.user.findUnique({ where: { id: actor.userId }, select: { name: true, bio: true, profileImageUrl: true } }),
    ]);
    res.json({ data: row && user ? ownSupplierData(row, user, ports) : null });
  }));

  router.patch("/me/supplier-profile", authenticated(async (req, res, actor) => {
    if (actor.role !== Role.SUPPLIER) throw new ProfileError("ROLE_MISMATCH", 403);
    const input = body(req, ["name", "profileImageUrl", "bio", "displayName", "industryCodes", "skills", "careerYears", "portfolioItems", "portfolioConsent", "ndaConsent"]);
    const displayName = "displayName" in input ? requiredText(input.displayName, "displayName", 100) : undefined;
    const industryCodes = "industryCodes" in input ? stringList(input.industryCodes, "industryCodes") : undefined;
    const skills = "skills" in input ? stringList(input.skills, "skills") : undefined;
    let careerYears: number | null | undefined;
    if ("careerYears" in input) {
      if (input.careerYears !== null && (!Number.isInteger(input.careerYears) || (input.careerYears as number) < 0 || (input.careerYears as number) > 80)) throw new ProfileError("INVALID_REQUEST", 400);
      careerYears = input.careerYears as number | null;
    }
    const itemsChanged = "portfolioItems" in input;
    const nextItems = itemsChanged ? (input.portfolioItems === null ? null : portfolioItems(input.portfolioItems, actor.userId)) : null;
    const consent = flag(input.portfolioConsent, "portfolioConsent");
    const ndaConsent = flag(input.ndaConsent, "ndaConsent");
    if (ndaConsent === true && !ports.supplierNdaVersion) throw new ProfileError("NDA_UNAVAILABLE", 503);
    const userData: Prisma.UserUpdateInput = {};
    if ("name" in input) {
      const value = text(input.name, "name", 100, true);
      if (value !== undefined) userData.name = value;
    }
    if ("bio" in input) {
      const value = text(input.bio, "bio", 2000, true);
      if (value !== undefined) userData.bio = value;
    }
    if ("profileImageUrl" in input) {
      const value = nullableUrl(input.profileImageUrl, "profileImageUrl");
      if (value !== undefined) userData.profileImageUrl = value;
    }
    const row = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "userId" FROM supplier_profiles WHERE "userId" = ${actor.userId} FOR UPDATE`;
      const current = await tx.supplierProfile.findUnique({ where: { userId: actor.userId } }) as ProfileAccount | null;
      const update: Prisma.SupplierProfileUpdateInput = {};
      if (displayName !== undefined) update.displayName = displayName;
      if (industryCodes !== undefined) update.industryCodes = industryCodes;
      if (skills !== undefined) update.skills = skills;
      if (careerYears !== undefined) update.careerYears = careerYears;
      if (itemsChanged && JSON.stringify(current?.portfolioItems ?? null) !== JSON.stringify(nextItems)) {
        update.portfolioItems = nextItems === null ? Prisma.DbNull : nextItems as Prisma.InputJsonValue;
        update.portfolioSummary = null;
        update.portfolioSummaryStatus = PortfolioSummaryStatus.DRAFT;
        update.portfolioSummarizedAt = null;
        update.portfolioConsentAt = null;
      }
      if (consent === true) update.portfolioConsentAt = now();
      if (consent === false) {
        update.portfolioConsentAt = null;
        update.portfolioSummaryStatus = PortfolioSummaryStatus.HIDDEN;
      }
      if (ndaConsent === true) {
        update.ndaAgreedAt = now();
        update.ndaVersion = ports.supplierNdaVersion!;
      } else if (ndaConsent === false) {
        update.ndaAgreedAt = null;
        update.ndaVersion = null;
      }
      if (!Object.keys(update).length && !Object.keys(userData).length) throw new ProfileError("INVALID_REQUEST", 400);
      if (Object.keys(userData).length) await tx.user.update({ where: { id: actor.userId }, data: userData });
      if (!Object.keys(update).length) return current;
      return upsertSupplier(tx, actor.userId, update, displayName);
    });
    const user = await db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true, bio: true, profileImageUrl: true } });
    res.json({ data: row ? ownSupplierData(row, user, ports) : null });
  }));

  router.patch("/me/client-tax-info", authenticated(async (req, res, actor) => {
    if (actor.role !== Role.CLIENT) throw new ProfileError("ROLE_MISMATCH", 403);
    const input = body(req, ["bizRegNo", "taxInvoiceEmail"]);
    if (!Object.keys(input).length) throw new ProfileError("INVALID_REQUEST", 400);
    const data: Prisma.ClientProfileUpdateInput = {};
    if ("bizRegNo" in input) {
      const value = text(input.bizRegNo, "bizRegNo", 40, true);
      data.bizRegNo = value === undefined || value === null ? value : encryptProfileValue(normalizePrivateNumber(value, "bizRegNo"), ports.encryptionKey);
    }
    if ("taxInvoiceEmail" in input) {
      const value = text(input.taxInvoiceEmail, "taxInvoiceEmail", 254, true);
      if (value && !validEmail(value)) throw new ProfileError("INVALID_REQUEST", 400);
      data.taxInvoiceEmail = value === undefined || value === null ? value : encryptProfileValue(value, ports.encryptionKey);
    }
    const row = await db.clientProfile.upsert({ where: { userId: actor.userId }, create: { userId: actor.userId, ...data } as Prisma.ClientProfileUncheckedCreateInput, update: data });
    res.json({ data: {
      bizRegNoMasked: maskProfileValue(row.bizRegNo, ports.encryptionKey),
      taxInvoiceEmail: row.taxInvoiceEmail ? decryptProfileValue(row.taxInvoiceEmail, ports.encryptionKey) : null,
    } });
  }));

  router.patch("/me/supplier-tax-info", authenticated(async (req, res, actor) => {
    if (actor.role !== Role.SUPPLIER) throw new ProfileError("ROLE_MISMATCH", 403);
    const input = body(req, ["businessType", "bizRegNo", "taxInvoiceEmail"]);
    if (!Object.keys(input).length) throw new ProfileError("INVALID_REQUEST", 400);
    const data: Prisma.SupplierProfileUpdateInput = {};
    if ("businessType" in input) {
      if (input.businessType !== null && input.businessType !== "BUSINESS" && input.businessType !== "INDIVIDUAL") throw new ProfileError("INVALID_REQUEST", 400);
      data.businessType = input.businessType;
    }
    if ("bizRegNo" in input) {
      const value = text(input.bizRegNo, "bizRegNo", 40, true);
      data.bizRegNo = value === undefined || value === null ? value : encryptProfileValue(normalizePrivateNumber(value, "bizRegNo"), ports.encryptionKey);
    }
    if ("taxInvoiceEmail" in input) {
      const value = text(input.taxInvoiceEmail, "taxInvoiceEmail", 254, true);
      if (value && !validEmail(value)) throw new ProfileError("INVALID_REQUEST", 400);
      data.taxInvoiceEmail = value === undefined || value === null ? value : encryptProfileValue(value, ports.encryptionKey);
    }
    const row = await upsertSupplier(db, actor.userId, data);
    res.json({ data: {
      businessType: row.businessType,
      bizRegNoMasked: maskProfileValue(row.bizRegNo, ports.encryptionKey),
      taxInvoiceEmail: row.taxInvoiceEmail ? decryptProfileValue(row.taxInvoiceEmail, ports.encryptionKey) : null,
    } });
  }));

  router.patch("/me/payout-account", authenticated(async (req, res, actor) => {
    if (actor.role !== Role.SUPPLIER) throw new ProfileError("ROLE_MISMATCH", 403);
    const input = body(req, ["bank", "accountNo", "holder"]);
    const bank = requiredText(input.bank, "bank", 100);
    const accountNo = normalizePrivateNumber(requiredText(input.accountNo, "accountNo", 40), "accountNo");
    const holder = requiredText(input.holder, "holder", 100).normalize("NFC");
    const current = await db.supplierProfile.findUnique({ where: { userId: actor.userId } }) as ProfileAccount | null;
    const user = await db.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    const matchesAccountName = holder === user?.name?.normalize("NFC");
    const matchesBusinessName = current?.businessType === "BUSINESS" && holder === current.displayName.normalize("NFC");
    if (!matchesAccountName && !matchesBusinessName) throw new ProfileError("PAYOUT_HOLDER_MISMATCH", 422);
    const encrypted = encryptProfileValue(accountNo, ports.encryptionKey);
    const row = await upsertSupplier(db, actor.userId, {
      payoutBank: bank,
      payoutAccountNo: encrypted,
      payoutHolder: holder,
      payoutVerifiedAt: null,
    });
    res.json({ data: { bank: row.payoutBank, accountMasked: maskProfileValue(row.payoutAccountNo, ports.encryptionKey), holder: row.payoutHolder, verifiedAt: null } });
  }));

  router.post("/me/payout-account/verify", authenticated(async (req, res, actor) => {
    if (actor.role !== Role.SUPPLIER) throw new ProfileError("ROLE_MISMATCH", 403);
    const input = body(req, ["code"]);
    const code = requiredText(input.code, "code", 100);
    const row = await db.supplierProfile.findUnique({ where: { userId: actor.userId } }) as ProfileAccount | null;
    if (!row?.payoutBank || !row.payoutAccountNo || !row.payoutHolder) throw new ProfileError("PAYOUT_ACCOUNT_INCOMPLETE", 409);
    if (!ports.payoutVerification) throw new ProfileError("PAYOUT_VERIFICATION_UNAVAILABLE", 503);
    const accountNo = decryptProfileValue(row.payoutAccountNo, ports.encryptionKey);
    const verified = await ports.payoutVerification.verify({ userId: actor.userId, bank: row.payoutBank, accountNo, holder: row.payoutHolder, code });
    if (!verified) throw new ProfileError("PAYOUT_VERIFICATION_FAILED", 422);
    const verifiedAt = now();
    const updated = await db.supplierProfile.updateMany({
      where: { userId: actor.userId, payoutBank: row.payoutBank, payoutAccountNo: row.payoutAccountNo, payoutHolder: row.payoutHolder, payoutVerifiedAt: null },
      data: { payoutVerifiedAt: verifiedAt },
    });
    if (updated.count !== 1) throw new ProfileError("PAYOUT_ACCOUNT_CHANGED", 409);
    res.json({ data: { verified: true, verifiedAt: verifiedAt.toISOString() } });
  }));

  router.post("/me/portfolio-summary/regenerate", authenticated(async (_req, res, actor) => {
    if (actor.role !== Role.SUPPLIER) throw new ProfileError("ROLE_MISMATCH", 403);
    if (!ports.portfolioSourceReader || !ports.portfolioSummaryGenerator) throw new ProfileError("PORTFOLIO_GENERATION_UNAVAILABLE", 503);
    const time = now();
    const start = new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()));
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const reservation = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "userId" FROM supplier_profiles WHERE "userId" = ${actor.userId} FOR UPDATE`;
      const row = await tx.supplierProfile.findUnique({ where: { userId: actor.userId } }) as ProfileAccount | null;
      if (!row) throw new ProfileError("SUPPLIER_PROFILE_NOT_FOUND", 404);
      if (!row.portfolioConsentAt) throw new ProfileError("PORTFOLIO_CONSENT_REQUIRED", 409);
      const items = storedPortfolioItems(row.portfolioItems, actor.userId);
      if (!items.length) throw new ProfileError("PORTFOLIO_ITEMS_REQUIRED", 409);
      const logs = await tx.eventLog.findMany({ where: { userId: actor.userId, type: EventType.LLM_CALLED, occurredAt: { gte: start, lt: end } }, select: { payload: true } });
      const used = logs.filter(log => isRecord(log.payload) && log.payload.purpose === "PORTFOLIO_SUMMARY").length;
      if (used >= 5) throw new ProfileError("PORTFOLIO_DAILY_LIMIT", 429);
      const event = await tx.eventLog.create({
        data: { userId: actor.userId, type: EventType.LLM_CALLED, occurredAt: time, payload: { purpose: "PORTFOLIO_SUMMARY", model: "pending", tokens: { input: 0, output: 0 }, costKrw: 0, latencyMs: 0, succeeded: false, reserved: true } },
      });
      return { row, items, eventId: event.id };
    });
    try {
      const sources = await ports.portfolioSourceReader.read(actor.userId, reservation.items);
      if (!Array.isArray(sources) || sources.some(source => typeof source !== "string" || source.length > 25_000) || sources.join("").length > 50_000)
        throw new Error("INVALID_PORTFOLIO_SOURCE_RESULT");
      const generatedAt = performance.now();
      const result = await ports.portfolioSummaryGenerator.generate(sources);
      const summary = typeof result?.summary === "string" ? result.summary.trim() : "";
      const tokens = result?.tokens;
      if (!summary || summary.length > 5000 || typeof result.model !== "string" || !result.model.trim() || result.model.length > 100 ||
          !tokens || !Number.isSafeInteger(tokens.input) || tokens.input < 0 || !Number.isSafeInteger(tokens.output) || tokens.output < 0 ||
          !Number.isSafeInteger(result.costKrw) || result.costKrw < 0)
        throw new Error("INVALID_PORTFOLIO_SUMMARY_RESULT");
      const latencyMs = Math.max(0, Math.round(performance.now() - generatedAt));
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT "userId" FROM supplier_profiles WHERE "userId" = ${actor.userId} FOR UPDATE`;
        const current = await tx.supplierProfile.findUnique({ where: { userId: actor.userId } }) as ProfileAccount | null;
        if (!current || !current.portfolioConsentAt || JSON.stringify(current.portfolioItems) !== JSON.stringify(reservation.row.portfolioItems))
          throw new ProfileError("PORTFOLIO_CHANGED_DURING_GENERATION", 409);
        await tx.supplierProfile.update({
          where: { userId: actor.userId },
          data: { portfolioSummary: summary, portfolioSummaryStatus: PortfolioSummaryStatus.DRAFT, portfolioSummarizedAt: now() },
        });
        await tx.eventLog.update({ where: { id: reservation.eventId }, data: { payload: {
          purpose: "PORTFOLIO_SUMMARY", model: result.model, tokens, costKrw: result.costKrw, latencyMs, succeeded: true,
        } } });
        await tx.eventLog.create({ data: { userId: actor.userId, type: EventType.PORTFOLIO_SUMMARIZED, payload: { status: PortfolioSummaryStatus.DRAFT }, occurredAt: now() } });
      });
      res.json({ data: { summary, status: PortfolioSummaryStatus.DRAFT } });
    } catch (error) {
      await db.eventLog.updateMany({ where: { id: reservation.eventId }, data: { payload: {
        purpose: "PORTFOLIO_SUMMARY", model: "unknown", tokens: { input: 0, output: 0 }, costKrw: 0, latencyMs: 0, succeeded: false,
      } } });
      if (error instanceof ProfileError) throw error;
      throw new ProfileError("PORTFOLIO_GENERATION_FAILED", 503);
    }
  }));

  router.post("/me/portfolio-summary/publish", authenticated(async (_req, res, actor) => {
    if (actor.role !== Role.SUPPLIER) throw new ProfileError("ROLE_MISMATCH", 403);
    const row = await db.supplierProfile.findUnique({ where: { userId: actor.userId }, select: { portfolioSummary: true, portfolioSummaryStatus: true, portfolioConsentAt: true } });
    if (!row?.portfolioConsentAt || !row.portfolioSummary || row.portfolioSummaryStatus !== PortfolioSummaryStatus.DRAFT)
      throw new ProfileError("PORTFOLIO_NOT_READY", 409);
    await db.supplierProfile.update({ where: { userId: actor.userId }, data: { portfolioSummaryStatus: PortfolioSummaryStatus.PUBLISHED } });
    res.json({ data: { status: PortfolioSummaryStatus.PUBLISHED } });
  }));

  router.post("/me/portfolio-summary/hide", authenticated(async (_req, res, actor) => {
    if (actor.role !== Role.SUPPLIER) throw new ProfileError("ROLE_MISMATCH", 403);
    await db.supplierProfile.updateMany({ where: { userId: actor.userId }, data: { portfolioSummaryStatus: PortfolioSummaryStatus.HIDDEN } });
    res.json({ data: { status: PortfolioSummaryStatus.HIDDEN } });
  }));

  router.get("/profiles/suppliers/:supplierId", async (req, res) => {
    const supplierId = req.params.supplierId;
    const row = await db.supplierProfile.findUnique({
      where: { userId: supplierId },
      include: { user: { select: { id: true, name: true, profileImageUrl: true, bio: true, createdAt: true, withdrawnAt: true } } },
    });
    if (!row || row.user.withdrawnAt) throw new ProfileError("SUPPLIER_PROFILE_NOT_FOUND", 404);
    const published = row.portfolioSummaryStatus === PortfolioSummaryStatus.PUBLISHED && row.portfolioConsentAt !== null;
    const items: Array<{ type: "LINK" | "FILE"; title?: string; url: string }> = [];
    if (published) {
      for (const item of storedPortfolioItems(row.portfolioItems, supplierId)) {
        if (item.type === "LINK") items.push({ type: "LINK", ...(item.title ? { title: item.title } : {}), url: item.url });
        else if (ports.portfolioFileSigner) {
          const url = await ports.portfolioFileSigner.createSignedUrl(supplierId, item.url, 300);
          if (safePortfolioLink(url)) items.push({ type: "FILE", ...(item.title ? { title: item.title } : {}), url });
        }
      }
    }
    const completedContractCount = await db.contract.count({ where: { status: ContractStatus.COMPLETED, application: { supplierId } } });
    res.json({ data: {
      supplierId,
      name: row.user.name,
      profileImageUrl: row.user.profileImageUrl,
      bio: publicText(row.user.bio),
      displayName: row.displayName,
      createdAt: row.user.createdAt,
      industryCodes: row.industryCodes,
      skills: row.skills,
      careerYears: row.careerYears,
      ratingAvg: row.ratingAvg,
      reviewCount: row.reviewCount,
      completedContractCount,
      portfolioSummary: published ? publicText(row.portfolioSummary) : null,
      portfolioItems: items,
    } });
  });

  router.get("/projects/:projectId/client-profile", authenticated(async (req, res, actor) => {
    if (actor.role !== Role.SUPPLIER) throw new ProfileError("ROLE_MISMATCH", 403);
    if (!ports.supplierNdaVersion) throw new ProfileError("NDA_UNAVAILABLE", 503);
    const supplier = await db.supplierProfile.findUnique({ where: { userId: actor.userId }, select: { ndaAgreedAt: true, ndaVersion: true } });
    if (!supplier?.ndaAgreedAt || supplier.ndaVersion !== ports.supplierNdaVersion) throw new ProfileError("SUPPLIER_NDA_REQUIRED", 403);
    const projectId = req.params.projectId;
    if (typeof projectId !== "string") throw new ProfileError("INVALID_REQUEST", 400);
    const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, deletedAt: true, draft: { select: { clientId: true } } } });
    if (!project || project.deletedAt) throw new ProfileError("PROJECT_NOT_FOUND", 404);
    const viewed = await db.eventLog.findFirst({ where: { userId: actor.userId, projectId: project.id, type: EventType.SPEC_DETAIL_VIEWED }, select: { id: true } });
    if (!viewed) throw new ProfileError("PROJECT_DETAIL_REQUIRED", 403);
    const [client, recruitingProjectCount] = await Promise.all([
      db.clientProfile.findUnique({
        where: { userId: project.draft.clientId },
        include: { user: { select: { name: true, profileImageUrl: true, bio: true, createdAt: true } } },
      }),
      db.project.count({ where: { status: ProjectStatus.RECRUITING, deletedAt: null, draft: { is: { clientId: project.draft.clientId } } } }),
    ]);
    if (!client?.profileCompleted || !client.businessName) throw new ProfileError("CLIENT_PROFILE_NOT_FOUND", 404);
    await db.eventLog.create({ data: { userId: actor.userId, projectId: project.id, type: EventType.CLIENT_PROFILE_VIEWED, occurredAt: now() } });
    res.json({ data: {
      name: client.user.name,
      profileImageUrl: client.user.profileImageUrl,
      bio: client.user.bio,
      businessName: client.businessName,
      industryField: client.industryField,
      storeAddress: client.storeAddress,
      websiteUrl: client.websiteUrl,
      createdAt: client.user.createdAt,
      ratingAvg: client.ratingAvg,
      reviewCount: client.reviewCount,
      recruitingProjectCount,
    } });
  }));
}
