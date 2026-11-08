/**
 * Vercel Functions와 로컬 서버가 공유하는 Express 앱 조립 지점.
 *
 * `src/index.ts`는 이 앱을 listen하고 스케줄러를 시작한다.
 * Vercel handler는 이 앱을 그대로 default handler로 사용한다.
 */
import type { Express } from "express";
import { PrismaClient } from "@prisma/client";
import {
  createIntegrationPorts,
  createPublicProjectPorts,
  createReportAccountActionPort,
} from "./integration/external-ports.js";
import {
  createAProjectApplicationPort,
  createAProjectSearchPort,
  createAProjectViewPort,
  createProjectCandidatePort,
} from "./integration/a-ports.js";
import { createDraftCatalogAdapter } from "./integration/draft-catalog-adapter.js";
import { createCatalogAdminPort } from "./integration/catalog-admin-port.js";
import { createSupabaseStorageAdapter } from "./integration/supabase-storage.js";
import { createTossSandboxVerifier } from "./integration/toss-verifier.js";
import { createPasswordResetMailerFromEnv } from "./integration/mail.js";
import { createOpenAiCatalogBlockGenerator, createOpenAiCatalogFeatureExtractor } from "./modules/catalog/index.js";
import { createProjectSearchPort } from "./modules/market/project-search.js";
import { runProjectDeadlineBatch } from "./modules/project/service.js";
import { breakExpiredContracts } from "./modules/contract/lifecycle.js";
import { createPrismaContractUnitOfWork } from "./modules/contract/prisma-adapter.js";
import { createPrismaContractViewPort } from "./modules/contract/view.js";
import { createPrismaNotificationSettingsStore } from "./modules/notification/settings-adapter.js";
import { createOpenAiAgreementExtractor } from "./modules/agreement/openai-extractor.js";
import type { ProjectPorts } from "./modules/project/ports.js";
import {
  createCancellationMessagePort,
  createInspectionOpsPort,
  createProjectCandidateDb,
  createAProjectDb,
  createPrismaIntegrationDb,
  createPrismaPorts,
} from "./integration/prisma-wiring.js";
import { createApp } from "./app.js";
import { createBRouters } from "./server.js";
import { createIntegrationServices } from "./composition.js";
import { createHttpHandler } from "./c-app.js";
import { createProfileRatingPort } from "./modules/profile/api.js";
import { requireActor } from "./modules/identity/session.js";
import { createMarketplaceAutoRejectPort } from "./modules/application/marketplace-port.js";
import {
  createApplicationTx,
  createPrismaApplicationReadPort,
  createPrismaApplicationUnitOfWork,
  type ApplicationDbClient,
} from "./modules/application/prisma-adapter.js";
import { createNotificationBridge } from "./modules/notification/c-bridge.js";
import { createPrismaNotificationTx, type NotificationDbClient } from "./modules/notification/prisma-adapter.js";
import { HttpError } from "./http/envelope.js";

export interface ServerApp {
  readonly app: Express;
  readonly db: PrismaClient;
  readonly jobRunner: ReturnType<typeof createIntegrationServices>["runner"];
}

/**
 * 프로세스/함수 인스턴스당 한 번만 호출한다. PrismaClient를 재사용하고,
 * Vercel에서는 module scope에서 한 번 초기화된다.
 */
export function createServerApp(): ServerApp {
  const databaseUrl = process.env.DATABASE_URL;
  const tokenSecret = process.env.TOKEN_SECRET;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!tokenSecret || Buffer.byteLength(tokenSecret) < 32) {
    throw new Error("TOKEN_SECRET must be at least 32 bytes");
  }

  const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        redirectUri: process.env.GOOGLE_REDIRECT_URI,
      }
    : undefined;

  // Lambda 콜드스타트·풀러 지연에서 Prisma 기본값(maxWait 2s/timeout 5s)을 넘겨 간헐 P2028 → 500이 난다.
  // 계약 tx(`contract/prisma-adapter.ts`)와 같은 예산을 전역 기본값으로 둔다.
  const db = new PrismaClient({ transactionOptions: { maxWait: 10_000, timeout: 15_000 } });
  const now = () => new Date();
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const storageBucket = process.env.SUPABASE_STORAGE_BUCKET;
  const storageAdapter =
    supabaseUrl && supabaseKey && storageBucket
      ? createSupabaseStorageAdapter({ url: supabaseUrl, serviceRoleKey: supabaseKey })
      : undefined;
  const tossVerifier = process.env.TOSS_SECRET_KEY
    ? createTossSandboxVerifier({
        secretKey: process.env.TOSS_SECRET_KEY,
        baseUrl: process.env.TOSS_SANDBOX_BASE_URL,
      })
    : undefined;
  const integrationDb = createPrismaIntegrationDb(db);
  const agreementExtractor = createOpenAiAgreementExtractor(
    process.env.OPENAI_API_KEY,
    process.env.OPENAI_MODEL,
  );
  const passwordResetMailer = createPasswordResetMailerFromEnv() ??
    // ponytail: 샌드박스 데모용 no-op mailer. production에서는 env를 켜지 않는다.
    (process.env.PASSWORD_RESET_SANDBOX === "true"
      ? { async sendPasswordReset() {} }
      : undefined);
  const sendPasswordReset =
    passwordResetMailer === undefined
      ? undefined
      : (email: string, token: string) => passwordResetMailer.sendPasswordReset(email, token);
  const publicPorts = createPublicProjectPorts(
    integrationDb,
    createProjectCandidatePort(createProjectCandidateDb(db)),
  );
  const integrationPorts = createIntegrationPorts(integrationDb, {
    ...publicPorts,
    reportAccounts: createReportAccountActionPort(integrationDb),
    contractViews: createPrismaContractViewPort(db),
    notificationSettings: createPrismaNotificationSettingsStore(db),
    ...(agreementExtractor === undefined ? {} : { agreementExtractor }),
    now,
  });
  const prismaPorts = createPrismaPorts(db);
  const applicationRead = createPrismaApplicationReadPort(prismaPorts.applicationRead);

  const aProjectDb = createAProjectDb(db);
  const projectPorts: ProjectPorts = {
    supplierNdaVersion: process.env.SUPPLIER_NDA_VERSION,
    search: createAProjectSearchPort(
      createProjectSearchPort(createProjectCandidatePort(createProjectCandidateDb(db))),
    ),
    view: createAProjectViewPort(aProjectDb),
    application: createAProjectApplicationPort(aProjectDb) as unknown as ProjectPorts["application"],
  };
  const contractJobUow = createPrismaContractUnitOfWork(prismaPorts.contract, integrationPorts.depositAttempts);
  const bRouters = createBRouters(prismaPorts, integrationPorts, applicationRead).map(
    (mounted) => mounted.router,
  );

  const pending = (name: string): never => {
    throw new HttpError(503, "INTEGRATION_PENDING", `${name} Port가 아직 연결되지 않았습니다.`);
  };
  const ratingPort = createProfileRatingPort(db);
  const integrationConfig = {
    prisma: db,
    webhookSecret: process.env.TOSS_WEBHOOK_SECRET ?? "",
    ...(storageBucket === undefined ? {} : { bucket: storageBucket }),
    clock: { now },
    ports: {
      marketplace: createMarketplaceAutoRejectPort(
        createPrismaApplicationUnitOfWork(prismaPorts.application),
        (tx) => createApplicationTx(tx as ApplicationDbClient),
      ),
      notifications: createNotificationBridge(
        createPrismaNotificationTx(prismaPorts.notification),
        { now, notificationTxFor: (tx) => createPrismaNotificationTx(tx as NotificationDbClient) },
      ),
      profileReview: {
        async updateProfileReviewStats(input: { targetUserId: string }, tx: unknown) {
          await ratingPort.refresh(
            input.targetUserId,
            tx as import("@prisma/client").Prisma.TransactionClient | undefined,
          );
          return { success: true };
        },
      },
      storage: storageAdapter ?? {
        async createUploadUrl() { return pending("Storage"); },
        async createDownloadUrl() { return pending("Storage"); },
      },
      ...(tossVerifier === undefined ? {} : { tossVerifier }),
      inspectionOps: createInspectionOpsPort(db),
      cancellationMessages: createCancellationMessagePort(db),
      projectDeadlines: (at: Date) => runProjectDeadlineBatch(db, projectPorts, at),
      contractBreaks: (at: Date) => breakExpiredContracts(contractJobUow, { now: at }),
      catalogAdmin: {
        ...createCatalogAdminPort(db),
      },
    },
  };
  const { services: cServices, runner: jobRunner } = createIntegrationServices(integrationConfig);
  const cHandler = createHttpHandler(
    { services: { ...cServices, runDueJobs: (now: Date) => jobRunner.runOnce(now) }, authenticate: async (req) => {
      const header = req.headers.authorization;
      const value = typeof header === "string" ? header : undefined;
      const match = /^Bearer ([^\s]+)$/.exec(value ?? "");
      if (!match) return null;
      try {
        const actor = await requireActor(db, match[1]!, tokenSecret, Date.now());
        return { userId: actor.userId, role: actor.role };
      } catch {
        return null;
      }
    }, deferUnmatched: true, cronSecret: process.env.CRON_SECRET },
  );

  const app = createApp({
    db,
    tokenSecret,
    google,
    ...(sendPasswordReset === undefined ? {} : { sendPasswordReset }),
    projectDisclosureConsentVersion: () => process.env.PROJECT_DISCLOSURE_CONSENT_VERSION ?? null,
    project: projectPorts,
    draft: {
      catalog: createDraftCatalogAdapter(db, {
        extractor: createOpenAiCatalogFeatureExtractor(
          process.env.OPENAI_API_KEY,
          process.env.OPENAI_MODEL,
          process.env.OPENAI_USD_TO_KRW_RATE,
        ),
        generator: createOpenAiCatalogBlockGenerator(
          process.env.OPENAI_API_KEY,
          process.env.OPENAI_MODEL,
          process.env.OPENAI_USD_TO_KRW_RATE,
        ),
      }),
    },
    profile: {
      encryptionKey: process.env.PROFILE_DATA_KEY,
      supplierNdaVersion: process.env.SUPPLIER_NDA_VERSION,
      // ponytail: 샌드박스 데모용. 4자 이상 코드면 인증 성공으로 처리한다.
      ...(process.env.PAYOUT_VERIFICATION_SANDBOX === "true"
        ? {
            payoutVerification: {
              async verify(input: { userId: string; bank: string; accountNo: string; holder: string; code: string }) {
                return input.code.trim().length >= 4;
              },
            },
          }
        : {}),
    },
    routers: bRouters,
    fallback: cHandler,
  });

  return { app, db, jobRunner };
}
