/**
 * staging 마이그레이션 실행기.
 *
 * npm script의 `DATABASE_URL="$MIGRATION_DATABASE_URL"`는 `.env`를 읽기 전에
 * 셸이 확장하므로 빈 값이 된다. Node의 `--env-file`로 `.env`를 먼저 읽고
 * Prisma에 DATABASE_URL을 넘긴다.
 */
import { spawnSync } from 'node:child_process';

const migrationUrl = process.env.MIGRATION_DATABASE_URL?.trim();
if (!migrationUrl) {
  console.error('MIGRATION_DATABASE_URL이 .env에 없습니다.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
  {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: migrationUrl },
  },
);

process.exit(result.status ?? 1);
