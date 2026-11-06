import { describe, expect, it, jest } from "@jest/globals";
import * as catalog from "./index.ts";

const generatedBlock = {
  name: "예약 시간 선택",
  functionSummary: "고객이 예약 가능한 시간을 선택한다",
  description: "예약 가능 시간대를 보여주고 고객이 하나를 선택한다.",
  techTags: ["예약", "달력"],
  wireframe: { parts: [{ type: "CALENDAR", label: "예약 시간", props: "{}" }] },
  conditions: [
    { key: "timeSlot", text: "예약 시간 간격을 정한다." },
    { key: "capacity", text: "시간대별 예약 인원을 정한다." },
  ],
  unitPrice: 240000,
  priceBasis: "예약 시간 선택 화면과 조회 기능을 구현한다.\n저장 및 가능 시간 검증을 포함한 초기 추정이다.\n운영 정책 검증 전 참고 금액이다.",
};

function response(text: string) {
  return new Response(JSON.stringify({
    status: "completed",
    model: "gpt-5.4-mini-2026-03-17",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 200 } },
  }), { status: 200 });
}

describe("A-03 OpenAI 블록 생성기", () => {
  it("생성기 팩토리를 내보낸다", () => {
    // 확인
    expect(typeof catalog.createOpenAiCatalogBlockGenerator).toBe("function");
  });

  it("엄격한 구조화 출력을 쓰고 파싱된 데이터와 비용을 함께 반환한다", async () => {
    // 준비
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify(generatedBlock)));
    const create = catalog.createOpenAiCatalogBlockGenerator;
    expect(typeof create).toBe("function");
    if (typeof create !== "function") return;
    const generator = create("test-secret-never-print", "gpt-5.4-mini", "1341", fetcher);
    expect(generator).toBeDefined();
    if (!generator) return;

    // 실행
    const result = await generator({ industryCode: "RESTAURANT_RESERVATION", text: "예약 가능한 시간을 선택한다" });
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

    // 확인
    expect(request).toMatchObject({ model: "gpt-5.4-mini", store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(result.content).toMatchObject({ name: "예약 시간 선택", wireframe: { parts: [{ props: {} }] } });
    expect(result.metadata).toEqual({
      model: "gpt-5.4-mini-2026-03-17",
      tokens: { input: 1000, output: 100 },
      costKrw: 2,
      latencyMs: expect.any(Number),
    });
  });

  it("블록의 사용자 표시 문구를 한국어로 생성하도록 요청한다", async () => {
    // 준비
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify(generatedBlock)));
    const create = catalog.createOpenAiCatalogBlockGenerator;
    expect(typeof create).toBe("function");
    if (typeof create !== "function") return;
    const generator = create("test-secret-never-print", "gpt-5.4-mini", "1341", fetcher);
    expect(generator).toBeDefined();
    if (!generator) return;

    // 실행
    await generator({ industryCode: "RESTAURANT_RESERVATION", text: "예약 가능한 시간을 선택한다" });
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

    // 확인
    expect(request).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({ role: "developer", content: expect.stringContaining("in Korean") }),
      ]),
    });
  });

  it("공급자 오류를 거부하면서 응답 원문은 노출하지 않는다", async () => {
    // 준비
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(new Response("private provider error body", { status: 500 }));
    const create = catalog.createOpenAiCatalogBlockGenerator;
    expect(typeof create).toBe("function");
    if (typeof create !== "function") return;
    const generator = create("test-secret-never-print", "gpt-5.4-mini", "1341", fetcher);
    expect(generator).toBeDefined();
    if (!generator) return;

    // 실행 및 확인
    await expect(generator({ industryCode: "RESTAURANT_RESERVATION", text: "예약 시간" })).rejects.toMatchObject({
      code: "CATALOG_GENERATION_FAILED",
      status: 503,
    });
  });
});

describe("A-03 OpenAI 기능 추출기", () => {
  it("추출된 기능 목적과 비용을 반환한다", async () => {
    // 준비
    const extracted = { features: ["예약 달력", "예약금 결제", "노쇼 기록", "예약 알림", "리뷰 요청"] };
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify(extracted)));
    const create = catalog.createOpenAiCatalogFeatureExtractor;
    expect(typeof create).toBe("function");
    if (typeof create !== "function") return;
    const extractor = create("test-secret-never-print", "gpt-5.4-mini", "1341", fetcher);
    expect(extractor).toBeDefined();
    if (!extractor) return;

    // 실행
    const result = await extractor({ industryCode: "RESTAURANT_RESERVATION", text: "예약 서비스가 필요해요" });
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

    // 확인
    expect(request).toMatchObject({ model: "gpt-5.4-mini", store: false, text: { format: { type: "json_schema", name: "catalog_features", strict: true } } });
    expect(result.features).toEqual(extracted.features);
    expect(result.metadata).toEqual({
      model: "gpt-5.4-mini-2026-03-17",
      tokens: { input: 1000, output: 100 },
      costKrw: 2,
      latencyMs: expect.any(Number),
    });
  });

  it("기능 목적을 한국어로 추출하도록 요청한다", async () => {
    // 준비
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({ features: ["예약 알림"] })));
    const extractor = catalog.createOpenAiCatalogFeatureExtractor("test-secret-never-print", "gpt-5.4-mini", "1341", fetcher);
    expect(extractor).toBeDefined();
    if (!extractor) return;

    // 실행
    await extractor({ industryCode: "RESTAURANT_RESERVATION", text: "예약 서비스가 필요해요" });
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

    // 확인
    expect(request).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({ role: "developer", content: expect.stringContaining("in Korean") }),
      ]),
    });
  });

  it("잘못된 JSON에는 파서 오류를 흘리지 않고 빈 무효 결과를 반환한다", async () => {
    // 준비
    const fetcher = jest.fn<typeof fetch>().mockResolvedValue(response("not json"));
    const extractor = catalog.createOpenAiCatalogFeatureExtractor("test-key", "gpt-5.4-mini", "1341", fetcher);
    expect(extractor).toBeDefined();
    if (!extractor) return;

    // 실행 및 확인
    await expect(extractor({ industryCode: "TEST", text: "예약" })).resolves.toMatchObject({ features: [] });
  });
});
