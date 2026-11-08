#!/usr/bin/env node
/**
 * 로컬 시연용 의뢰인/공급자/관리자 계정에 비밀번호를 심는다.
 *
 * - 의뢰인·공급자는 `seed-demo-fixtures.mjs`가 만드는 A·B세트 당사자와 **같은 사용자**다.
 *   그래서 로그인하면 모집·지원·채팅(A)과 예치·검수(B) 화면이 그대로 보인다.
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

// seed-demo-fixtures.mjs의 IDS.a.client / IDS.a.suppliers[0]와 같은 값이어야 한다.
const id = (suffix) => `d0800000-0000-4000-8000-${suffix.padStart(12, '0')}`;

const ACCOUNTS = [
  {
    id: id('10'),
    email: 'demo.client@majayong.local',
    role: 'CLIENT',
    name: '[DEMO] 의뢰인 A',
    profile: { businessName: '[DEMO] 카페 A', profileCompleted: true },
  },
  {
    id: id('11'),
    email: 'demo.supplier@majayong.local',
    role: 'SUPPLIER',
    name: '[DEMO] 공급자 A1',
    profile: {
      displayName: '[DEMO] 공급자 A1',
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
    // 기존 시연 사용자(A·B세트 당사자)가 있으면 그 행에 비밀번호만 더한다.
    const where = account.id ? { id: account.id } : { email: account.email };
    const user = await db.user.upsert({
      where,
      update: { passwordHash, termsVersion: 'v0.7', termsAgreedAt: NOW },
      create: {
        ...(account.id ? { id: account.id } : {}),
        email: account.email,
        role: account.role,
        name: account.name,
        passwordHash,
        termsVersion: 'v0.7',
        termsAgreedAt: NOW,
      },
    });
    if (account.profile && account.role === 'CLIENT') {
      await db.clientProfile.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id, ...account.profile },
      });
    }
    if (account.profile && account.role === 'SUPPLIER') {
      await db.supplierProfile.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id, ...account.profile },
      });
    }
  }
  console.log(JSON.stringify({ accounts: ACCOUNTS.map((a) => ({ email: a.email, role: a.role })) }, null, 2));
} catch (error) {
  if (error?.code === 'P2002') {
    fail('같은 이메일을 쓰는 다른 사용자 행이 있습니다. `npm run db:seed:demo -- --reset` 후 다시 실행하세요.');
  }
  throw error;
} finally {
  await db.$disconnect();
}
