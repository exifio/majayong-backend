/**
 * Gate 0: B 앱 조립 지점.
 *
 * B가 소유한 Prisma adapter는 여기서 연결하고, A/C 소유 Port는 주입받는다.
 * 각 adapter는 같은 `PrismaClient` 인스턴스를 넘겨도 되고, 트랜잭션 경계가
 * 다른 경우 별도 인스턴스를 넘길 수 있도록 Port별로 나눠 받는다.
 */
import type { Express } from 'express';

import { createApp, type MountedRouter } from './http/create-app.js';
import type { AuthVerifier } from './http/auth.js';
import {
  createApplicationRouter,
  type ProjectStateReadPort,
} from './modules/application/http.js';
import {
  createPrismaApplicationReadPort,
  createPrismaApplicationUnitOfWork,
  type ApplicationPrismaClient,
  type ApplicationReadDbClient,
} from './modules/application/prisma-adapter.js';
import type {
  AgreementDraftPrismaClient,
  AgreementDraftStore,
} from './modules/agreement/prisma-adapter.js';
import { createPrismaAgreementDraftStore } from './modules/agreement/prisma-adapter.js';
import {
  createChatRouter,
  type ChatHttpPorts,
} from './modules/chat/http.js';
import {
  createPrismaChatRepository,
  createPrismaChatRoomListPort,
  type ChatDbClient,
} from './modules/chat/prisma-adapter.js';
import {
  createContractRouter,
  type ContractHttpPorts,
} from './modules/contract/http.js';
import type { ContractViewPort } from './modules/contract/view.js';
import {
  createPrismaContractReadPort,
  createPrismaContractUnitOfWork,
  type ContractPrismaClient,
  type DepositAttemptPort,
} from './modules/contract/prisma-adapter.js';
import {
  createMarketRouter,
  type MarketHttpPorts,
} from './modules/market/http.js';
import {
  createPrismaBookmarkRepository,
  type BookmarkDbClient,
} from './modules/market/prisma-adapter.js';
import { createChatNotificationPort } from './modules/notification/notifications.js';
import { createNotificationRouter } from './modules/notification/http.js';
import {
  createPrismaNotificationUnitOfWork,
  type NotificationPrismaClient,
} from './modules/notification/prisma-adapter.js';
import { createReportRouter } from './modules/report/http.js';
import {
  createPrismaMyReportQueryPort,
  createPrismaReportUnitOfWork,
  type ReportAccountActionPort,
  type ReportPrismaClient,
} from './modules/report/prisma-adapter.js';
import { createSupportRouter } from './modules/support/http.js';
import {
  createPrismaInquiryUnitOfWork,
  type InquiryPrismaClient,
} from './modules/support/prisma-adapter.js';

export interface BPrismaPorts {
  readonly application: ApplicationPrismaClient;
  readonly applicationRead: ApplicationReadDbClient;
  readonly agreement: AgreementDraftPrismaClient;
  readonly chat: ChatDbClient;
  readonly contract: ContractPrismaClient;
  readonly report: ReportPrismaClient;
  readonly support: InquiryPrismaClient;
  readonly market: BookmarkDbClient;
  readonly notification: NotificationPrismaClient;
  readonly databaseNull: unknown;
}

/** A/C 소유 Port. 통합 담당이 실제 구현을 주입한다. */
export interface ExternalPorts {
  readonly projectState: ProjectStateReadPort;
  readonly projects: MarketHttpPorts['projects'];
  readonly recommendations: MarketHttpPorts['recommendations'];
  readonly chatAccounts: ChatHttpPorts['accounts'];
  readonly chatEvents: ChatHttpPorts['events'];
  readonly reportAccounts: ReportAccountActionPort;
  readonly contractItems: ContractHttpPorts['items'];
  readonly agreementPreview: ContractHttpPorts['preview'];
  readonly depositAttempts: DepositAttemptPort;
  readonly contractViews?: ContractViewPort;
  readonly notificationSettings?: import('./modules/notification/settings.js').NotificationSettingsStore;
  readonly agreementExtractor?: import('./modules/agreement/draft.js').AgreementExtractionPort;
  readonly now: () => Date;
}

export function createBRouters(
  prisma: BPrismaPorts,
  external: ExternalPorts,
  applicationReadOverride?: ReturnType<typeof createPrismaApplicationReadPort>,
): MountedRouter[] {
  const applicationRead = applicationReadOverride ?? createPrismaApplicationReadPort(prisma.applicationRead);
  const notificationUow = createPrismaNotificationUnitOfWork(prisma.notification);
  const agreements: AgreementDraftStore = createPrismaAgreementDraftStore(
    prisma.agreement,
    { databaseNull: prisma.databaseNull },
  );

  const routers: MountedRouter[] = [
    {
      basePath: '',
      router: createApplicationRouter({
        uow: createPrismaApplicationUnitOfWork(prisma.application),
        reads: applicationRead,
        projectApplications: applicationRead,
        projectState: external.projectState,
        now: external.now,
      }),
    },
    {
      basePath: '',
      router: createMarketRouter({
        bookmarks: createPrismaBookmarkRepository(prisma.market),
        projects: external.projects,
        recommendations: external.recommendations,
        now: external.now,
      }),
    },
    {
      basePath: '',
      router: createChatRouter({
        repository: createPrismaChatRepository(prisma.chat),
        rooms: createPrismaChatRoomListPort(prisma.chat),
        accounts: external.chatAccounts,
        events: external.chatEvents,
        notifications: createChatNotificationPort(notificationUow),
        now: external.now,
      }),
    },
    {
      basePath: '',
      router: createNotificationRouter({
        uow: notificationUow,
        ...(external.notificationSettings === undefined
          ? {}
          : { settings: external.notificationSettings }),
        now: external.now,
      }),
    },
    {
      basePath: '',
      router: createContractRouter({
        uow: createPrismaContractUnitOfWork(
          prisma.contract,
          external.depositAttempts,
        ),
        reads: createPrismaContractReadPort(prisma.contract),
        ...(external.contractViews === undefined ? {} : { views: external.contractViews }),
        applications: applicationRead,
        agreements,
        ...(external.agreementExtractor === undefined
          ? {}
          : { extractor: external.agreementExtractor }),
        items: external.contractItems,
        preview: external.agreementPreview,
        now: external.now,
      }),
    },
    {
      basePath: '',
      router: createReportRouter({
        uow: createPrismaReportUnitOfWork(
          prisma.report,
          external.reportAccounts,
          external.now,
        ),
        myReports: createPrismaMyReportQueryPort(prisma.report),
        now: external.now,
      }),
    },
    {
      basePath: '',
      router: createSupportRouter({
        uow: createPrismaInquiryUnitOfWork(prisma.support, external.now),
        now: external.now,
      }),
    },
  ];

  return routers;
}

/** B 단독 부팅·계약 테스트용. 통합 앱에서는 `createBRouters`를 A 앱에 mount한다. */
export function buildBApp(
  prisma: BPrismaPorts,
  external: ExternalPorts,
  auth: AuthVerifier,
): Express {
  return createApp({ auth, routers: createBRouters(prisma, external) });
}
