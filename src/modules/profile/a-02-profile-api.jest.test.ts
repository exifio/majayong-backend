import { afterAll, describe, expect, it, jest } from "@jest/globals";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { ContractStatus, EventType, PrismaClient, Role } from "@prisma/client";
import { createApp } from "../../app.ts";
import { issueAccessToken } from "../identity/auth.ts";
import * as profileApi from "./api.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/majayong_a00_test")
  throw new Error("A-02 tests require dedicated majayong_a00_test database");
process.env.DATABASE_URL = databaseUrl;
const prisma = new PrismaClient();
const secret = "a-02-profile-test-token-secret-longer-than-32-bytes";
const encryptionKey = Buffer.alloc(32, 17).toString("base64");
const now = new Date("2026-11-03T09:00:00.000Z");
const createdUsers = new Set<string>();
const createdProjects = new Set<string>();
const createdDrafts = new Set<string>();
const createdApplications = new Set<string>();
const createdContracts = new Set<string>();

type Account = { id: string; token: string };

async function user(role: Role, name = "Profile User"): Promise<Account> {
  const row = await prisma.user.create({ data: { email: `a02-${randomUUID()}@example.invalid`, role, name } });
  createdUsers.add(row.id);
  return { id: row.id, token: issueAccessToken({ userId: row.id, role, expiresAt: now.getTime() + 60_000 }, secret) };
}

async function supplier(name = "Supplier Name"): Promise<Account> {
  const account = await user(Role.SUPPLIER, name);
  await prisma.supplierProfile.create({ data: { userId: account.id, displayName: name, industryCodes: ["CAFE"], skills: ["POS"] } });
  return account;
}

async function withServer<T>(profile: Record<string, unknown>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: Server = createServer(createApp({ db: prisma, tokenSecret: secret, now: () => now, profile: profile as never }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind");
  try { return await run(`http://127.0.0.1:${address.port}/api/v1`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function request(baseUrl: string, method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createProject(clientId: string): Promise<string> {
  const draftId = randomUUID();
  const projectId = randomUUID();
  createdDrafts.add(draftId);
  createdProjects.add(projectId);
  await prisma.draft.create({ data: { id: draftId, clientId, entryType: "SENTENCE" } });
  await prisma.project.create({
    data: {
      id: projectId,
      draftId,
      confirmedAt: now,
      disclosureConsentVersion: "disclosure-v1",
      title: "Client project",
      summary: "Public project summary",
      industryCode: "CAFE",
      requiredSkills: [],
    },
  });
  return projectId;
}

afterAll(async () => {
  const ids = [...createdUsers];
  const projectIds = [...createdProjects];
  const draftIds = [...createdDrafts];
  const applicationIds = [...createdApplications];
  const contractIds = [...createdContracts];
  if (projectIds.length) await prisma.eventLog.deleteMany({ where: { projectId: { in: projectIds } } });
  if (ids.length) await prisma.eventLog.deleteMany({ where: { userId: { in: ids } } });
  if (contractIds.length) await prisma.review.deleteMany({ where: { contractId: { in: contractIds } } });
  if (contractIds.length) await prisma.contract.deleteMany({ where: { id: { in: contractIds } } });
  if (applicationIds.length) await prisma.application.deleteMany({ where: { id: { in: applicationIds } } });
  if (projectIds.length) await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  if (draftIds.length) await prisma.draft.deleteMany({ where: { id: { in: draftIds } } });
  if (ids.length) {
    await prisma.clientProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.supplierProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
});

describe("A-02 프로필·공개 정보 API", () => {
  it("의뢰인·공급자의 교차 역할 프로필 변경을 막는다", async () => {
    // 준비
    const client = await user(Role.CLIENT);
    const vendor = await supplier();
    await withServer({ encryptionKey }, async baseUrl => {
      // 실행
      const clientToSupplier = await request(baseUrl, "PATCH", "/me/supplier-profile", client.token, { displayName: "intrusion" });
      const supplierToClient = await request(baseUrl, "PATCH", "/me/client-profile", vendor.token, { businessName: "intrusion" });

      // 확인
      expect(clientToSupplier.status).toBe(403);
      expect(supplierToClient.status).toBe(403);

      // 실행
      const clientPatch = await request(baseUrl, "PATCH", "/me/client-profile", client.token, { name: "Client One", businessName: "Shop One", industryField: "Cafe" });

      // 확인
      expect(clientPatch.status).toBe(200);
      expect((await clientPatch.json() as { data: Record<string, unknown> }).data).toMatchObject({ name: "Client One", businessName: "Shop One", profileCompleted: true });

      // 실행 및 확인
      const clientGet = await request(baseUrl, "GET", "/me/client-profile", client.token);
      expect((await clientGet.json() as { data: Record<string, unknown> }).data).toMatchObject({ industryField: "Cafe" });

      // 실행
      const tax = await request(baseUrl, "PATCH", "/me/client-tax-info", client.token, { bizRegNo: "123-45-67890", taxInvoiceEmail: "client-private@example.invalid" });

      // 확인
      expect(tax.status).toBe(200);
      const taxData = (await tax.json() as { data: Record<string, unknown> }).data;
      expect(taxData).toMatchObject({ bizRegNoMasked: "******7890", taxInvoiceEmail: "client-private@example.invalid" });
      const storedClient = await prisma.clientProfile.findUniqueOrThrow({ where: { userId: client.id } });
      expect(storedClient.bizRegNo).toMatch(/^enc:v1:/);
      expect(storedClient.taxInvoiceEmail).toMatch(/^enc:v1:/);
      expect(JSON.stringify(storedClient)).not.toContain("1234567890");
      expect(JSON.stringify(storedClient)).not.toContain("client-private@example.invalid");
    });

    // 확인
    expect(await prisma.supplierProfile.findUniqueOrThrow({ where: { userId: vendor.id } })).toMatchObject({ displayName: "Supplier Name" });
    expect(await prisma.clientProfile.findUnique({ where: { userId: client.id } })).toMatchObject({ businessName: "Shop One", profileCompleted: true });
  });

  it("세금·지급 식별자를 암호화하고 조회는 마스킹하며 실패한 검증은 미검증으로 둔다", async () => {
    // 준비
    const vendor = await supplier();
    const verify = jest.fn(async () => false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await withServer({ encryptionKey, payoutVerification: { verify } }, async baseUrl => {
      // 실행
      const tax = await request(baseUrl, "PATCH", "/me/supplier-tax-info", vendor.token, {
        businessType: "BUSINESS", bizRegNo: "123-45-67890", taxInvoiceEmail: "private@example.invalid",
      });

      // 확인
      expect(tax.status).toBe(200);

      // 실행
      const payout = await request(baseUrl, "PATCH", "/me/payout-account", vendor.token, {
        bank: "KB", accountNo: "1234567890", holder: "Supplier Name",
      });

      // 확인
      expect(payout.status).toBe(200);
      const stored = await prisma.supplierProfile.findUniqueOrThrow({ where: { userId: vendor.id } });
      expect(stored.bizRegNo).toMatch(/^enc:v1:/);
      expect(stored.payoutAccountNo).toMatch(/^enc:v1:/);
      expect(stored.taxInvoiceEmail).toMatch(/^enc:v1:/);
      expect(stored.bizRegNo).not.toContain("1234567890");
      expect(stored.payoutAccountNo).not.toContain("1234567890");
      expect(stored.taxInvoiceEmail).not.toContain("private@example.invalid");

      // 실행
      const failed = await request(baseUrl, "POST", "/me/payout-account/verify", vendor.token, { code: "000001" });

      // 확인
      expect(failed.status).toBe(422);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(await prisma.supplierProfile.findUniqueOrThrow({ where: { userId: vendor.id } })).toMatchObject({ payoutVerifiedAt: null });

      // 실행
      const ownProfile = await request(baseUrl, "GET", "/me/supplier-profile", vendor.token);

      // 확인
      expect(ownProfile.status).toBe(200);
      const ownData = (await ownProfile.json() as { data: Record<string, unknown> }).data;
      expect(ownData.payoutAccountMasked).toBe("******7890");
      expect(JSON.stringify(ownData)).not.toContain("1234567890");
      expect(ownData).not.toHaveProperty("taxInvoiceEmail");

      // 실행
      const success = await request(baseUrl, "POST", "/me/payout-account/verify", vendor.token, { code: "000002" });

      // 확인
      expect(success.status).toBe(200);
      expect(await profileApi.createPayoutAccountStatusPort(prisma).isVerified(vendor.id)).toBe(true);

      // 실행 및 확인
      await expect(profileApi.createPayoutAccountStatusPort(prisma).requireVerified(vendor.id)).resolves.toBeUndefined();

      // 실행
      await request(baseUrl, "PATCH", "/me/payout-account", vendor.token, { bank: "KB", accountNo: "9999999999", holder: "Supplier Name" });

      // 확인
      expect(await profileApi.createPayoutAccountStatusPort(prisma).isVerified(vendor.id)).toBe(false);

      // 실행 및 확인
      await expect(profileApi.createPayoutAccountStatusPort(prisma).requireVerified(vendor.id)).rejects.toMatchObject({ code: "PAYOUT_ACCOUNT_UNVERIFIED" });
    });
  });

  it("비공급자와 예금주 불일치의 지급 계좌 변경을 거부한다", async () => {
    // 준비
    const client = await user(Role.CLIENT, "Some Client");
    const vendor = await supplier("Supplier Name");
    await withServer({ encryptionKey }, async baseUrl => {
      // 실행
      const crossRole = await request(baseUrl, "PATCH", "/me/payout-account", client.token, { bank: "KB", accountNo: "12345678", holder: "Some Client" });

      // 확인
      expect(crossRole.status).toBe(403);

      // 실행
      const mismatch = await request(baseUrl, "PATCH", "/me/payout-account", vendor.token, { bank: "KB", accountNo: "12345678", holder: "Someone Else" });

      // 확인
      expect(mismatch.status).toBe(422);
      expect((await mismatch.json() as { error: { code: string } }).error.code).toBe("PAYOUT_HOLDER_MISMATCH");

      // 실행
      const invalidAccount = await request(baseUrl, "PATCH", "/me/payout-account", vendor.token, { bank: "KB", accountNo: "abc", holder: "Supplier Name" });

      // 확인
      expect(invalidAccount.status).toBe(400);

      // 실행
      const accepted = await request(baseUrl, "PATCH", "/me/payout-account", vendor.token, { bank: "KB", accountNo: "12345678", holder: "Supplier Name" });

      // 확인
      expect(accepted.status).toBe(200);
      expect(await prisma.supplierProfile.findUniqueOrThrow({ where: { userId: vendor.id } })).toMatchObject({ payoutVerifiedAt: null });
    });
  });

  it("동의를 요구하고 동시 요청에서도 일일 요약 생성을 5회로 제한한다", async () => {
    // 준비
    const vendor = await supplier();
    const sourceText = "private source text that must not enter event logs";
    const sourceReader = { read: jest.fn(async () => [sourceText]) };
    const generator = { generate: jest.fn(async () => ({ summary: "Draft portfolio summary", model: "mock", tokens: { input: 1, output: 2 }, costKrw: 0 })) };
    await withServer({ portfolioSourceReader: sourceReader, portfolioSummaryGenerator: generator }, async baseUrl => {
      // 실행
      const withoutConsent = await request(baseUrl, "POST", "/me/portfolio-summary/regenerate", vendor.token, {});

      // 확인
      expect(withoutConsent.status).toBe(409);
      expect(sourceReader.read).not.toHaveBeenCalled();

      // 실행
      const consent = await request(baseUrl, "PATCH", "/me/supplier-profile", vendor.token, {
        portfolioItems: [{ type: "LINK", url: "https://portfolio.example.invalid/work", title: "Work" }],
        portfolioConsent: true,
      });

      // 확인
      expect(consent.status).toBe(200);

      // 실행
      const results = await Promise.all(Array.from({ length: 6 }, () => request(baseUrl, "POST", "/me/portfolio-summary/regenerate", vendor.token, {})));

      // 확인
      expect(results.filter(result => result.status === 200)).toHaveLength(5);
      expect(results.filter(result => result.status === 429)).toHaveLength(1);
      expect(sourceReader.read).toHaveBeenCalledTimes(5);
      expect(generator.generate).toHaveBeenCalledTimes(5);
    });

    // 확인
    const quotaEvents = await prisma.eventLog.findMany({ where: { userId: vendor.id, type: EventType.LLM_CALLED } });
    expect(quotaEvents).toHaveLength(5);
    expect(quotaEvents[0]?.payload).toMatchObject({ purpose: "PORTFOLIO_SUMMARY", model: "mock", tokens: { input: 1, output: 2 }, costKrw: 0, succeeded: true });
    expect(await prisma.eventLog.count({ where: { userId: vendor.id, type: EventType.PORTFOLIO_SUMMARIZED } })).toBe(5);
    expect(JSON.stringify(quotaEvents)).not.toContain(sourceText);
    expect(JSON.stringify(quotaEvents)).not.toContain("portfolio.example.invalid");
  });

  it("실제 지급·포트폴리오 공급자가 없으면 닫힌 상태로 실패한다", async () => {
    // 준비
    const vendor = await supplier();
    await prisma.supplierProfile.update({ where: { userId: vendor.id }, data: {
      portfolioConsentAt: now,
      portfolioItems: [{ type: "LINK", url: "https://portfolio.example.invalid/work" }],
    } });
    await withServer({ encryptionKey }, async baseUrl => {
      // 실행
      const payout = await request(baseUrl, "PATCH", "/me/payout-account", vendor.token, { bank: "KB", accountNo: "1234567890", holder: "Supplier Name" });

      // 확인
      expect(payout.status).toBe(200);

      // 실행
      const verify = await request(baseUrl, "POST", "/me/payout-account/verify", vendor.token, { code: "000001" });
      const summary = await request(baseUrl, "POST", "/me/portfolio-summary/regenerate", vendor.token, {});

      // 확인
      expect(verify.status).toBe(503);
      expect(summary.status).toBe(503);
    });

    // 확인
    expect(await prisma.supplierProfile.findUniqueOrThrow({ where: { userId: vendor.id } })).toMatchObject({ payoutVerifiedAt: null });
  });

  it("리뷰 작성자용 평점 캐시 포트를 노출한다", async () => {
    // 준비
    const client = await user(Role.CLIENT, "Review Client");
    const vendor = await supplier();
    await prisma.clientProfile.create({ data: { userId: client.id, businessName: "Review Client", profileCompleted: true } });
    const projectId = await createProject(client.id);
    const application = await prisma.application.create({ data: {
      projectId, supplierId: vendor.id, specVersionNo: 1, totalAmount: 100, durationDays: 1, firstViewedAt: now,
    } });
    createdApplications.add(application.id);
    const contract = await prisma.contract.create({ data: {
      applicationId: application.id, specVersionNo: 1, agreedAmount: 100, durationDays: 1,
      clientFee: 5, supplierFee: 5, consentDeadline: now, contentHash: randomUUID(), status: ContractStatus.COMPLETED,
    } });
    createdContracts.add(contract.id);
    await prisma.review.create({ data: {
      contractId: contract.id, reviewerId: client.id, revieweeId: vendor.id, reviewerRole: Role.CLIENT,
      rating: 5, tags: [],
    } });
    await prisma.review.create({ data: {
      contractId: contract.id, reviewerId: vendor.id, revieweeId: client.id, reviewerRole: Role.SUPPLIER,
      rating: 4, tags: [],
    } });
    const portFactory = (profileApi as unknown as { createProfileRatingPort?: (db: PrismaClient) => { refresh(userId: string): Promise<void> } }).createProfileRatingPort;

    // 확인
    expect(typeof portFactory).toBe("function");

    // 실행
    await portFactory!(prisma).refresh(vendor.id);
    await portFactory!(prisma).refresh(client.id);

    // 확인
    expect(await prisma.supplierProfile.findUniqueOrThrow({ where: { userId: vendor.id } })).toMatchObject({ ratingAvg: 5, reviewCount: 1 });
    expect(await prisma.clientProfile.findUniqueOrThrow({ where: { userId: client.id } })).toMatchObject({ ratingAvg: 4, reviewCount: 1 });
  });

  it("동의한 요약만 공개하고 서명된 파일과 함께 엄격한 공급자 허용 목록을 반환한다", async () => {
    // 준비
    const vendor = await supplier();
    const privateVendor = await supplier("Private Supplier");
    await prisma.supplierProfile.update({ where: { userId: privateVendor.id }, data: {
      portfolioSummary: "Hidden private draft",
      portfolioSummaryStatus: "DRAFT",
      portfolioItems: [{ type: "LINK", url: "https://private.example.invalid/work", title: "Private" }],
    } });
    const fileKey = `${vendor.id}/portfolio/work.pdf`;
    const sourceReader = { read: jest.fn(async () => ["safe mock source"]) };
    const generator = { generate: jest.fn(async () => ({ summary: "Public summary private@example.invalid", model: "mock", tokens: { input: 1, output: 2 }, costKrw: 0 })) };
    const createSignedUrl = jest.fn(async (_userId: string, _objectKey: string, _expiresInSeconds: number) => "https://storage.example.invalid/signed?token=short");
    const fileSigner = { createSignedUrl };
    await withServer({ portfolioSourceReader: sourceReader, portfolioSummaryGenerator: generator, portfolioFileSigner: fileSigner }, async baseUrl => {
      // 실행
      const unsafeFile = await request(baseUrl, "PATCH", "/me/supplier-profile", vendor.token, {
        portfolioItems: [{ type: "FILE", url: `${vendor.id}/portfolio/%2e%2e/work.pdf` }],
        portfolioConsent: true,
      });

      // 확인
      expect(unsafeFile.status).toBe(400);

      // 실행
      const consent = await request(baseUrl, "PATCH", "/me/supplier-profile", vendor.token, {
        bio: "Public bio contact private@example.invalid 010-1234-5678",
        portfolioItems: [{ type: "FILE", url: fileKey, title: "Portfolio PDF" }],
        portfolioConsent: true,
      });

      // 확인
      expect(consent.status).toBe(200);

      // 실행 및 확인
      const privateData = await request(baseUrl, "GET", `/profiles/suppliers/${privateVendor.id}`, vendor.token);
      expect((await privateData.json() as { data: Record<string, unknown> }).data).toMatchObject({ portfolioSummary: null, portfolioItems: [] });

      // 실행
      const generate = await request(baseUrl, "POST", "/me/portfolio-summary/regenerate", vendor.token, {});

      // 확인
      expect(generate.status).toBe(200);

      // 실행
      const publish = await request(baseUrl, "POST", "/me/portfolio-summary/publish", vendor.token, {});

      // 확인
      expect(publish.status).toBe(200);

      // 실행
      const publicResponse = await request(baseUrl, "GET", `/profiles/suppliers/${vendor.id}`, vendor.token);

      // 확인
      expect(publicResponse.status).toBe(200);
      const publicData = (await publicResponse.json() as { data: Record<string, unknown> }).data;
      expect(Object.keys(publicData).sort()).toEqual([
        "supplierId", "name", "profileImageUrl", "bio", "displayName", "createdAt", "industryCodes", "skills",
        "careerYears", "ratingAvg", "reviewCount", "completedContractCount", "portfolioSummary", "portfolioItems",
      ].sort());
      expect(publicData.portfolioSummary).toBe("Public summary [연락처 비공개]");
      expect(publicData.bio).toBe("Public bio contact [연락처 비공개] [연락처 비공개]");
      expect(publicData.portfolioItems).toEqual([{ type: "FILE", title: "Portfolio PDF", url: "https://storage.example.invalid/signed?token=short" }]);
      for (const forbidden of ["email", "bizRegNo", "taxInvoiceEmail", "payoutBank", "payoutAccountNo", "payoutHolder", "payoutVerifiedAt", "portfolioConsentAt", "ndaVersion"]) {
        expect(publicData).not.toHaveProperty(forbidden);
      }
      expect(JSON.stringify(publicData)).not.toContain(fileKey);
      expect(createSignedUrl).toHaveBeenCalledWith(vendor.id, fileKey, 300);

      // 실행
      const hidden = await request(baseUrl, "POST", "/me/portfolio-summary/hide", vendor.token, {});

      // 확인
      expect(hidden.status).toBe(200);

      // 실행 및 확인
      const hiddenPublic = await request(baseUrl, "GET", `/profiles/suppliers/${vendor.id}`, vendor.token);
      expect((await hiddenPublic.json() as { data: Record<string, unknown> }).data).toMatchObject({ portfolioSummary: null, portfolioItems: [] });
    });
  });

  it("이름이 없는 사용자도 기존 공급자 프로필에 NDA만 패치할 수 있다", async () => {
    // 준비
    const row = await prisma.user.create({ data: { email: `a02-${randomUUID()}@example.invalid`, role: Role.SUPPLIER, name: null } });
    createdUsers.add(row.id);
    await prisma.supplierProfile.create({ data: { userId: row.id, displayName: "Existing Vendor", industryCodes: [], skills: [] } });
    const token = issueAccessToken({ userId: row.id, role: Role.SUPPLIER, expiresAt: now.getTime() + 60_000 }, secret);

    await withServer({ encryptionKey, supplierNdaVersion: "nda-v1" }, async baseUrl => {
      // 실행
      const response = await request(baseUrl, "PATCH", "/me/supplier-profile", token, { ndaConsent: true });

      // 확인
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { displayName: string; ndaAgreedAt: string | null } };
      expect(body.data.displayName).toBe("Existing Vendor");
      expect(body.data.ndaAgreedAt).not.toBeNull();
      const saved = await prisma.supplierProfile.findUniqueOrThrow({ where: { userId: row.id } });
      expect(saved.displayName).toBe("Existing Vendor");
      expect(saved.ndaAgreedAt).not.toBeNull();
    });
  });

  it("새 공급자 프로필 생성에는 여전히 displayName이 필요하다", async () => {
    // 준비
    const row = await prisma.user.create({ data: { email: `a02-${randomUUID()}@example.invalid`, role: Role.SUPPLIER, name: null } });
    createdUsers.add(row.id);
    const token = issueAccessToken({ userId: row.id, role: Role.SUPPLIER, expiresAt: now.getTime() + 60_000 }, secret);

    await withServer({ encryptionKey, supplierNdaVersion: "nda-v1" }, async baseUrl => {
      // 실행
      const response = await request(baseUrl, "PATCH", "/me/supplier-profile", token, { ndaConsent: true });

      // 확인
      expect(response.status).toBe(422);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe("SUPPLIER_PROFILE_INCOMPLETE");
    });
  });

  it("공급자 NDA와 상세 공개 증빙 전에는 의뢰인 프로필을 노출하지 않는다", async () => {
    // 준비
    const client = await user(Role.CLIENT, "Client Owner");
    await prisma.clientProfile.create({ data: { userId: client.id, businessName: "Client Shop", industryField: "Cafe", storeAddress: "Private after NDA", bizRegNo: "111-22-33333", taxInvoiceEmail: "client-tax@example.invalid", profileCompleted: true } });
    const vendor = await supplier();
    const projectId = await createProject(client.id);
    await withServer({ encryptionKey, supplierNdaVersion: "nda-v1" }, async baseUrl => {
      // 실행
      const noNda = await request(baseUrl, "GET", `/projects/${projectId}/client-profile`, vendor.token);

      // 확인
      expect(noNda.status).toBe(403);

      // 실행
      const acceptance = await request(baseUrl, "PATCH", "/me/supplier-profile", vendor.token, { ndaConsent: true });

      // 확인
      expect(acceptance.status).toBe(200);

      // 실행 및 확인
      const noDetail = await request(baseUrl, "GET", `/projects/${projectId}/client-profile`, vendor.token);
      expect(noDetail.status).toBe(403);

      // 실행
      await prisma.eventLog.create({ data: { userId: vendor.id, projectId, type: EventType.SPEC_DETAIL_VIEWED, occurredAt: now } });
      const visible = await request(baseUrl, "GET", `/projects/${projectId}/client-profile`, vendor.token);

      // 확인
      expect(visible.status).toBe(200);
      const publicData = (await visible.json() as { data: Record<string, unknown> }).data;
      expect(Object.keys(publicData).sort()).toEqual([
        "name", "profileImageUrl", "bio", "businessName", "industryField", "storeAddress", "websiteUrl",
        "createdAt", "ratingAvg", "reviewCount", "recruitingProjectCount",
      ].sort());
      expect(publicData).toMatchObject({ name: "Client Owner", businessName: "Client Shop", storeAddress: "Private after NDA" });
      for (const forbidden of ["email", "bizRegNo", "taxInvoiceEmail", "payoutAccountNo", "clientUtterance"]) {
        expect(publicData).not.toHaveProperty(forbidden);
      }
      expect(JSON.stringify(publicData)).not.toContain("client-tax@example.invalid");
      expect(JSON.stringify(publicData)).not.toContain("1112233333");
    });
  });
});
