import { describe, expect, it } from "@jest/globals";
import {
  assertActionAllowed, assertDraftCapacity, assertDraftOwner, changesUserActivity, DraftError,
  initialPendingFeature, isInactiveForArchive, retryPendingAttempt, sanitizeDraftText, snapshotDraftBlock, visibleDrafts,
} from "./rules.ts";

describe("A-04 초안 규칙", () => {
  it("A-04-T01 실패한 생성을 대기로 기록하고 재시도 횟수를 늘린다", () => {
    // 준비
    const pending = initialPendingFeature("pending-1");

    // 실행
    const retry = retryPendingAttempt(pending, new Date("2026-11-03T00:00:00.000Z"));

    // 확인
    expect(pending).toMatchObject({ attempts: 0, lastTriedAt: null });
    expect(retry).toMatchObject({ attempts: 1, lastTriedAt: "2026-11-03T00:00:00.000Z" });
  });
  it("A-04-T02 31번째 채팅 수정은 거부하되 블록 동작은 허용한다", () => {
    // 확인
    expect(() => assertActionAllowed("CHAT", 30)).toThrow(new DraftError("CHAT_EDIT_LIMIT_REACHED", 409));
    expect(() => assertActionAllowed("ADD_BLOCK", 30)).not.toThrow();
    expect(() => assertActionAllowed("REMOVE_BLOCK", 30)).not.toThrow();
  });
  it("A-04-T03 활성 초안 3개 제한을 강제한다", () => {
    // 확인
    expect(() => assertDraftCapacity(2)).not.toThrow();
    expect(() => assertDraftCapacity(3)).toThrow(new DraftError("ACTIVE_DRAFT_LIMIT_REACHED", 409));
  });
  it("A-04-T04 30일 경계값에서 보관한다", () => {
    // 준비
    const now = new Date("2026-11-03T00:00:00.000Z");

    // 실행 및 확인
    expect(isInactiveForArchive(new Date(now.getTime() - 30 * 86_400_000), now)).toBe(true);
    expect(isInactiveForArchive(new Date(now.getTime() - 30 * 86_400_000 + 1), now)).toBe(false);
  });
  it("A-04-T05 소프트 삭제된 초안을 제외한다", () => {
    // 실행 및 확인
    expect(visibleDrafts([{ id: "live", deletedAt: null }, { id: "gone", deletedAt: new Date() }]).map(row => row.id)).toEqual(["live"]);
  });
  it("A-04-T06 중복 행이 최초 단가 스냅샷을 바꾸지 못하게 한다", () => {
    // 준비
    const first = snapshotDraftBlock(null, { blockId: "b1", unitPrice: 5000 }, "RECOMMENDATION");

    // 실행
    const readded = snapshotDraftBlock({ ...first, status: "REMOVED" }, { blockId: "b1", unitPrice: 9000 }, "RECOMMENDATION");

    // 확인
    expect(readded).toMatchObject({ blockId: "b1", status: "ADDED", unitPrice: 5000 });
  });
  it("A-04-T07 사용자 동작에만 활동을 갱신한다", () => {
    // 확인
    expect(changesUserActivity("ADD_BLOCK")).toBe(true);
    expect(changesUserActivity("BACKGROUND_RETRY")).toBe(false);
    expect(changesUserActivity("BATCH_ARCHIVE")).toBe(false);
    expect(changesUserActivity("READ")).toBe(false);
  });
  it("A-04-T08 다른 소유자에게 초안을 숨긴다", () => {
    // 실행 및 확인
    expect(() => assertDraftOwner({ id: "d1", clientId: "owner", status: "IN_PROGRESS", deletedAt: null }, "other"))
      .toThrow(new DraftError("DRAFT_NOT_FOUND", 404));
  });
  it("AI 입력 전에 프로필 이름·이메일·전화번호를 가린다", () => {
    // 실행
    const safe = sanitizeDraftText("김하나 010-1234-5678 hana@example.invalid", ["김하나"]);

    // 확인
    expect(safe).not.toContain("김하나");
    expect(safe).not.toContain("010-1234-5678");
    expect(safe).not.toContain("hana@example.invalid");
  });
});
