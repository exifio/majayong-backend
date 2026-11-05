import { BlockSource } from "@prisma/client";
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  reservationRestaurantIndustryCode,
  reservationRestaurantSeedBlocks,
} from "./seed.ts";

describe("A-03 제안 레스토랑 예약 시드", () => {
  it("순위가 있는 활성 검수 블록 36개, 기본 6개, 검증된 카탈로그 형태를 가진다", () => {
    // 준비
    const codes = reservationRestaurantSeedBlocks.map(block => block.code);
    const ranks = reservationRestaurantSeedBlocks.map(block => block.recommendRank);

    // 확인
    expect(reservationRestaurantSeedBlocks).toHaveLength(36);
    expect(new Set(codes).size).toBe(36);
    expect(new Set(ranks).size).toBe(36);
    expect(reservationRestaurantSeedBlocks.filter(block => block.inDefaultDraft)).toHaveLength(6);
    expect(reservationRestaurantSeedBlocks.every(block => block.source === BlockSource.TEAM && block.isActive && block.reviewedAt instanceof Date)).toBe(true);

    // 실행
    const types = new Set<string>();
    for (const block of reservationRestaurantSeedBlocks) {
      expect(block.unitPrice).toEqual(expect.any(Number));
      expect(Number.isSafeInteger(block.unitPrice)).toBe(true);
      expect(Array.isArray(block.conditions) && block.conditions).toHaveLength(2);
      expect(block.priceBasis.split("\n")).toHaveLength(3);
      const wireframe = block.wireframe as { parts?: Array<{ type: string }> };
      for (const part of wireframe.parts ?? []) types.add(part.type);
    }

    // 확인
    expect([...types].sort()).toEqual(["BUTTON", "CALENDAR", "FORM", "LIST", "PREVIEW", "TEXT"]);
  });

  it("시드 업종 코드에 안정적인 표시 라벨이 있다", () => {
    // 준비
    const contract = JSON.parse(
      readFileSync(new URL("../../../openapi/industry-labels.json", import.meta.url), "utf8"),
    ) as { labels: Record<string, string>; fallbackLabel: string };

    // 확인
    expect(contract.labels[reservationRestaurantIndustryCode]).toBe("예약기반음식점");
    expect(contract.fallbackLabel.length).toBeGreaterThan(0);
  });
});
