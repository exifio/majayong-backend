import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPrismaChatRepository,
  createPrismaChatRoomListPort,
  type ChatApplicationRow,
  type ChatDbClient,
  type ChatMessageRow,
} from './prisma-adapter.ts';
import { FIXED_NOW } from '../../../tests/b/fixtures.ts';

function message(overrides: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id: 'msg-1',
    applicationId: 'app-1',
    senderId: 'client-1',
    kind: 'TEXT',
    body: '안녕하세요',
    isMasked: false,
    readAt: null,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

function application(overrides: Partial<ChatApplicationRow> = {}): ChatApplicationRow {
  return {
    id: 'app-1',
    projectId: 'prj-1',
    supplierId: 'supplier-1',
    status: 'SUBMITTED',
    project: {
      title: '예약 기능',
      draft: {
        clientId: 'client-1',
        client: { name: '김의뢰', clientProfile: { businessName: '카페 블루' } },
      },
    },
    supplier: { displayName: '박공급' },
    contract: null,
    ...overrides,
  };
}

function makeDb(applications: readonly ChatApplicationRow[], messages: ChatMessageRow[]) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const db: ChatDbClient = {
    application: {
      async findUnique(input) {
        return applications.find((candidate) => candidate.id === input.where.id) ?? null;
      },
      async findMany(input) {
        const where = input.where as {
          OR?: readonly Readonly<Record<string, unknown>>[];
        };
        if (where.OR === undefined) return applications;
        return applications.filter((candidate) =>
          where.OR?.some((condition) => {
            const supplierId = condition.supplierId;
            if (typeof supplierId === 'string') return candidate.supplierId === supplierId;
            const project = condition.project as
              | { is?: { draft?: { is?: { clientId?: string } } } }
              | undefined;
            return project?.is?.draft?.is?.clientId === candidate.project.draft.clientId;
          }),
        );
      },
    },
    applicationMessage: {
      async findMany() {
        return messages;
      },
      async findFirst() {
        return messages.length === 0 ? null : { id: messages[0]?.id ?? 'msg-1' };
      },
      async create(input) {
        created.push(input.data);
        return message({
          applicationId: String(input.data.applicationId),
          senderId: input.data.senderId as string | null,
          kind: input.data.kind as 'TEXT' | 'SYSTEM',
          body: String(input.data.body),
          isMasked: Boolean(input.data.isMasked),
          createdAt: input.data.createdAt as Date,
        });
      },
      async updateMany(input) {
        updated.push(input.data);
        return { count: messages.filter((row) => row.readAt === null).length };
      },
    },
  };
  return { db, created, updated };
}

describe('B-03 Prisma 채팅 어댑터', () => {
  it('Project.clientId를 clientUserId로 매핑하고 계약 상태를 붙인다', async () => {
    // 준비
    const fixture = makeDb([application({ contract: { status: 'ACTIVE' } })], []);
    const repository = createPrismaChatRepository(fixture.db);

    // 실행
    const found = await repository.findApplication('app-1');

    // 확인
    assert.equal(found?.clientUserId, 'client-1');
    assert.equal(found?.contractStatus, 'ACTIVE');
  });

  it('회차와 무관하게 projectId+supplierId로 대화를 읽고, 메시지를 저장한다', async () => {
    // 준비
    const fixture = makeDb([application()], [message()]);
    const repository = createPrismaChatRepository(fixture.db);

    // 실행
    const thread = await repository.findThreadMessages({
      projectId: 'prj-1',
      supplierId: 'supplier-1',
    });
    // 확인
    assert.equal(thread.length, 1);
    assert.equal(thread[0]?.body, '안녕하세요');
    // 실행 및 확인
    assert.equal(
      await repository.hasMessageFrom({
        projectId: 'prj-1',
        supplierId: 'supplier-1',
        senderId: 'client-1',
      }),
      true,
    );

    // 실행
    const created = await repository.createMessage({
      applicationId: 'app-1',
      senderId: 'supplier-1',
      kind: 'TEXT',
      body: '네 가능합니다',
      isMasked: false,
      createdAt: FIXED_NOW,
    });
    // 확인
    assert.equal(created.body, '네 가능합니다');
    assert.equal(fixture.created.length, 1);
  });

  it('읽음 처리는 상대 메시지만 갱신한다', async () => {
    // 준비
    const fixture = makeDb([application()], [message()]);
    const repository = createPrismaChatRepository(fixture.db);

    // 실행 및 확인
    assert.equal(
      await repository.markRead({ messageIds: ['msg-1'], readerId: 'supplier-1', now: FIXED_NOW }),
      1,
    );
    // 확인
    assert.deepEqual(fixture.updated[0], { readAt: FIXED_NOW });
    // 실행 및 확인
    assert.equal(
      await repository.markRead({ messageIds: [], readerId: 'supplier-1', now: FIXED_NOW }),
      0,
    );
  });

  it('내 채팅방 목록은 참여한 방만 돌려준다', async () => {
    // 준비
    const fixture = makeDb(
      [
        application({ id: 'app-1', messages: [message()] }),
        application({
          id: 'app-2',
          supplierId: 'supplier-2',
          project: {
            title: '다른 프로젝트',
            draft: {
              clientId: 'client-2',
              client: { name: '이다른', clientProfile: { businessName: '다른 가게' } },
            },
          },
          supplier: { displayName: '최공급' },
          messages: [],
        }),
      ],
      [message()],
    );
    const port = createPrismaChatRoomListPort(fixture.db);

    // 실행
    const rooms = await port.listRoomsForUser('client-1');

    // 확인
    assert.deepEqual(rooms.map((room) => room.id), ['app-1']);
    assert.equal(rooms[0]?.messages.length, 1);
    assert.equal(rooms[0]?.projectTitle, '예약 기능');
    assert.equal(rooms[0]?.clientDisplayName, '김의뢰');
    assert.equal(rooms[0]?.supplierDisplayName, '박공급');
  });

  it('의뢰인 이름이 없으면 상호를 표시 이름으로 쓴다', async () => {
    // 준비
    const fixture = makeDb(
      [
        application({
          messages: [message()],
          project: {
            title: '예약 기능',
            draft: {
              clientId: 'client-1',
              client: { name: null, clientProfile: { businessName: '카페 블루' } },
            },
          },
        }),
      ],
      [message()],
    );
    const port = createPrismaChatRoomListPort(fixture.db);

    // 실행
    const rooms = await port.listRoomsForUser('supplier-1');

    // 확인
    assert.equal(rooms[0]?.clientDisplayName, '카페 블루');
  });
});
