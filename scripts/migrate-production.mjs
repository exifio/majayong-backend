/**
 * production 마이그레이션 실행기.
 *
 * staging URL을 실수로 production에 적용하지 않도록 대상 ref를 검증한다.
 * `.env`에 `PRODUCTION_MIGRATION_DATABASE_URL`을 넣고 실행한다.
 */
import { spawnSync } from 'node:child_process';

const url =
  process.env.PRODUCTION_MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('PRODUCTION_MIGRATION_DATABASE_URL(또는 DATABASE_URL)이 없습니다.');
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error('PRODUCTION_MIGRATION_DATABASE_URL이 올바른 URL이 아닙니다.');
  process.exit(1);
}

const userRef = parsed.username.split('.')[1] ?? '';
const hostRef = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname)?.[1] ?? '';
const ref = userRef || hostRef;
const expected = process.env.PRODUCTION_PROJECT_REF?.trim() || 'fynqcxfoylaljxmqumin';
if (ref !== expected) {
  console.error(`대상 project ref(${ref || '없음'})가 production(${expected})과 다릅니다.`);
  process.exit(1);
}
if (parsed.password.length === 0) {
  console.error('production DB 비밀번호가 URL에 없습니다.');
  process.exit(1);
}

// Direct host(db.<ref>.supabase.co)는 IPv6만 반환할 수 있다. 이 환경처럼 IPv6가
// 없으면 문서(deploy/vercel-supabase.md)에 따라 Session Pooler로 우회한다.
let target = url;
if (process.env.PRODUCTION_USE_POOLER === '1' && /^db\..*\.supabase\.co$/i.test(parsed.hostname)) {
  parsed.hostname =
    process.env.PRODUCTION_POOLER_HOST?.trim() || 'aws-0-ap-northeast-2.pooler.supabase.com';
  parsed.username = `postgres.${expected}`;
  target = parsed.toString();
  console.error(`Session Pooler로 전환: ${parsed.hostname}`);
}

const result = spawnSync(
  process.execPath,
  ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
  {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: target },
  },
);

process.exit(result.status ?? 1);
