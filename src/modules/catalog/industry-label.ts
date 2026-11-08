/** 업종 코드 → 화면 표시 라벨. 코드는 API의 industryCode 값을 바꾸지 않는다. */
export const INDUSTRY_LABELS: Readonly<Record<string, string>> = {
  FOOD: "음식점",
  RESTAURANT_RESERVATION: "예약기반음식점",
  CAFE: "카페",
  BEAUTY: "뷰티",
  RETAIL: "소매",
  SERVICE: "서비스",
};

export const INDUSTRY_FALLBACK_LABEL = "기타";

export function industryLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code.trim() === "") return INDUSTRY_FALLBACK_LABEL;
  return INDUSTRY_LABELS[code] ?? INDUSTRY_FALLBACK_LABEL;
}
