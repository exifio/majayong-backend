import { describe, expect, it } from "@jest/globals";
import { calculatePriceEstimate } from "./policy.ts";

describe("A-05-T01 가격 견적", () => {
  it("포함된 스냅샷 가격만 합산하고 의뢰인 수수료를 원 단위로 내림한다", () => {
    // 실행
    const estimate = calculatePriceEstimate([
      { blockId: "b1", name: "달력", status: "ADDED", unitPrice: 1, priceBasis: "작업 1" },
      { blockId: "b2", name: "결제", status: "ADDED", unitPrice: 19, priceBasis: "작업 2" },
      { blockId: "b3", name: "알림", status: "ADDED", unitPrice: 20, priceBasis: "작업 3" },
      { blockId: "b4", name: "삭제된 기능", status: "REMOVED", unitPrice: 500, priceBasis: "제외" },
    ], 2);

    // 확인
    expect(estimate).toEqual({
      subtotal: 40,
      clientFee: 2,
      estimatedTotal: 42,
      pendingFeatureCount: 2,
      items: [
        { blockId: "b1", name: "달력", status: "ADDED", unitPrice: 1, priceBasis: "작업 1", includedInEstimate: true, sharePercent: 2.5 },
        { blockId: "b2", name: "결제", status: "ADDED", unitPrice: 19, priceBasis: "작업 2", includedInEstimate: true, sharePercent: 47.5 },
        { blockId: "b3", name: "알림", status: "ADDED", unitPrice: 20, priceBasis: "작업 3", includedInEstimate: true, sharePercent: 50 },
        { blockId: "b4", name: "삭제된 기능", status: "REMOVED", unitPrice: 500, priceBasis: "제외", includedInEstimate: false, sharePercent: 0 },
      ],
    });
  });

  it("0을 보존하고 1원 수수료 경계를 처리한다", () => {
    // 실행
    const zero = calculatePriceEstimate([
      { blockId: "zero", name: "무료", status: "ADDED", unitPrice: 0, priceBasis: "무료" },
    ], 0);

    // 확인
    expect(zero).toMatchObject({ subtotal: 0, clientFee: 0, estimatedTotal: 0, pendingFeatureCount: 0 });
    expect(zero.items[0]?.sharePercent).toBe(0);

    // 실행 및 확인
    expect(calculatePriceEstimate([
      { blockId: "nineteen", name: "19원", status: "ADDED", unitPrice: 19, priceBasis: "19" },
    ], 0)).toMatchObject({ subtotal: 19, clientFee: 0, estimatedTotal: 19 });
    expect(calculatePriceEstimate([
      { blockId: "twenty", name: "20원", status: "ADDED", unitPrice: 20, priceBasis: "20" },
    ], 0)).toMatchObject({ subtotal: 20, clientFee: 1, estimatedTotal: 21 });
  });

  it("잘못된 스냅샷 금액과 스키마 Int 범위를 벗어난 견적을 거부한다", () => {
    // 실행 및 확인
    expect(() => calculatePriceEstimate([
      { blockId: "negative", name: "잘못된 단가", status: "ADDED", unitPrice: -1, priceBasis: "" },
    ], 0)).toThrow(RangeError);
    expect(() => calculatePriceEstimate([
      { blockId: "overflow", name: "초과 단가", status: "ADDED", unitPrice: 2_147_483_647, priceBasis: "" },
    ], 0)).toThrow(RangeError);
  });
});
