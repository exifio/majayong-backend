import { PrismaClient } from "@prisma/client";
import type { DueJobTargets } from "../modules/deposit/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * INT-C-04: 기한 도래 대상 조회. `runDueJobs`에 주입한다.
 * 인덱스: contracts(status,depositDeadline|workDueAt|cancelRequestedAt), deliveries(status,inspectionDueAt),
 * escrow_deposits(status,createdAt)
 */
export function createPrismaDueJobTargets(prisma: PrismaClient): DueJobTargets {
  return {
    async depositContractIds(now: Date) {
      const rows = await prisma.contract.findMany({
        where: {
          status: "ACTIVE",
          paymentStatus: "PENDING",
          depositDeadline: { not: null, lte: now },
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    },
    async pendingDepositIds(createdBefore: Date) {
      const rows = await prisma.escrowDeposit.findMany({
        where: {
          status: "PENDING",
          createdAt: { lte: createdBefore },
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    },

    async cancellationContractIds() {
      const rows = await prisma.contract.findMany({
        where: {
          status: "CANCEL_REQUESTED",
          cancelRequestedAt: { not: null },
          cancelResolvedAt: null,
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    },

    async deliveryIds(now: Date) {
      // 가장 최근 납품만 자동 승인 대상이다. 서비스가 latest 여부를 다시 확인한다.
      const rows = await prisma.delivery.findMany({
        where: {
          status: { in: ["SUBMITTED", "PARTIALLY_APPROVED", "REWORK_REQUESTED"] },
          inspectionDueAt: { lte: now },
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    },

    async notificationContractIds(now: Date) {
      const soon = new Date(now.getTime() + DAY_MS);
      const rows = await prisma.contract.findMany({
        where: {
          status: "ACTIVE",
          OR: [
            { paymentStatus: "PENDING", depositDeadline: { not: null, lte: soon } },
            { workDueAt: { not: null, lte: soon } },
            {
              installments: {
                some: {
                  status: { in: ["DELIVERED", "PENDING", "REWORK_REQUESTED"] },
                  deliveries: { some: { inspectionDueAt: { lte: soon } } },
                },
              },
            },
          ],
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    },
  };
}
