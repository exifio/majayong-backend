import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPrismaPorts } from './prisma-wiring.ts';
import { createContractTx } from '../modules/contract/prisma-adapter.ts';
import { createPrismaApplicationUnitOfWork } from '../modules/application/prisma-adapter.ts';
import type { PrismaClient } from '@prisma/client';

describe('Prisma 런타임 연결', () => {
  it('지원 프로필 조회는 Prisma supplierProfile 델리게이트를 사용한다', async () => {
    // 준비
    const calls: unknown[] = [];
    const supplierProfile = {
      findMany: async (input: unknown) => {
        calls.push(input);
        return [{ userId: 'supplier-1' }];
      },
    };
    const delegate = new Proxy({}, {
      get(_target, property) {
        if (property === 'supplierProfile') return supplierProfile;
        return new Proxy({}, { get: () => async () => undefined });
      },
    });
    const ports = createPrismaPorts(delegate as PrismaClient);
    const input = {
      where: { userId: { in: ['supplier-1'] } },
      select: {
        userId: true,
        careerYears: true,
        ratingAvg: true,
        reviewCount: true,
        portfolioSummary: true,
        portfolioSummaryStatus: true,
        portfolioConsentAt: true,
        user: { select: { withdrawnAt: true } },
        applications: {
          where: { contract: { is: { status: 'COMPLETED' as const } } },
          select: { id: true },
        },
      },
    } as const;

    // 실행 및 확인
    assert.deepEqual(await ports.applicationRead.supplierProfile?.findMany(input), [{ userId: 'supplier-1' }]);
    assert.deepEqual(calls, [input]);
  });

  it('계약 작업 단위는 행 잠금을 위해 트랜잭션 범위 $queryRaw를 사용한다', async () => {
    // 준비
    const queries: string[] = [];
    const txRaw = async (strings: TemplateStringsArray) => {
      queries.push(strings.join('?'));
      return [];
    };
    const delegate = new Proxy({}, {
      get(_target, property) {
        if (property === '$transaction') {
          return async (work: (tx: object) => Promise<unknown>) => work(new Proxy({}, {
            get(_tx, txProperty) {
              if (txProperty === '$queryRaw') return txRaw;
              return new Proxy({}, { get: () => async () => null });
            },
          }));
        }
        return new Proxy({}, { get: () => async () => null });
      },
    });
    const ports = createPrismaPorts(delegate as PrismaClient);
    // 실행
    await ports.contract.$transaction(async (tx) => {
      await createContractTx(tx, { hasDepositAttempt: async () => false }).findContract('contract-1');
    });

    // 확인
    assert.deepEqual(queries, ['SELECT id FROM contracts WHERE id = ? FOR UPDATE']);
  });

  it('지원 작업 단위는 트랜잭션 클라이언트로 프로젝트 잠금과 현재 명세 조회를 매핑한다', async () => {
    // 준비
    const seenQueries: string[] = [];
    let projectFinds = 0;
    const tx = new Proxy({}, {
      get(_target, property) {
        if (property === '$queryRaw') return async (strings: TemplateStringsArray) => {
          seenQueries.push(strings.join('?'));
          return [];
        };
        if (property === 'project') return {
          findUnique: async () => {
            projectFinds += 1;
            return { currentVersion: 2, status: 'RECRUITING' };
          },
        };
        if (property === 'specItem') return {
          findMany: async () => [{ id: 'current-spec' }],
        };
        if (property === 'notification') return new Proxy({}, { get: () => async () => null });
        return new Proxy({}, { get: () => async () => null });
      },
    });
    const client = new Proxy({}, {
      get(_target, property) {
        if (property === '$transaction') {
          return async (work: (tx: object) => Promise<unknown>) => work(tx);
        }
        return new Proxy({}, { get: () => async () => null });
      },
    });
    const ports = createPrismaPorts(client as PrismaClient);
    const uow = createPrismaApplicationUnitOfWork(ports.application);

    // 실행
    const state = await uow.run((applicationTx) => applicationTx.findProjectSpec('prj-1'));

    // 확인
    assert.deepEqual(state, { currentVersion: 2, status: 'RECRUITING', specItemIds: ['current-spec'] });
    assert.deepEqual(seenQueries, ['SELECT id FROM projects WHERE id = ? FOR UPDATE']);
    assert.equal(projectFinds, 1);
  });
});
