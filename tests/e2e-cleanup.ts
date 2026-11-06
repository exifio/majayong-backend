import type { PrismaClient } from "@prisma/client";

export interface E2ECleanupIds {
  readonly userIds?: readonly string[];
  readonly projectIds?: readonly string[];
  readonly draftIds?: readonly string[];
}

/**
 * E2E가 만든 행만 FK 역순으로 지운다.
 * 프로필/계약 자식이 남아 user.deleteMany가 조용히 실패하던 문제를 막는다.
 */
export async function cleanupE2e(db: PrismaClient, ids: E2ECleanupIds): Promise<void> {
  const valid = (values: readonly (string | undefined)[] | undefined): string[] =>
    [...new Set((values ?? []).filter((value): value is string => typeof value === "string" && value.length > 0))];
  const users = valid(ids.userIds);
  const drafts = new Set(valid(ids.draftIds));
  const projects = new Set(valid(ids.projectIds));

  if (users.length > 0) {
    const rows = await db.draft.findMany({ where: { clientId: { in: users } }, select: { id: true } });
    for (const row of rows) drafts.add(row.id);
  }
  if (drafts.size > 0) {
    const rows = await db.project.findMany({ where: { draftId: { in: [...drafts] } }, select: { id: true } });
    for (const row of rows) projects.add(row.id);
  }
  if (users.length > 0) {
    const rows = await db.project.findMany({ where: { draft: { clientId: { in: users } } }, select: { id: true } });
    for (const row of rows) projects.add(row.id);
  }

  const applications = await db.application.findMany({
    where: { OR: [{ projectId: { in: [...projects] } }, { supplierId: { in: users } }] },
    select: { id: true },
  });
  const applicationIds = applications.map((row) => row.id);
  const contracts = applicationIds.length === 0
    ? []
    : await db.contract.findMany({ where: { applicationId: { in: applicationIds } }, select: { id: true } });
  const contractIds = contracts.map((row) => row.id);
  const contractItems = contractIds.length === 0
    ? []
    : await db.contractItem.findMany({ where: { contractId: { in: contractIds } }, select: { id: true } });
  const contractItemIds = contractItems.map((row) => row.id);
  const installments = contractIds.length === 0
    ? []
    : await db.paymentInstallment.findMany({ where: { contractId: { in: contractIds } }, select: { id: true } });
  const installmentIds = installments.map((row) => row.id);
  const deliveries = installmentIds.length === 0
    ? []
    : await db.delivery.findMany({ where: { installmentId: { in: installmentIds } }, select: { id: true } });
  const deliveryIds = deliveries.map((row) => row.id);
  const deposits = contractIds.length === 0
    ? []
    : await db.escrowDeposit.findMany({ where: { contractId: { in: contractIds } }, select: { id: true } });
  const depositIds = deposits.map((row) => row.id);

  if (users.length > 0 || applicationIds.length > 0) {
    await db.report.deleteMany({
      where: {
        OR: [
          { reporterId: { in: users } },
          { targetUserId: { in: users } },
          { resolvedById: { in: users } },
          { message: { applicationId: { in: applicationIds } } },
        ],
      },
    });
  }
  if (deliveryIds.length > 0 || contractItemIds.length > 0) {
    await db.inspectionRequest.deleteMany({
      where: {
        OR: [
          { deliveryId: { in: deliveryIds } },
          { contractItemId: { in: contractItemIds } },
        ],
      },
    });
  }
  await db.delivery.deleteMany({ where: { id: { in: deliveryIds } } });
  if (contractIds.length > 0 || users.length > 0) {
    await db.review.deleteMany({
      where: {
        OR: [
          { contractId: { in: contractIds } },
          { reviewerId: { in: users } },
          { revieweeId: { in: users } },
        ],
      },
    });
  }
  await db.paymentEvent.deleteMany({ where: { depositId: { in: depositIds } } });
  await db.paymentInstallment.deleteMany({ where: { contractId: { in: contractIds } } });
  await db.escrowDeposit.deleteMany({ where: { contractId: { in: contractIds } } });
  if (users.length > 0) {
    await db.supportInquiry.deleteMany({
      where: { OR: [{ userId: { in: users } }, { answeredById: { in: users } }] },
    });
  }
  await db.contractItem.deleteMany({ where: { contractId: { in: contractIds } } });
  await db.contract.deleteMany({ where: { id: { in: contractIds } } });
  await db.applicationMessage.deleteMany({ where: { applicationId: { in: applicationIds } } });
  await db.applicationItem.deleteMany({ where: { applicationId: { in: applicationIds } } });
  await db.application.deleteMany({ where: { id: { in: applicationIds } } });
  await db.specItem.deleteMany({ where: { projectId: { in: [...projects] } } });
  await db.bookmark.deleteMany({ where: { projectId: { in: [...projects] } } });
  await db.project.deleteMany({ where: { id: { in: [...projects] } } });
  await db.draftBlock.deleteMany({ where: { draftId: { in: [...drafts] } } });
  await db.draft.deleteMany({ where: { id: { in: [...drafts] } } });
  if (users.length > 0) {
    await db.notification.deleteMany({ where: { userId: { in: users } } });
    await db.eventLog.deleteMany({ where: { userId: { in: users } } });
    await db.clientProfile.deleteMany({ where: { userId: { in: users } } });
    await db.supplierProfile.deleteMany({ where: { userId: { in: users } } });
    await db.refreshSession.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
}
