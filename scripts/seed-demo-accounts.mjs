#!/usr/bin/env node
/**
 * 로컬 시연용 의뢰인/공급자/관리자 계정을 만든다.
 *
 * - 이메일: demo.client@majayong.local / demo.supplier@majayong.local / demo.admin@majayong.local
 * - 비밀번호: DEMO_PASSWORD 환경변수 (필수, 저장소에 남기지 않는다)
 * - 운영/공유 DB는 guard가 거부한다. 로컬 *_test/_check/_staging DB이거나 ALLOW_DEMO_SEED=1이어야 한다.
 *
 * 사용:
 *   npm run build
 *   DEMO_PASSWORD=... ALLOW_DEMO_SEED=1 node --env-file=.env scripts/seed-demo-accounts.mjs
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../dist/modules/identity/auth.js';

const PASSWORD = process.env.DEMO_PASSWORD;
const NOW = new Date();

const ACCOUNTS = [
  {
    email: 'demo.client@majayong.local',
    role: 'CLIENT',
    name: '[DEMO] 의뢰인',
    profile: { businessName: '[DEMO] 카페', profileCompleted: true },
  },
  {
    email: 'demo.supplier@majayong.local',
    role: 'SUPPLIER',
    name: '[DEMO] 공급자',
    profile: {
      displayName: '[DEMO] 공급자',
      industryCodes: [],
      skills: [],
      ndaAgreedAt: NOW,
      ndaVersion: 'demo-nda',
      payoutVerifiedAt: NOW,
    },
  },
  {
    email: 'demo.admin@majayong.local',
    role: 'ADMIN',
    name: '[DEMO] 운영자',
  },
];

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
  if (process.env.ALLOW_DEMO_SEED !== '1' && !(local && dedicated)) {
    fail(`refusing database "${dbName}" on "${host}": use a local *_test/_check/_staging DB or ALLOW_DEMO_SEED=1`);
  }
}

function fail(message) {
  console.error(`seed-demo-accounts: ${message}`);
  process.exit(1);
}

assertSafeDatabase(process.env.DATABASE_URL);
if (!PASSWORD) fail('DEMO_PASSWORD is required');

const passwordHash = await hashPassword(PASSWORD);
const db = new PrismaClient();
try {
  for (const account of ACCOUNTS) {
    const user = await db.user.upsert({
      where: { email: account.email },
      update: { role: account.role, name: account.name, passwordHash, termsVersion: 'v0.7', termsAgreedAt: NOW },
      create: {
        email: account.email,
        role: account.role,
        name: account.name,
        passwordHash,
        termsVersion: 'v0.7',
        termsAgreedAt: NOW,
      },
    });
    if (account.role === 'CLIENT') {
      await db.clientProfile.upsert({
        where: { userId: user.id },
        update: account.profile,
        create: { userId: user.id, ...account.profile },
      });
    }
    if (account.role === 'SUPPLIER') {
      await db.supplierProfile.upsert({
        where: { userId: user.id },
        update: account.profile,
        create: { userId: user.id, ...account.profile },
      });
    }
  }
  console.log(JSON.stringify({ accounts: ACCOUNTS.map((a) => ({ email: a.email, role: a.role })) }, null, 2));
} finally {
  await db.$disconnect();
}
