import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ReviewService,
  ReviewHttpError,
  createInMemoryReviewRepository,
  type ReviewContractEntity,
} from "./index.ts";

describe("C-07: 완료 후 상호 리뷰·공개 평점", () => {
  const baseTime = new Date("2026-11-25T10:00:00.000Z");

  function createTestSetup(options?: { contractStatus?: string }) {
    const repo = createInMemoryReviewRepository();

    const contract: ReviewContractEntity = {
      id: "contract-c07",
      clientUserId: "client-c07",
      supplierUserId: "supplier-c07",
      status: options?.contractStatus ?? "COMPLETED",
    };

    let profileStatsUpdateCount = 0;
    const profilePorts = {
      async updateProfileReviewStats(input: { targetUserId: string; rating: number }) {
        profileStatsUpdateCount++;
        return { success: true };
      },
    };

    repo.seedContract(contract);

    const service = new ReviewService({
      repo,
      profilePorts,
      clock: { now: () => baseTime },
    });

    return { repo, contract, service, getStatsUpdateCount: () => profileStatsUpdateCount };
  }

  it("C-07-T01 계약 완료 전 리뷰 불가", async () => {
    // 준비: 계약이 아직 ACTIVE(진행 중) 상태
    const { service, contract } = createTestSetup({ contractStatus: "ACTIVE" });

    // 실행 및 확인: 완료 전 리뷰 작성은 409로 거부
    await assert.rejects(
      () =>
        service.createReview(
          { userId: contract.clientUserId, role: "CLIENT" },
          {
            contractId: contract.id,
            rating: 5,
            comment: "좋은 작업이었습니다.",
            tags: ["전문적이에요", "친절해요"],
          },
        ),
      (err: unknown) => {
        if (!(err instanceof ReviewHttpError)) return false;
        assert.equal(err.status, 409);
        assert.match(err.message, /완료된 계약만/);
        return true;
      },
    );
  });

  it("C-07-T02 계약당 작성자 1회 유니크", async () => {
    // 준비
    const { service, contract } = createTestSetup();

    // 실행: 1회차 리뷰 작성
    const r1 = await service.createReview(
      { userId: contract.clientUserId, role: "CLIENT" },
      {
        contractId: contract.id,
        rating: 5,
        comment: "완벽합니다.",
        tags: ["친절해요"],
      },
    );
    // 확인: 1회차 정상 저장
    assert.equal(r1.rating, 5);

    // 실행 및 확인: 동일 작성자가 동일 계약에 2회차 작성하면 409로 거부
    await assert.rejects(
      () =>
        service.createReview(
          { userId: contract.clientUserId, role: "CLIENT" },
          {
            contractId: contract.id,
            rating: 4,
            comment: "중복 작성 시도",
            tags: [],
          },
        ),
      (err: unknown) => {
        if (!(err instanceof ReviewHttpError)) return false;
        assert.equal(err.status, 409);
        assert.match(err.message, /이미 리뷰를 작성/);
        return true;
      },
    );
  });

  it("C-07-T03 별점 0/6/소수 차단", async () => {
    // 준비
    const { service, contract } = createTestSetup();

    // 실행 및 확인: 0점 차단
    await assert.rejects(
      () =>
        service.createReview(
          { userId: contract.clientUserId, role: "CLIENT" },
          { contractId: contract.id, rating: 0, tags: [] },
        ),
      (err: unknown) => {
        if (!(err instanceof ReviewHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /1~5/);
        return true;
      },
    );

    // 실행 및 확인: 6점 차단
    await assert.rejects(
      () =>
        service.createReview(
          { userId: contract.clientUserId, role: "CLIENT" },
          { contractId: contract.id, rating: 6, tags: [] },
        ),
      (err: unknown) => {
        if (!(err instanceof ReviewHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /1~5/);
        return true;
      },
    );

    // 실행 및 확인: 4.5 소수 차단 (정수만 허용)
    await assert.rejects(
      () =>
        service.createReview(
          { userId: contract.clientUserId, role: "CLIENT" },
          { contractId: contract.id, rating: 4.5, tags: [] },
        ),
      (err: unknown) => {
        if (!(err instanceof ReviewHttpError)) return false;
        assert.equal(err.status, 400);
        assert.match(err.message, /정수/);
        return true;
      },
    );
  });

  it("C-07-T04 리뷰 수정/삭제 차단", async () => {
    // 준비
    const { service, contract } = createTestSetup();

    // 실행: 리뷰 작성
    const r = await service.createReview(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, rating: 5, comment: "초기 리뷰", tags: [] },
    );

    // 확인: 수정 불가
    assert.equal(typeof (service as unknown as Record<string, unknown>).updateReview, "undefined");
    // 확인: 삭제 불가
    assert.equal(typeof (service as unknown as Record<string, unknown>).deleteReview, "undefined");
  });

  it("C-07-T05 중복 제출 시 평점 캐시 중복계산 0", async () => {
    // 준비
    const { service, contract, getStatsUpdateCount } = createTestSetup();

    // 실행: 1회차 작성 성공
    await service.createReview(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, rating: 5, tags: [] },
    );
    // 확인: 캐시 갱신 1회
    assert.equal(getStatsUpdateCount(), 1);

    // 실행 및 확인: 2회차 작성 실패
    await assert.rejects(
      () =>
        service.createReview(
          { userId: contract.clientUserId, role: "CLIENT" },
          { contractId: contract.id, rating: 5, tags: [] },
        ),
      ReviewHttpError,
    );

    // 확인: 중복 호출에도 평점 캐시 갱신 포트는 1회만 호출됨
    assert.equal(getStatsUpdateCount(), 1);
  });

  it("C-07-T06 연락처/이메일 노출 0", async () => {
    // 준비: 전화번호와 이메일이 포함된 원문
    const { service, contract } = createTestSetup();
    const rawComment = "연락처는 010-1234-5678 이고 이메일은 test@example.com 입니다.";

    // 실행: 리뷰 작성
    const review = await service.createReview(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, rating: 5, comment: rawComment, tags: [] },
    );

    // 확인: 연락처·이메일이 남지 않고 마스킹됨
    assert.equal(review.comment?.includes("010-1234-5678"), false);
    assert.equal(review.comment?.includes("test@example.com"), false);
    assert.match(review.comment ?? "", /\[연락처\]/);
  });
});

describe("C-07 재검수: 공개 DTO·조회 권한·태그 검증·동시성", () => {
  function setup(options?: {
    allowedTags?: { CLIENT: readonly string[]; SUPPLIER: readonly string[] };
    withdrawnUserIds?: readonly string[];
  }) {
    const repo = createInMemoryReviewRepository();
    const contract: ReviewContractEntity = {
      id: "contract-c07r",
      clientUserId: "client-c07r",
      supplierUserId: "supplier-c07r",
      status: "COMPLETED",
    };
    repo.seedContract(contract);

    let statsUpdates = 0;
    const service = new ReviewService({
      repo,
      profilePorts: {
        async updateProfileReviewStats() {
          statsUpdates++;
          return { success: true };
        },
      },
      clock: { now: () => new Date("2026-11-25T10:00:00.000Z") },
      allowedTags: options?.allowedTags,
      reviewerProfiles: {
        async getReviewerProfile(userId: string) {
          return {
            displayName: `이름-${userId}`,
            withdrawn: (options?.withdrawnUserIds ?? []).includes(userId),
          };
        },
      },
    });

    return { repo, contract, service, getStatsUpdates: () => statsUpdates };
  }

  it("C-07-F01a 계약 리뷰 목록은 당사자만 조회", async () => {
    // 준비
    const { service, contract } = setup();
    await service.createReview(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, rating: 5, tags: [] },
    );

    // 실행 및 확인: 외부인 조회는 403으로 거부
    await assert.rejects(
      () => service.listContractReviews({ userId: "outsider" }, contract.id),
      (err: unknown) => err instanceof ReviewHttpError && err.status === 403,
    );

    // 확인: 의뢰인·공급자 각각 1건 조회
    const asClient = await service.listContractReviews(
      { userId: contract.clientUserId },
      contract.id,
    );
    assert.equal(asClient.length, 1);
    const asSupplier = await service.listContractReviews(
      { userId: contract.supplierUserId },
      contract.id,
    );
    assert.equal(asSupplier.length, 1);
  });

  it("C-07-F01b 공개 DTO는 식별자를 숨기고 탈퇴 상대는 익명 처리", async () => {
    // 준비: 의뢰인이 탈퇴한 상태
    const { service, contract } = setup({ withdrawnUserIds: ["client-c07r"] });
    await service.createReview(
      { userId: contract.clientUserId, role: "CLIENT" },
      { contractId: contract.id, rating: 5, comment: "좋아요", tags: [] },
    );

    // 확인: 공개 DTO에 식별자가 없고 탈퇴 상대는 익명
    const publicReviews = await service.listSupplierReviews(contract.supplierUserId);
    assert.equal(publicReviews.length, 1);
    const dto = publicReviews[0] as unknown as Record<string, unknown>;
    assert.equal("reviewerId" in dto, false);
    assert.equal("revieweeId" in dto, false);
    assert.equal("contractId" in dto, false);
    assert.equal(dto.rating, 5);
    assert.equal(dto.reviewerDisplayName, "익명");

    // 실행: 탈퇴하지 않은 상대의 리뷰 작성
    const active = setup();
    await active.service.createReview(
      { userId: active.contract.supplierUserId, role: "SUPPLIER" },
      { contractId: active.contract.id, rating: 4, tags: [] },
    );
    // 확인: 활동 중인 상대는 표시 이름 노출
    const [activeDto] = await active.service.listClientReviews(active.contract.clientUserId);
    assert.equal(activeDto.reviewerDisplayName, `이름-${active.contract.supplierUserId}`);
  });

  it("C-07-F01c 태그·본문 형식을 서버에서 검증", async () => {
    // 준비: 허용 태그 목록이 설정된 상태
    const { service, contract } = setup({
      allowedTags: { CLIENT: ["친절해요", "전문적이에요"], SUPPLIER: ["명확해요"] },
    });
    const client = { userId: contract.clientUserId, role: "CLIENT" };

    // 실행 및 확인: 허용되지 않은 태그 거부
    await assert.rejects(
      () =>
        service.createReview(client, {
          contractId: contract.id,
          rating: 5,
          tags: ["허용되지않은태그"],
        }),
      (err: unknown) => err instanceof ReviewHttpError && err.status === 400,
    );
    // 실행 및 확인: 태그 개수 초과 거부
    await assert.rejects(
      () =>
        service.createReview(client, {
          contractId: contract.id,
          rating: 5,
          tags: ["친절해요", "전문적이에요", "친절해요", "전문적이에요", "친절해요", "전문적이에요"],
        }),
      (err: unknown) => err instanceof ReviewHttpError && err.status === 400,
    );
    // 실행 및 확인: 중복 태그 거부
    await assert.rejects(
      () =>
        service.createReview(client, {
          contractId: contract.id,
          rating: 5,
          tags: ["친절해요", "친절해요"],
        }),
      (err: unknown) => err instanceof ReviewHttpError && err.status === 400,
    );

    // 실행: 500자 본문 작성
    const ok = await service.createReview(client, {
      contractId: contract.id,
      rating: 5,
      tags: ["친절해요"],
      comment: "가".repeat(500),
    });
    // 확인: 500자 허용
    assert.equal(ok.comment?.length, 500);

    // 실행 및 확인: 501자 본문은 거부
    const other = setup();
    await assert.rejects(
      () =>
        other.service.createReview(
          { userId: other.contract.clientUserId, role: "CLIENT" },
          { contractId: other.contract.id, rating: 5, tags: [], comment: "가".repeat(501) },
        ),
      (err: unknown) => err instanceof ReviewHttpError && err.status === 400,
    );
  });

  it("C-07-F02 동시 작성에도 리뷰 1건·평점 캐시 1회", async () => {
    // 준비
    const { service, contract, getStatsUpdates } = setup();
    const actor = { userId: contract.clientUserId, role: "CLIENT" };

    // 실행: 같은 작성자가 동시에 두 번 작성
    const results = await Promise.allSettled([
      service.createReview(actor, { contractId: contract.id, rating: 5, tags: [] }),
      service.createReview(actor, { contractId: contract.id, rating: 4, tags: [] }),
    ]);

    // 확인: 1건만 성공하고 1건은 409로 거부, 캐시 갱신은 1회
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ReviewHttpError);
    assert.equal(rejected[0].reason.status, 409);
    assert.equal(getStatsUpdates(), 1);
  });
});
