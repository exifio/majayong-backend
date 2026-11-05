import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ChatError,
  countUnread,
  openConversation,
  listChatRooms,
  listConversation,
  markConversationRead,
  sendMessage,
  shouldMaskContacts,
  type ChatAccountState,
  type ChatActor,
  type ChatApplication,
  type ChatMessage,
  type ChatRepository,
  type ChatRoomListPort,
  type ChatRoomRecord,
  type NewChatMessage,
} from './conversation.ts';
import {
  FIXED_NOW,
  chatApplication,
  chatMessage,
} from '../../../tests/b/fixtures.ts';

function isChatError(status: number, code: string) {
  return (error: unknown): boolean =>
    error instanceof ChatError && error.status === status && error.code === code;
}

function account(overrides: Partial<ChatAccountState> = {}): ChatAccountState {
  return {
    suspendedAt: null,
    withdrawnAt: null,
    chatRestrictedUntil: null,
    ...overrides,
  };
}

const CLIENT: ChatActor = { userId: 'client-1', role: 'CLIENT' };
const SUPPLIER: ChatActor = { userId: 'supplier-1', role: 'SUPPLIER' };
const INTRUDER: ChatActor = { userId: 'intruder', role: 'SUPPLIER' };

class FakeChatRepository implements ChatRepository {
  applications: ChatApplication[];
  messages: ChatMessage[];
  private nextId = 1;

  constructor(
    applications: readonly ChatApplication[],
    messages: readonly ChatMessage[] = [],
  ) {
    this.applications = [...applications];
    this.messages = [...messages];
  }

  async findApplication(applicationId: string): Promise<ChatApplication | null> {
    return this.applications.find((application) => application.id === applicationId) ?? null;
  }

  async findThreadMessages(input: {
    readonly projectId: string;
    readonly supplierId: string;
  }): Promise<readonly ChatMessage[]> {
    const applicationIds = new Set(
      this.applications
        .filter(
          (application) =>
            application.projectId === input.projectId &&
            application.supplierId === input.supplierId,
        )
        .map((application) => application.id),
    );

    return this.messages
      .filter((message) => applicationIds.has(message.applicationId))
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
      );
  }

  async hasMessageFrom(input: {
    readonly projectId: string;
    readonly supplierId: string;
    readonly senderId: string;
  }): Promise<boolean> {
    const messages = await this.findThreadMessages(input);
    return messages.some((message) => message.senderId === input.senderId);
  }

  async createMessage(input: NewChatMessage): Promise<ChatMessage> {
    const created: ChatMessage = {
      ...input,
      id: `msg-new-${this.nextId}`,
      readAt: null,
    };
    this.nextId += 1;
    this.messages.push(created);
    return created;
  }

  async markRead(input: {
    readonly messageIds: readonly string[];
    readonly readerId: string;
    readonly now: Date;
  }): Promise<number> {
    let changed = 0;
    for (let index = 0; index < this.messages.length; index += 1) {
      const message = this.messages[index];
      if (message === undefined) continue;
      if (!input.messageIds.includes(message.id)) continue;
      if (message.senderId === input.readerId || message.readAt !== null) continue;

      this.messages[index] = { ...message, readAt: input.now };
      changed += 1;
    }
    return changed;
  }

}

describe('B-03-T01 공급자 선시작 금지', () => {
  it('문의방은 의뢰인만 열고 최초 INQUIRY_OPENED 기록은 한 번만 남긴다', async () => {
    // 준비
    const repository = new FakeChatRepository([chatApplication()]);
    const recorded: { projectId: string; clientUserId: string; openedAt: Date }[] = [];
    const openedProjects = new Set<string>();
    const port = {
      async recordInquiryOpenedOnce(input: (typeof recorded)[number]) {
        if (openedProjects.has(input.projectId)) return false;
        openedProjects.add(input.projectId);
        recorded.push(input);
        return true;
      },
    };

    // 실행 및 확인
    await assert.rejects(
      openConversation(repository, {
        actor: SUPPLIER, applicationId: 'app-1', now: FIXED_NOW, events: port,
      }),
      isChatError(403, 'CLIENT_ONLY'),
    );
    // 확인
    assert.equal(recorded.length, 0);
    // 실행 및 확인
    await assert.rejects(openConversation(repository, {
      actor: INTRUDER, applicationId: 'app-1', now: FIXED_NOW, events: port,
    }), isChatError(404, 'CHAT_NOT_FOUND'));

    assert.deepEqual(await openConversation(repository, {
      actor: CLIENT, applicationId: 'app-1', now: FIXED_NOW, events: port,
    }), { opened: true });
    assert.deepEqual(await openConversation(repository, {
      actor: CLIENT, applicationId: 'app-1', now: new Date(FIXED_NOW.getTime() + 1000), events: port,
    }), { opened: false });
    // 확인
    assert.deepEqual(recorded, [{
      projectId: 'prj-1', clientUserId: 'client-1', openedAt: FIXED_NOW,
    }]);
  });

  it('의뢰인 메시지가 없으면 공급자 발신은 403 CHAT_NOT_STARTED다', async () => {
    // 준비
    const repository = new FakeChatRepository([chatApplication()]);

    // 실행 및 확인
    await assert.rejects(
      sendMessage(repository, {
        actor: SUPPLIER,
        account: account(),
        applicationId: 'app-1',
        body: '먼저 연락드립니다.',
        now: FIXED_NOW,
      }),
      isChatError(403, 'CHAT_NOT_STARTED'),
    );
    // 확인
    assert.equal(repository.messages.length, 0);
  });

  it('의뢰인이 먼저 보내면 그 뒤 공급자도 보낼 수 있다', async () => {
    // 준비
    const repository = new FakeChatRepository([chatApplication()]);

    // 실행
    await sendMessage(repository, {
      actor: CLIENT,
      account: account(),
      applicationId: 'app-1',
      body: '문의드립니다.',
      now: FIXED_NOW,
    });
    const reply = await sendMessage(repository, {
      actor: SUPPLIER,
      account: account(),
      applicationId: 'app-1',
      body: '확인했습니다.',
      now: new Date('2026-11-03T00:10:00.000Z'),
    });

    // 확인
    assert.equal(reply.body, '확인했습니다.');
    assert.equal(repository.messages.length, 2);
  });

  it('빈 메시지는 400 MESSAGE_EMPTY다', async () => {
    // 준비
    const repository = new FakeChatRepository([chatApplication()]);

    // 실행 및 확인
    await assert.rejects(
      sendMessage(repository, {
        actor: CLIENT,
        account: account(),
        applicationId: 'app-1',
        body: '   ',
        now: FIXED_NOW,
      }),
      isChatError(400, 'MESSAGE_EMPTY'),
    );
  });
});

describe('B-03-T02 계약 체결 전 연락처 가림', () => {
  it('계약 전(임시 계약 포함)에는 전화·이메일·메신저 ID를 가린 본문만 저장한다', async () => {
    // 준비
    const body = '010-1234-5678, owner@example.com, 카톡: chef123 으로 연락 주세요.';

    // 실행 및 확인
    for (const contractStatus of [null, 'PENDING_CONSENT'] as const) {
      const repository = new FakeChatRepository([chatApplication({ contractStatus })]);

      const created = await sendMessage(repository, {
        actor: CLIENT,
        account: account(),
        applicationId: 'app-1',
        body,
        now: FIXED_NOW,
      });

      assert.equal(created.isMasked, true);
      assert.equal(created.body.includes('[연락처 비공개]'), true);

      const stored = JSON.stringify(repository.messages);
      for (const original of ['010-1234-5678', 'owner@example.com', 'chef123']) {
        assert.equal(stored.includes(original), false);
      }
    }
  });

  it('계약 체결(ACTIVE) 뒤에는 가리지 않는다', async () => {
    // 준비
    const repository = new FakeChatRepository([
      chatApplication({ contractStatus: 'ACTIVE' }),
    ]);

    // 실행
    const created = await sendMessage(repository, {
      actor: CLIENT,
      account: account(),
      applicationId: 'app-1',
      body: '010-1234-5678 로 연락 주세요.',
      now: FIXED_NOW,
    });

    // 확인
    assert.equal(created.isMasked, false);
    assert.equal(created.body.includes('010-1234-5678'), true);
  });

  it('가림 여부는 계약 저장 상태만으로 판정한다', () => {
    // 실행 및 확인
    assert.equal(shouldMaskContacts(chatApplication({ contractStatus: null })), true);
    assert.equal(
      shouldMaskContacts(chatApplication({ contractStatus: 'PENDING_CONSENT' })),
      true,
    );
    assert.equal(shouldMaskContacts(chatApplication({ contractStatus: 'ACTIVE' })), false);
    assert.equal(
      shouldMaskContacts(chatApplication({ contractStatus: 'COMPLETED' })),
      false,
    );
  });
});

describe('B-03-T03 회차를 이은 하나의 대화', () => {
  const applications = [
    chatApplication({ id: 'app-1', status: 'SUPERSEDED' }),
    chatApplication({ id: 'app-2', status: 'SUBMITTED' }),
  ];

  it('이전·현재 회차 메시지를 시간순으로 함께 읽는다', async () => {
    // 준비
    const repository = new FakeChatRepository(applications, [
      chatMessage({
        id: 'msg-1',
        applicationId: 'app-1',
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
      }),
      chatMessage({
        id: 'msg-2',
        applicationId: 'app-2',
        senderId: 'supplier-1',
        createdAt: new Date('2026-11-01T00:05:00.000Z'),
      }),
    ]);

    // 실행
    const view = await listConversation(repository, {
      actor: CLIENT,
      applicationId: 'app-2',
    });

    // 확인
    assert.deepEqual(
      view.messages.map((message) => message.id),
      ['msg-1', 'msg-2'],
    );
    assert.equal(view.unreadCount, 1);
  });

  it('이전 회차의 의뢰인 메시지가 있으면 새 회차에서도 공급자가 답할 수 있다', async () => {
    // 준비
    const repository = new FakeChatRepository(applications, [
      chatMessage({ id: 'msg-1', applicationId: 'app-1' }),
    ]);

    // 실행
    const reply = await sendMessage(repository, {
      actor: SUPPLIER,
      account: account(),
      applicationId: 'app-2',
      body: '새 회차 확인했습니다.',
      now: new Date('2026-11-03T00:00:00.000Z'),
    });

    // 확인
    assert.equal(reply.applicationId, 'app-2');
  });

  it('after 이후 메시지만 텍스트 폴링으로 가져온다', async () => {
    // 준비
    const repository = new FakeChatRepository(applications, [
      chatMessage({
        id: 'msg-1',
        applicationId: 'app-1',
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
      }),
      chatMessage({
        id: 'msg-2',
        applicationId: 'app-2',
        createdAt: new Date('2026-11-01T00:10:00.000Z'),
      }),
    ]);

    // 실행
    const view = await listConversation(repository, {
      actor: CLIENT,
      applicationId: 'app-2',
      after: new Date('2026-11-01T00:05:00.000Z'),
    });

    // 확인
    assert.deepEqual(
      view.messages.map((message) => message.id),
      ['msg-2'],
    );
  });
});

describe('B-03-T04 거절·철회·자동 거절은 읽기 전용', () => {
  it('종료된 지원에는 쓰지 못하고 읽을 수는 있다', async () => {
    // 준비
    const statuses = ['REJECTED', 'AUTO_REJECTED', 'WITHDRAWN', 'SUPERSEDED'] as const;

    // 실행 및 확인
    for (const status of statuses) {
      const repository = new FakeChatRepository([chatApplication({ status })], [
        chatMessage({ id: 'msg-1' }),
      ]);

      await assert.rejects(
        sendMessage(repository, {
          actor: CLIENT,
          account: account(),
          applicationId: 'app-1',
          body: '추가 문의입니다.',
          now: FIXED_NOW,
        }),
        isChatError(403, 'CHAT_READ_ONLY'),
      );

      const view = await listConversation(repository, {
        actor: CLIENT,
        applicationId: 'app-1',
      });
      assert.equal(view.messages.length, 1);
    }
  });
});

describe('B-03-T05 정지·채팅 제한·탈퇴', () => {
  it('정지 계정은 쓰기만 막고 읽기는 허용한다', async () => {
    // 준비
    const repository = new FakeChatRepository([chatApplication()], [
      chatMessage({ id: 'msg-1' }),
    ]);

    // 실행 및 확인
    await assert.rejects(
      sendMessage(repository, {
        actor: CLIENT,
        account: account({ suspendedAt: new Date('2026-11-02T00:00:00.000Z') }),
        applicationId: 'app-1',
        body: '안녕하세요.',
        now: FIXED_NOW,
      }),
      isChatError(403, 'ACCOUNT_SUSPENDED'),
    );
  });

  it('B-03-T05b 정지 계정도 대화는 읽을 수 있다', async () => {
    // 준비
    const repository = new FakeChatRepository([chatApplication()], [
      chatMessage({ id: 'msg-1' }),
    ]);

    // 실행
    const view = await listConversation(repository, {
      actor: CLIENT,
      applicationId: 'app-1',
    });
    // 확인
    assert.equal(view.messages.length, 1);
  });

  it('탈퇴 계정은 쓸 수 없다', async () => {
    // 준비
    const repository = new FakeChatRepository([chatApplication()], [
      chatMessage({ id: 'msg-1' }),
    ]);

    // 실행 및 확인
    await assert.rejects(
      sendMessage(repository, {
        actor: CLIENT,
        account: account({ withdrawnAt: new Date('2026-11-02T00:00:00.000Z') }),
        applicationId: 'app-1',
        body: '안녕하세요.',
        now: FIXED_NOW,
      }),
      isChatError(403, 'ACCOUNT_WITHDRAWN'),
    );
  });

  it('채팅 제한 기간에는 쓰지 못하고 지나면 다시 쓸 수 있다', async () => {
    // 준비
    const repository = new FakeChatRepository([chatApplication()], [
      chatMessage({ id: 'msg-1' }),
    ]);

    // 실행 및 확인
    await assert.rejects(
      sendMessage(repository, {
        actor: CLIENT,
        account: account({ chatRestrictedUntil: new Date('2026-11-10T00:00:00.000Z') }),
        applicationId: 'app-1',
        body: '안녕하세요.',
        now: FIXED_NOW,
      }),
      isChatError(403, 'CHAT_RESTRICTED'),
    );

    // 실행
    const created = await sendMessage(repository, {
      actor: CLIENT,
      account: account({ chatRestrictedUntil: new Date('2026-11-01T00:00:00.000Z') }),
      applicationId: 'app-1',
      body: '제한이 풀렸습니다.',
      now: FIXED_NOW,
    });
    // 확인
    assert.equal(created.body, '제한이 풀렸습니다.');
  });
});

describe('B-03-T06 비당사자 접근', () => {
  it('지원 당사자가 아니면 읽기·쓰기·읽음 처리 모두 404다', async () => {
    // 준비
    const repository = new FakeChatRepository([chatApplication()], [
      chatMessage({ id: 'msg-1' }),
    ]);

    // 실행 및 확인
    await assert.rejects(
      listConversation(repository, { actor: INTRUDER, applicationId: 'app-1' }),
      isChatError(404, 'CHAT_NOT_FOUND'),
    );
    await assert.rejects(
      sendMessage(repository, {
        actor: INTRUDER,
        account: account(),
        applicationId: 'app-1',
        body: '몰래 보냅니다.',
        now: FIXED_NOW,
      }),
      isChatError(404, 'CHAT_NOT_FOUND'),
    );
    await assert.rejects(
      markConversationRead(repository, {
        actor: INTRUDER,
        applicationId: 'app-1',
        now: FIXED_NOW,
      }),
      isChatError(404, 'CHAT_NOT_FOUND'),
    );
  });
});

describe('B-03-T07 읽음 처리와 안 읽은 수', () => {
  const readAt = new Date('2026-11-03T01:00:00.000Z');

  function repositoryWithMessages(): FakeChatRepository {
    return new FakeChatRepository([chatApplication()], [
      chatMessage({ id: 'msg-1', senderId: 'client-1' }),
      chatMessage({ id: 'msg-2', senderId: 'supplier-1' }),
      chatMessage({ id: 'msg-3', senderId: 'client-1' }),
    ]);
  }

  it('일괄 읽음 후 내가 받은 메시지의 안 읽은 수만 0이 된다', async () => {
    // 준비
    const repository = repositoryWithMessages();

    // 실행 및 확인
    assert.equal(
      (await listConversation(repository, { actor: SUPPLIER, applicationId: 'app-1' }))
        .unreadCount,
      2,
    );

    // 실행
    const changed = await markConversationRead(repository, {
      actor: SUPPLIER,
      applicationId: 'app-1',
      now: readAt,
    });

    // 확인
    assert.equal(changed, 2);
    // 실행 및 확인
    assert.equal(
      (await listConversation(repository, { actor: SUPPLIER, applicationId: 'app-1' }))
        .unreadCount,
      0,
    );

    // 확인
    assert.equal(repository.messages[0]?.readAt?.toISOString(), readAt.toISOString());
    assert.equal(repository.messages[1]?.readAt, null);
    assert.equal(repository.messages[2]?.readAt?.toISOString(), readAt.toISOString());

    // 실행 및 확인
    assert.equal(
      (await listConversation(repository, { actor: CLIENT, applicationId: 'app-1' }))
        .unreadCount,
      1,
    );
    assert.equal(
      await markConversationRead(repository, {
        actor: SUPPLIER,
        applicationId: 'app-1',
        now: readAt,
      }),
      0,
    );
  });

  it('안 읽은 수는 내가 보낸 메시지를 세지 않는다', () => {
    // 준비
    const messages = [
      chatMessage({ id: 'm1', senderId: 'client-1' }),
      chatMessage({ id: 'm2', senderId: 'supplier-1' }),
      chatMessage({ id: 'm3', senderId: 'client-1' }),
    ];

    // 확인
    assert.equal(countUnread(messages, 'supplier-1'), 2);
    assert.equal(countUnread(messages, 'client-1'), 1);
  });
});

describe('B-03-T08 방별 새 메시지 알림 연결', () => {
  it('저장된 메시지의 방 식별자·양 당사자·발신자·시각으로 알림을 한 번 요청한다', async () => {
    // 준비
    const repository = new FakeChatRepository([chatApplication()], [
      chatMessage({ id: 'msg-1' }),
    ]);
    const calls: {
      projectId: string;
      supplierId: string;
      clientUserId: string;
      supplierUserId: string;
      senderId: string;
      now: Date;
    }[] = [];
    const notifications = {
      async notifyNewMessage(input: (typeof calls)[number]) {
        calls.push(input);
      },
    };

    // 실행
    const created = await sendMessage(repository, {
      actor: CLIENT,
      account: account(),
      applicationId: 'app-1',
      body: '알림 확인 부탁드립니다.',
      now: FIXED_NOW,
      notifications,
    });

    // 확인
    assert.equal(repository.messages.at(-1)?.id, created.id);
    assert.deepEqual(calls, [{
      projectId: 'prj-1',
      supplierId: 'supplier-1',
      clientUserId: 'client-1',
      supplierUserId: 'supplier-1',
      senderId: 'client-1',
      now: FIXED_NOW,
    }]);
  });

  it('발신이 거부되면 알림을 만들지 않는다', async () => {
    // 준비
    const repository = new FakeChatRepository([
      chatApplication({ status: 'REJECTED' }),
    ]);
    let calls = 0;
    const notifications = {
      async notifyNewMessage() {
        calls += 1;
      },
    };

    // 실행 및 확인
    await assert.rejects(
      sendMessage(repository, {
        actor: CLIENT,
        account: account(),
        applicationId: 'app-1',
        body: '거절된 지원입니다.',
        now: FIXED_NOW,
        notifications,
      }),
      isChatError(403, 'CHAT_READ_ONLY'),
    );
    // 확인
    assert.equal(calls, 0);
  });
});

describe('B-03-T05 채팅방 표시 정보', () => {
  function room(overrides: Partial<ChatRoomRecord> = {}): ChatRoomRecord {
    return {
      ...chatApplication(),
      messages: [chatMessage()],
      projectTitle: '예약 기능',
      clientDisplayName: '김의뢰',
      supplierDisplayName: '박공급',
      ...overrides,
    };
  }
  function port(rooms: readonly ChatRoomRecord[]): ChatRoomListPort {
    return {
      async listRoomsForUser() {
        return rooms;
      },
    };
  }

  it('CLIENT에게는 상대 공급자 표시 이름과 프로젝트 제목을 준다', async () => {
    // 실행
    const rooms = await listChatRooms(port([room()]), { actor: CLIENT });
    // 확인
    assert.equal(rooms[0]?.projectTitle, '예약 기능');
    assert.equal(rooms[0]?.counterpartDisplayName, '박공급');
  });

  it('SUPPLIER에게는 상대 의뢰인 표시 이름과 프로젝트 제목을 준다', async () => {
    // 실행
    const rooms = await listChatRooms(port([room()]), { actor: SUPPLIER });
    // 확인
    assert.equal(rooms[0]?.projectTitle, '예약 기능');
    assert.equal(rooms[0]?.counterpartDisplayName, '김의뢰');
  });

  it('비당사자에게는 방을 주지 않는다', async () => {
    // 실행
    const rooms = await listChatRooms(port([room()]), { actor: INTRUDER });
    // 확인
    assert.equal(rooms.length, 0);
  });
});
