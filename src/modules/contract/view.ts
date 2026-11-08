/** B-08 후속: 계약 목록·상세의 표시용 파생 필드(프로젝트 제목·상대 표시명·리뷰 여부). */
import type { PrismaClient } from '@prisma/client';

import type { ContractActor, ContractRecord } from './lifecycle.js';

export interface ContractInstallmentProgress {
  readonly stage: 'INTERIM' | 'FINAL';
  readonly status: string;
}

export interface ContractPartyFields {
  readonly projectTitle: string | null;
  readonly counterpartName: string | null;
  readonly reviewWrittenByMe: boolean;
  readonly installments: readonly ContractInstallmentProgress[];
}

export interface ContractViewPort {
  describe(input: {
    readonly contracts: readonly ContractRecord[];
    readonly actor: ContractActor;
  }): Promise<ReadonlyMap<string, ContractPartyFields>>;
}

export function createPrismaContractViewPort(db: PrismaClient): ContractViewPort {
  return {
    async describe({ contracts, actor }) {
      const result = new Map<string, ContractPartyFields>();
      if (contracts.length === 0) return result;

      const projectIds = [...new Set(contracts.map((contract) => contract.projectId))];
      const contractIds = contracts.map((contract) => contract.id);
      const supplierIds = [
        ...new Set(
          contracts
            .filter((contract) => actor.userId !== contract.supplierId)
            .map((contract) => contract.supplierId),
        ),
      ];
      const clientIds = [
        ...new Set(
          contracts
            .filter((contract) => actor.userId !== contract.clientUserId)
            .map((contract) => contract.clientUserId),
        ),
      ];

      const [projects, reviews, suppliers, clients, users, installments] = await Promise.all([
        db.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, title: true },
        }),
        db.review.findMany({
          where: { contractId: { in: contractIds }, reviewerId: actor.userId },
          select: { contractId: true },
        }),
        supplierIds.length === 0
          ? Promise.resolve([] as Array<{ userId: string; displayName: string }>)
          : db.supplierProfile.findMany({
              where: { userId: { in: supplierIds } },
              select: { userId: true, displayName: true },
            }),
        clientIds.length === 0
          ? Promise.resolve([] as Array<{ userId: string; businessName: string | null }>)
          : db.clientProfile.findMany({
              where: { userId: { in: clientIds } },
              select: { userId: true, businessName: true },
            }),
        clientIds.length === 0
          ? Promise.resolve([] as Array<{ id: string; name: string | null }>)
          : db.user.findMany({
              where: { id: { in: clientIds } },
              select: { id: true, name: true },
            }),
        db.paymentInstallment.findMany({
          where: { contractId: { in: contractIds } },
          select: { contractId: true, stage: true, status: true },
          orderBy: [{ contractId: 'asc' }, { stage: 'asc' }],
        }),
      ]);

      const titleByProject = new Map(projects.map((project) => [project.id, project.title]));
      const reviewed = new Set(reviews.map((review) => review.contractId));
      const supplierName = new Map(suppliers.map((profile) => [profile.userId, profile.displayName]));
      const clientBusinessName = new Map(
        clients.map((profile) => [profile.userId, profile.businessName]),
      );
      const userName = new Map(users.map((user) => [user.id, user.name]));
      const installmentsByContract = new Map<string, ContractInstallmentProgress[]>();
      for (const installment of installments) {
        const rows = installmentsByContract.get(installment.contractId) ?? [];
        rows.push({ stage: installment.stage, status: installment.status });
        installmentsByContract.set(installment.contractId, rows);
      }

      for (const contract of contracts) {
        const counterpartName =
          actor.userId === contract.clientUserId
            ? supplierName.get(contract.supplierId) ?? null
            : clientBusinessName.get(contract.clientUserId) ??
              userName.get(contract.clientUserId) ??
              null;
        result.set(contract.id, {
          projectTitle: titleByProject.get(contract.projectId) ?? null,
          counterpartName,
          reviewWrittenByMe: reviewed.has(contract.id),
          installments: installmentsByContract.get(contract.id) ?? [],
        });
      }
      return result;
    },
  };
}
