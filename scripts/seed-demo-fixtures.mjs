#!/usr/bin/env node
/**
 * BE-08: staging/demo fixture 2세트와 반복 리셋.
 *
 * - A세트: 모집 중 프로젝트 1건, 지원 3건, 채팅 메시지.
 * - B세트: 예치 완료 계약 1건, 중간 납품 제출(검수 대기).
 * - PG 증거가 없는 B세트는 제목/납품 문구에 [DEMO]로 표시한다.
 * - 고정 ID와 demo 접두사만 쓰고, 실제/운영 데이터는 건드리지 않는다.
 * - 실행 DB는 로컬의 *_test/_check/_staging 이거나 ALLOW_DEMO_SEED=1이어야 한다.
 *
 * 사용:
 *   DATABASE_URL=... node scripts/seed-demo-fixtures.mjs --dry-run
 *   DATABASE_URL=... node scripts/seed-demo-fixtures.mjs --reset
 *   DATABASE_URL=... node scripts/seed-demo-fixtures.mjs --reset-only
 */
import { PrismaClient } from '@prisma/client';

const NOW = new Date('2026-11-06T09:00:00.000Z');
const DEADLINE = new Date('2027-01-31T14:59:59.000Z');
const WORK_DUE = new Date('2027-01-15T14:59:59.000Z');
const INSPECTION_DUE = new Date('2027-01-08T14:59:59.000Z');

const id = (suffix) => `d0800000-0000-4000-8000-${suffix.padStart(12, '0')}`;

const IDS = {
  block: id('1'),
  a: {
    client: id('10'),
    suppliers: [id('11'), id('12'), id('13')],
    draft: id('14'),
    project: id('15'),
    specItems: [id('16'), id('17')],
    applications: [id('18'), id('19'), id('20')],
    messages: [id('21'), id('22')],
  },
  b: {
    client: id('30'),
    supplier: id('31'),
    draft: id('32'),
    project: id('33'),
    application: id('34'),
    contract: id('35'),
    deposit: id('36'),
    interim: id('37'),
    final: id('38'),
    interimItem: id('39'),
    finalItem: id('40'),
    delivery: id('41'),
  },
};

function fail(message) {
  console.error(`seed-demo-fixtures: ${message}`);
  process.exit(1);
}

function assertSafeDatabase(url) {
  if (!url) fail('DATABASE_URL is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('DATABASE_URL must be a valid URL');
  }
  const dbName = parsed.pathname.replace(/^\//, '');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  const dedicated = /(_test|_check|_staging)$/.test(dbName);
  const allow = process.env.ALLOW_DEMO_SEED === '1';
  if (process.env.NODE_ENV === 'production' && !allow) {
    fail('refusing NODE_ENV=production without ALLOW_DEMO_SEED=1');
  }
  if (!allow && !(local && dedicated)) {
    fail(`refusing database "${dbName}" on "${host}": use a local *_test/_check/_staging DB or ALLOW_DEMO_SEED=1`);
  }
}

function summary(db) {
  return {
    A: {
      project: 1,
      applications: 3,
      messages: IDS.a.messages.length,
      specItems: IDS.a.specItems.length,
    },
    B: {
      contract: 1,
      deposit: 1,
      installments: 2,
      contractItems: 2,
      deliveries: 1,
    },
    users: 1 + IDS.a.suppliers.length + 2,
  };
}

async function reset(db) {
  const applicationIds = [...IDS.a.applications, IDS.b.application];
  const userIds = [IDS.a.client, ...IDS.a.suppliers, IDS.b.client, IDS.b.supplier];
  const installmentIds = [IDS.b.interim, IDS.b.final];
  const contractItemIds = [IDS.b.interimItem, IDS.b.finalItem];

  await db.inspectionRequest.deleteMany({ where: { OR: [{ deliveryId: IDS.b.delivery }, { contractItemId: { in: contractItemIds } }] } });
  await db.delivery.deleteMany({ where: { OR: [{ id: IDS.b.delivery }, { installmentId: { in: installmentIds } }] } });
  await db.paymentEvent.deleteMany({ where: { depositId: IDS.b.deposit } });
  await db.paymentInstallment.deleteMany({ where: { contractId: IDS.b.contract } });
  await db.escrowDeposit.deleteMany({ where: { contractId: IDS.b.contract } });
  await db.contractItem.deleteMany({ where: { contractId: IDS.b.contract } });
  await db.contract.deleteMany({ where: { id: IDS.b.contract } });
  await db.applicationMessage.deleteMany({ where: { applicationId: { in: applicationIds } } });
  await db.application.deleteMany({ where: { id: { in: applicationIds } } });
  await db.specItem.deleteMany({ where: { projectId: { in: [IDS.a.project, IDS.b.project] } } });
  await db.project.deleteMany({ where: { id: { in: [IDS.a.project, IDS.b.project] } } });
  await db.draft.deleteMany({ where: { id: { in: [IDS.a.draft, IDS.b.draft] } } });
  await db.clientProfile.deleteMany({ where: { userId: { in: [IDS.a.client, IDS.b.client] } } });
  await db.supplierProfile.deleteMany({ where: { userId: { in: [...IDS.a.suppliers, IDS.b.supplier] } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.blockCatalog.deleteMany({ where: { id: IDS.block } });
}

async function seed(db) {
  const block = {
    id: IDS.block,
    code: 'demo0806-calendar',
    name: '[DEMO] 예약 달력',
    functionSummary: '날짜·시간 예약 가능 여부를 보여주는 달력',
    description: '샌드박스 시연용 블록',
    industryCode: 'FOOD',
    techTags: [],
    unitPrice: 500_000,
    priceBasis: '[DEMO] 시연 고정 단가',
  };
  await db.blockCatalog.upsert({ where: { id: IDS.block }, update: block, create: block });

  await db.user.upsert({
    where: { id: IDS.a.client },
    update: { email: 'demo0806-a-client@example.invalid', role: 'CLIENT' },
    create: { id: IDS.a.client, email: 'demo0806-a-client@example.invalid', role: 'CLIENT', name: '[DEMO] 의뢰인 A' },
  });
  await db.clientProfile.upsert({
    where: { userId: IDS.a.client },
    update: { businessName: '[DEMO] 카페 A', profileCompleted: true },
    create: { userId: IDS.a.client, businessName: '[DEMO] 카페 A', profileCompleted: true },
  });
  for (const [index, supplierId] of IDS.a.suppliers.entries()) {
    await db.user.upsert({
      where: { id: supplierId },
      update: { email: `demo0806-a-supplier-${index + 1}@example.invalid`, role: 'SUPPLIER' },
      create: { id: supplierId, email: `demo0806-a-supplier-${index + 1}@example.invalid`, role: 'SUPPLIER', name: `[DEMO] 공급자 A${index + 1}` },
    });
    await db.supplierProfile.upsert({
      where: { userId: supplierId },
      update: { displayName: `[DEMO] 공급자 A${index + 1}`, ndaAgreedAt: NOW, ndaVersion: 'demo-nda' },
      create: { userId: supplierId, displayName: `[DEMO] 공급자 A${index + 1}`, industryCodes: [], skills: [], ndaAgreedAt: NOW, ndaVersion: 'demo-nda' },
    });
  }
  await db.draft.upsert({
    where: { id: IDS.a.draft },
    update: { clientId: IDS.a.client, entryType: 'SENTENCE' },
    create: { id: IDS.a.draft, clientId: IDS.a.client, entryType: 'SENTENCE' },
  });
  await db.project.upsert({
    where: { id: IDS.a.project },
    update: { title: '[DEMO] 예약 페이지 A', status: 'RECRUITING', deadline: DEADLINE },
    create: {
      id: IDS.a.project,
      draftId: IDS.a.draft,
      confirmedAt: NOW,
      disclosureConsentVersion: 'demo-v1',
      title: '[DEMO] 예약 페이지 A',
      summary: '[DEMO] 모집·채팅 시연 세트',
      industryCode: 'FOOD',
      requiredSkills: [],
      status: 'RECRUITING',
      publishedAt: NOW,
      deadline: DEADLINE,
    },
  });
  for (const [index, specItemId] of IDS.a.specItems.entries()) {
    const data = {
      id: specItemId,
      projectId: IDS.a.project,
      versionNo: 1,
      blockId: IDS.block,
      title: `[DEMO] 항목 A${index + 1}`,
      description: '샌드박스 시연용 명세 항목',
      origin: 'RECOMMENDATION',
      status: 'INCLUDED',
      unitPrice: 500_000,
      sortOrder: index,
    };
    await db.specItem.upsert({ where: { id: specItemId }, update: data, create: data });
  }
  for (const [index, applicationId] of IDS.a.applications.entries()) {
    const data = {
      id: applicationId,
      projectId: IDS.a.project,
      supplierId: IDS.a.suppliers[index],
      revisionNo: 1,
      specVersionNo: 1,
      status: 'SUBMITTED',
      totalAmount: 2_900_000 + index * 200_000,
      durationDays: 30 + index * 5,
      message: `[DEMO] 지원 ${index + 1}`,
      firstViewedAt: NOW,
      submittedAt: NOW,
    };
    await db.application.upsert({ where: { id: applicationId }, update: data, create: data });
  }
  for (const [index, messageId] of IDS.a.messages.entries()) {
    const data = {
      id: messageId,
      applicationId: IDS.a.applications[0],
      senderId: index === 0 ? IDS.a.client : IDS.a.suppliers[0],
      kind: 'TEXT',
      body: index === 0 ? '[DEMO] 일정 문의드립니다.' : '[DEMO] 네, 확인했습니다.',
      isMasked: false,
      createdAt: new Date(NOW.getTime() + index * 60_000),
    };
    await db.applicationMessage.upsert({ where: { id: messageId }, update: data, create: data });
  }

  await db.user.upsert({
    where: { id: IDS.b.client },
    update: { email: 'demo0806-b-client@example.invalid', role: 'CLIENT' },
    create: { id: IDS.b.client, email: 'demo0806-b-client@example.invalid', role: 'CLIENT', name: '[DEMO] 의뢰인 B' },
  });
  await db.clientProfile.upsert({
    where: { userId: IDS.b.client },
    update: { businessName: '[DEMO] 카페 B', profileCompleted: true },
    create: { userId: IDS.b.client, businessName: '[DEMO] 카페 B', profileCompleted: true },
  });
  await db.user.upsert({
    where: { id: IDS.b.supplier },
    update: { email: 'demo0806-b-supplier@example.invalid', role: 'SUPPLIER' },
    create: { id: IDS.b.supplier, email: 'demo0806-b-supplier@example.invalid', role: 'SUPPLIER', name: '[DEMO] 공급자 B' },
  });
  await db.supplierProfile.upsert({
    where: { userId: IDS.b.supplier },
    update: { displayName: '[DEMO] 공급자 B', ndaAgreedAt: NOW, ndaVersion: 'demo-nda', payoutVerifiedAt: NOW },
    create: { userId: IDS.b.supplier, displayName: '[DEMO] 공급자 B', industryCodes: [], skills: [], ndaAgreedAt: NOW, ndaVersion: 'demo-nda', payoutVerifiedAt: NOW },
  });
  await db.draft.upsert({
    where: { id: IDS.b.draft },
    update: { clientId: IDS.b.client, entryType: 'SENTENCE' },
    create: { id: IDS.b.draft, clientId: IDS.b.client, entryType: 'SENTENCE' },
  });
  await db.project.upsert({
    where: { id: IDS.b.project },
    update: { title: '[DEMO] 예약 페이지 B', status: 'CONTRACTED', deadline: DEADLINE },
    create: {
      id: IDS.b.project,
      draftId: IDS.b.draft,
      confirmedAt: NOW,
      disclosureConsentVersion: 'demo-v1',
      title: '[DEMO] 예약 페이지 B',
      summary: '[DEMO] 납품·검수 시연 세트',
      industryCode: 'FOOD',
      requiredSkills: [],
      status: 'CONTRACTED',
      publishedAt: NOW,
      deadline: DEADLINE,
    },
  });
  await db.application.upsert({
    where: { id: IDS.b.application },
    update: { status: 'ACCEPTED', totalAmount: 3_100_000, durationDays: 42 },
    create: {
      id: IDS.b.application,
      projectId: IDS.b.project,
      supplierId: IDS.b.supplier,
      revisionNo: 1,
      specVersionNo: 1,
      status: 'ACCEPTED',
      totalAmount: 3_100_000,
      durationDays: 42,
      message: '[DEMO] 최종 지원',
      firstViewedAt: NOW,
      submittedAt: NOW,
    },
  });
  const contract = {
    id: IDS.b.contract,
    applicationId: IDS.b.application,
    specVersionNo: 1,
    status: 'ACTIVE',
    paymentStatus: 'DEPOSITED',
    agreedAmount: 3_100_000,
    durationDays: 42,
    clientFee: 155_000,
    supplierFee: 155_000,
    interimRatio: 50,
    consentDeadline: NOW,
    contentHash: 'demo-fixture-hash',
    clientSignedAt: NOW,
    supplierSignedAt: NOW,
    depositDeadline: new Date(NOW.getTime() + 3 * 86_400_000),
    workDueAt: WORK_DUE,
    totalDeposited: 3_255_000,
  };
  await db.contract.upsert({ where: { id: IDS.b.contract }, update: contract, create: contract });
  const deposit = {
    id: IDS.b.deposit,
    contractId: IDS.b.contract,
    principal: 3_100_000,
    clientFee: 155_000,
    amount: 3_255_000,
    method: 'CARD',
    status: 'COMPLETED',
    idempotencyKey: 'demo0806-deposit',
    pgKey: 'demo-fixture',
    depositedAt: NOW,
  };
  await db.escrowDeposit.upsert({ where: { id: IDS.b.deposit }, update: deposit, create: deposit });
  for (const [stage, installmentId, amount] of [
    ['INTERIM', IDS.b.interim, 1_550_000],
    ['FINAL', IDS.b.final, 1_550_000],
  ]) {
    const data = {
      id: installmentId,
      contractId: IDS.b.contract,
      stage,
      ratio: 50,
      amount,
      supplierFee: 77_500,
      withholdingTax: 0,
      releaseAmount: amount - 77_500,
      status: 'PENDING',
    };
    await db.paymentInstallment.upsert({ where: { id: installmentId }, update: data, create: data });
  }
  for (const [itemId, stage, title] of [
    [IDS.b.interimItem, 'INTERIM', '[DEMO] 중간 납품'],
    [IDS.b.finalItem, 'FINAL', '[DEMO] 최종 납품'],
  ]) {
    const data = {
      id: itemId,
      contractId: IDS.b.contract,
      blockId: IDS.block,
      title,
      description: '샌드박스 시연용 계약 항목',
      origin: 'AGREEMENT',
      stage,
      conditions: [{ key: 'c1', text: '[DEMO] 예약 가능 시간', state: 'DECIDED', agreed: true, evidenceMessageIds: [] }],
    };
    await db.contractItem.upsert({ where: { id: itemId }, update: data, create: data });
  }
  const delivery = {
    id: IDS.b.delivery,
    installmentId: IDS.b.interim,
    attemptNo: 1,
    items: [{ contractItemId: IDS.b.interimItem, links: [], files: [], howToCheck: '[DEMO] 예약 화면 확인' }],
    summary: '[DEMO] PG 증거 없는 fixture 납품',
    status: 'SUBMITTED',
    submittedAt: NOW,
    inspectionDueAt: INSPECTION_DUE,
  };
  await db.delivery.upsert({ where: { id: IDS.b.delivery }, update: delivery, create: delivery });
}

const args = new Set(process.argv.slice(2));
assertSafeDatabase(process.env.DATABASE_URL);
const plan = summary();
if (args.has('--dry-run')) {
  console.log(JSON.stringify({ mode: 'dry-run', plan }, null, 2));
  process.exit(0);
}

const db = new PrismaClient();
try {
  if (args.has('--reset') || args.has('--reset-only')) await reset(db);
  if (!args.has('--reset-only')) await seed(db);
  console.log(JSON.stringify({ mode: args.has('--reset-only') ? 'reset' : args.has('--reset') ? 'reset+seed' : 'seed', counts: plan }, null, 2));
} finally {
  await db.$disconnect();
}
