import { describe, expect, it, jest } from "@jest/globals";
import { WithdrawalStore, withdrawAccount } from "./auth.ts";

describe("계정 탈퇴", () => {
  it("계약 조회 포트가 진행 중 작업을 보고하면 탈퇴를 막는다", async () => {
    // 준비
    const now = new Date("2026-11-03T00:00:00.000Z");
    const store: WithdrawalStore = {
      withdrawIfNoBlockingContracts: jest.fn(async () => "BLOCKED" as const),
    };

    // 실행 및 확인
    await expect(withdrawAccount(store, "user-1", now))
      .rejects.toMatchObject({ code: "ACTIVE_CONTRACTS_EXIST" });

    // 확인
    expect(store.withdrawIfNoBlockingContracts).toHaveBeenCalledWith("user-1", now);
  });
});
