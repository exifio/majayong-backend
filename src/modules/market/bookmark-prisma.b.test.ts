import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPrismaBookmarkRepository,
  type BookmarkDbClient,
} from './prisma-adapter.ts';
import type { BookmarkRecord } from './bookmarks.ts';
import { FIXED_NOW } from '../../../tests/b/fixtures.ts';

function makeDb(rows: BookmarkRecord[]) {
  let failDelete = false;
  const db: BookmarkDbClient = {
    bookmark: {
      async findUnique(input) {
        const { supplierId, projectId } = input.where.supplierId_projectId;
        return (
          rows.find((row) => row.supplierId === supplierId && row.projectId === projectId) ?? null
        );
      },
      async create(input) {
        rows.push(input.data);
        return input.data;
      },
      async delete(input) {
        if (failDelete) {
          const error = new Error('not found');
          Object.assign(error, { code: 'P2025' });
          throw error;
        }
        const { supplierId, projectId } = input.where.supplierId_projectId;
        const index = rows.findIndex(
          (row) => row.supplierId === supplierId && row.projectId === projectId,
        );
        const removed = rows[index];
        if (index < 0 || removed === undefined) throw new Error('missing');
        rows.splice(index, 1);
        return removed;
      },
      async findMany(input) {
        return rows.filter((row) => row.supplierId === input.where.supplierId);
      },
    },
  };
  return { db, failDelete: () => { failDelete = true; } };
}

describe('B-01 Prisma 북마크 어댑터', () => {
  it('저장·조회·목록을 supplierId 기준으로 처리한다', async () => {
    // 준비
    const fixture = makeDb([]);
    const repository = createPrismaBookmarkRepository(fixture.db);

    // 실행
    const saved = await repository.create({
      supplierId: 'supplier-1',
      projectId: 'prj-1',
      createdAt: FIXED_NOW,
    });
    // 확인
    assert.equal(saved.projectId, 'prj-1');
    // 실행 및 확인
    assert.equal(
      (await repository.findByKey({ supplierId: 'supplier-1', projectId: 'prj-1' }))?.projectId,
      'prj-1',
    );
    assert.equal((await repository.listBySupplier('supplier-1')).length, 1);
  });

  it('해제는 삭제 여부를 boolean으로 돌려주고 없는 행은 false다', async () => {
    // 준비
    const fixture = makeDb([
      { supplierId: 'supplier-1', projectId: 'prj-1', createdAt: FIXED_NOW },
    ]);
    const repository = createPrismaBookmarkRepository(fixture.db);

    // 실행 및 확인
    assert.equal(
      await repository.delete({ supplierId: 'supplier-1', projectId: 'prj-1' }),
      true,
    );
    // 준비
    fixture.failDelete();
    // 실행 및 확인
    assert.equal(
      await repository.delete({ supplierId: 'supplier-1', projectId: 'prj-1' }),
      false,
    );
  });
});
