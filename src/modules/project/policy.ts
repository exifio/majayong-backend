import { ProjectStatus } from "@prisma/client";

export type PublicProjectRow = {
  id: string;
  title: string;
  industryCode: string;
  requiredSkills: string[];
  status: ProjectStatus;
  deadline: Date | null;
  hopeBudget: number | null;
};

export type PublicProjectSummary = {
  projectId: string;
  title: string;
  industryCode: string;
  requiredSkills: string[];
  status: ProjectStatus;
  deadline: string | null;
  itemCount: number;
  hopeBudgetBand: string | null;
};

export type PublicSpecItem = {
  /** 현재 버전 INCLUDED 항목의 실제 SpecItem.id. B 지원 제출이 이 값을 요구한다. */
  specItemId: string;
  title: string;
  description: string;
  conditions: unknown;
  wireframe: unknown;
};

export type PublicClientCard = {
  name: string | null;
  businessName: string | null;
  industryField: string | null;
  storeAddress: string | null;
  bio: string | null;
  websiteUrl: string | null;
  ratingAvg: number | null;
  reviewCount: number;
};

export type PublicProjectDetail = PublicProjectSummary & {
  summary: string;
  hopeBudget: number | null;
  items: PublicSpecItem[];
  client: PublicClientCard;
};

const editableStatuses: ProjectStatus[] = [
  ProjectStatus.SCHEDULED,
  ProjectStatus.RECRUITING,
  ProjectStatus.SELECTING,
  ProjectStatus.EXPIRED,
];
const extendableStatuses: ProjectStatus[] = [
  ProjectStatus.RECRUITING,
  ProjectStatus.SELECTING,
  ProjectStatus.EXPIRED,
];
const oneDayMs = 24 * 60 * 60 * 1000;
export const EXTENSION_CAP_MS = 14 * oneDayMs;

export function canEditSpec(status: ProjectStatus): boolean {
  return editableStatuses.includes(status);
}

export function canDeleteProject(status: ProjectStatus): boolean {
  return editableStatuses.includes(status);
}

export function canExtendDeadline(status: ProjectStatus): boolean {
  return extendableStatuses.includes(status);
}

export function resolveClosingOutcome(pendingCount: number): "SELECTING" | "EXPIRED" {
  return pendingCount > 0 ? "SELECTING" : "EXPIRED";
}

export function isWithinExtensionCap(from: Date, to: Date): boolean {
  const delta = to.getTime() - from.getTime();
  return delta > 0 && delta <= EXTENSION_CAP_MS;
}

export type HopeBudgetBand = {
  readonly below: number;
  readonly label: string;
  readonly minKrw: number;
  readonly maxKrw: number;
};

/** 공개 희망 예산 구간. 전체 공개 카드(라벨)와 검색 필터(숫자)가 같은 경계를 쓰도록 단일 원천으로 둔다. */
export const HOPE_BUDGET_BANDS: readonly HopeBudgetBand[] = [
  { below: 1_000_000, label: "100만원 미만", minKrw: 0, maxKrw: 999_999 },
  { below: 2_000_000, label: "100~200만원", minKrw: 1_000_000, maxKrw: 1_999_999 },
  { below: 3_000_000, label: "200~300만원", minKrw: 2_000_000, maxKrw: 2_999_999 },
  { below: 4_000_000, label: "300~400만원", minKrw: 3_000_000, maxKrw: 3_999_999 },
  { below: 5_000_000, label: "400~500만원", minKrw: 4_000_000, maxKrw: 4_999_999 },
];

const HOPE_BUDGET_TOP: HopeBudgetBand = {
  below: Number.POSITIVE_INFINITY,
  label: "500만원 이상",
  minKrw: 5_000_000,
  maxKrw: Number.MAX_SAFE_INTEGER,
};

function hopeBudgetEntry(hopeBudget: number): HopeBudgetBand {
  return HOPE_BUDGET_BANDS.find((band) => hopeBudget < band.below) ?? HOPE_BUDGET_TOP;
}

export function hopeBudgetBand(hopeBudget: number | null): string | null {
  return hopeBudget === null ? null : hopeBudgetEntry(hopeBudget).label;
}

/** 검색 필터용 숫자 구간. 정확 예산은 노출하지 않고 구간 경계만 넘긴다. */
export function hopeBudgetRange(hopeBudget: number | null): { minKrw: number; maxKrw: number } | null {
  if (hopeBudget === null) return null;
  const entry = hopeBudgetEntry(hopeBudget);
  return { minKrw: entry.minKrw, maxKrw: entry.maxKrw };
}

export function publicProjectSummary(row: PublicProjectRow, itemCount: number): PublicProjectSummary {
  return {
    projectId: row.id,
    title: row.title,
    industryCode: row.industryCode,
    requiredSkills: row.requiredSkills,
    status: row.status,
    deadline: row.deadline === null ? null : row.deadline.toISOString(),
    itemCount,
    hopeBudgetBand: hopeBudgetBand(row.hopeBudget),
  };
}

export function publicProjectDetail(row: PublicProjectRow, detail: {
  summary: string;
  items: PublicSpecItem[];
  client: PublicClientCard;
}): PublicProjectDetail {
  return {
    ...publicProjectSummary(row, detail.items.length),
    summary: detail.summary,
    hopeBudget: row.hopeBudget,
    items: detail.items,
    client: detail.client,
  };
}
