import { BlockOrigin, DraftStatus, EventType, Prisma, PrismaClient, ProjectStatus, SpecItemStatus } from "@prisma/client";
import { DraftError } from "../draft/rules.js";
import {
  canDeleteProject, canEditSpec, canExtendDeadline, hopeBudgetBand, isWithinExtensionCap, publicProjectDetail, publicProjectSummary, resolveClosingOutcome,
  type PublicProjectDetail, type PublicProjectSummary,
} from "./policy.js";
import type { ProjectPorts, ProjectSearchPort, ProjectSearchQuery } from "./ports.js";

export const PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION = "project-disclosure-v0.1-draft";

export type PublishDraftInput = {
  recruitStartAt?: Date;
  deadline: Date;
  disclosureConsentVersion: string;
  disclosureScope: "FULL" | "DETAIL";
  disclosureConsent: true;
};

export type PublishedProject = {
  projectId: string;
  title: string;
  summary: string;
  currentVersion: 1;
  status: ProjectStatus;
  recruitStartAt: Date;
  deadline: Date;
  itemCount: number;
};

const publishDraftDetails = {
  client: { select: { clientProfile: { select: { businessName: true } } } },
  blocks: {
    where: { status: "ADDED" as const },
    orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
    include: {
      block: {
        select: {
          name: true,
          functionSummary: true,
          description: true,
          industryCode: true,
          techTags: true,
          wireframe: true,
          conditions: true,
        },
      },
    },
  },
} satisfies Prisma.DraftInclude;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConditions(value: Prisma.JsonValue | null): { key: string; text: string }[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new DraftError("SPEC_CONDITIONS_INVALID", 409);
  const conditions: { key: string; text: string }[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.text !== "string") {
      throw new DraftError("SPEC_CONDITIONS_INVALID", 409);
    }
    conditions.push({ key: item.key, text: item.text });
  }
  return conditions;
}

function mergeConditionNotes(
  conditionsValue: Prisma.JsonValue | null,
  notesValue: Prisma.JsonValue | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const conditions = readConditions(conditionsValue);
  const notes = notesValue === null ? [] : Array.isArray(notesValue) ? notesValue : null;
  if (notes === null) throw new DraftError("SPEC_CONDITION_NOTES_INVALID", 409);
  const noteByKey = new Map<string, string>();
  for (const item of notes) {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.note !== "string") {
      throw new DraftError("SPEC_CONDITION_NOTES_INVALID", 409);
    }
    if (item.note.trim()) noteByKey.set(item.key, item.note.trim());
  }
  if ([...noteByKey.keys()].some(key => !conditions.some(condition => condition.key === key))) {
    throw new DraftError("SPEC_CONDITION_NOTE_MISMATCH", 409);
  }
  const copied = conditions.map(condition => {
    const note = noteByKey.get(condition.key);
    return note === undefined ? condition : { ...condition, note };
  });
  return copied.length === 0 ? Prisma.DbNull : copied;
}

function databaseJson(value: Prisma.JsonValue | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : value;
}

function projectTitle(names: string[]): string {
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} 외 ${names.length - 2}개 기능`;
}

export async function publishDraft(
  db: PrismaClient,
  draftId: string,
  clientId: string,
  input: PublishDraftInput,
  activeConsentVersion: string | null,
  now: Date,
): Promise<PublishedProject> {
  if (Number.isNaN(now.getTime())) throw new DraftError("INVALID_TIME", 500);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM drafts WHERE id = ${draftId} FOR UPDATE`;
    const draft = await tx.draft.findFirst({
      where: { id: draftId, clientId, deletedAt: null },
      include: publishDraftDetails,
    });
    if (!draft) throw new DraftError("DRAFT_NOT_FOUND", 404);
    if (draft.status === DraftStatus.CONFIRMED) throw new DraftError("DRAFT_ALREADY_CONFIRMED", 409);
    if (draft.status !== DraftStatus.IN_PROGRESS) throw new DraftError("DRAFT_NOT_IN_PROGRESS", 409);
    if (await tx.project.findUnique({ where: { draftId }, select: { id: true } })) {
      throw new DraftError("DRAFT_ALREADY_CONFIRMED", 409);
    }
    if (Array.isArray(draft.pendingFeatures) && draft.pendingFeatures.length > 0) {
      throw new DraftError("DRAFT_FEATURES_PENDING", 409);
    }
    if (!activeConsentVersion?.trim()) throw new DraftError("DISCLOSURE_CONSENT_UNAVAILABLE", 503);
    if (input.disclosureConsent !== true) throw new DraftError("DISCLOSURE_CONSENT_REQUIRED", 422);
    if (!input.disclosureConsentVersion.trim()) throw new DraftError("DISCLOSURE_CONSENT_REQUIRED", 422);
    if (activeConsentVersion !== PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION || input.disclosureConsentVersion !== activeConsentVersion) {
      throw new DraftError("DISCLOSURE_CONSENT_VERSION_MISMATCH", 409);
    }
    if (input.disclosureScope !== "FULL" && input.disclosureScope !== "DETAIL") throw new DraftError("INVALID_DISCLOSURE_SCOPE", 422);
    if (Number.isNaN(input.deadline.getTime()) || (input.recruitStartAt !== undefined && Number.isNaN(input.recruitStartAt.getTime()))) {
      throw new DraftError("INVALID_RECRUITMENT_PERIOD", 422);
    }

    const recruitStartAt = input.recruitStartAt ?? now;
    if (recruitStartAt.getTime() >= input.deadline.getTime() || input.deadline.getTime() <= now.getTime()) {
      throw new DraftError("INVALID_RECRUITMENT_PERIOD", 422);
    }
    if (draft.blocks.length === 0) throw new DraftError("NO_SELECTED_BLOCKS", 409);

    const title = projectTitle(draft.blocks.map(block => block.block.name));
    const summary = draft.blocks.map(block => block.block.description).join("\n\n");
    const requiredSkills = [...new Set(draft.blocks.flatMap(block => block.block.techTags))];
    const status = recruitStartAt.getTime() > now.getTime() ? ProjectStatus.SCHEDULED : ProjectStatus.RECRUITING;
    const firstBlock = draft.blocks[0];
    if (!firstBlock) throw new DraftError("NO_SELECTED_BLOCKS", 409);
    const project = await tx.project.create({
      data: {
        draftId,
        currentVersion: 1,
        confirmedAt: now,
        disclosureConsentVersion: PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION,
        title,
        summary,
        industryCode: firstBlock.block.industryCode,
        requiredSkills,
        hopeBudget: draft.hopeBudget,
        recruitStartAt,
        deadline: input.deadline,
        status,
        publishedAt: status === ProjectStatus.RECRUITING ? now : null,
      },
    });
    const inserted = await tx.specItem.createMany({
      data: draft.blocks.map(block => ({
        projectId: project.id,
        versionNo: 1,
        blockId: block.blockId,
        title: block.block.name,
        description: block.block.description,
        wireframe: databaseJson(block.block.wireframe),
        conditions: mergeConditionNotes(block.block.conditions, block.conditionNotes),
        origin: block.origin,
        status: SpecItemStatus.INCLUDED,
        unitPrice: block.unitPrice,
        sortOrder: block.sortOrder,
      })),
    });
    if (inserted.count !== draft.blocks.length) throw new DraftError("SPEC_COPY_INCOMPLETE", 500);
    await tx.draft.update({ where: { id: draftId }, data: { status: DraftStatus.CONFIRMED, lastActiveAt: now } });
    await tx.eventLog.create({
      data: {
        userId: clientId,
        projectId: project.id,
        type: EventType.PROJECT_PUBLISHED,
        payload: { disclosureScope: input.disclosureScope, disclosureConsentVersion: PROJECT_DISCLOSURE_CONSENT_DRAFT_VERSION },
      },
    });
    await tx.eventLog.create({
      data: { userId: clientId, projectId: project.id, type: EventType.SPEC_CONFIRMED, occurredAt: now },
    });
    return {
      projectId: project.id,
      title: project.title,
      summary: project.summary,
      currentVersion: 1,
      status: project.status,
      recruitStartAt,
      deadline: input.deadline,
      itemCount: inserted.count,
    };
  });
}

// ── A-06: my projects / public list & detail / spec revision / close ──────────
export type SpecRevisionItem = {
  blockId: string;
  title: string;
  description: string;
  conditions?: unknown;
  wireframe?: unknown;
  sortOrder?: number;
};

export type MyProjectView = {
  projectId: string;
  title: string;
  status: ProjectStatus;
  displayState: string;
  deadline: string | null;
  selectionEndsAt: string | null;
  currentVersion: number;
  applicationCount: number;
  detailViewCount: number;
};

export type MyProjectDetailItem = {
  specItemId: string;
  title: string;
  description: string;
  conditions: unknown;
  wireframe: unknown;
};

export type MyProjectDetail = {
  projectId: string;
  title: string;
  summary: string;
  industryCode: string;
  requiredSkills: string[];
  status: ProjectStatus;
  displayState: string;
  hopeBudget: number | null;
  hopeBudgetBand: string | null;
  recruitStartAt: string | null;
  deadline: string | null;
  selectionEndsAt: string | null;
  currentVersion: number;
  applicationCount: number;
  detailViewCount: number;
  items: MyProjectDetailItem[];
};

export type PublicProjectListPage = { items: PublicProjectSummary[]; total: number };
export type SpecRevisionResult = { projectId: string; currentVersion: number; itemCount: number };
export type DeadlineExtensionResult = { projectId: string; deadline: string; status: ProjectStatus };
export type DeadlineBatchResult = { recruiting: number; selecting: number; expired: number };

const selectionWindowMs = 7 * 24 * 60 * 60 * 1000;

function projectDisplayState(status: ProjectStatus, applicationCount: number): string {
  switch (status) {
    case ProjectStatus.SCHEDULED:
      return "모집 예정";
    case ProjectStatus.RECRUITING:
      return applicationCount > 0 ? "지원 있음" : "모집 중";
    case ProjectStatus.SELECTING:
      return "선택 중";
    case ProjectStatus.EXPIRED:
      return applicationCount > 0 ? "선택 종료" : "지원 0건 · 마감";
    default:
      return "계약 진행 중";
  }
}

function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

async function ownedProject(
  tx: Prisma.TransactionClient,
  projectId: string,
  clientId: string,
): Promise<{ currentVersion: number; status: ProjectStatus; deadline: Date | null }> {
  await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
  const project = await tx.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { currentVersion: true, status: true, deadline: true, draft: { select: { clientId: true } } },
  });
  if (!project || project.draft.clientId !== clientId) throw new DraftError("PROJECT_NOT_FOUND", 404);
  return { currentVersion: project.currentVersion, status: project.status, deadline: project.deadline };
}

export async function listMyProjects(db: PrismaClient, clientId: string): Promise<MyProjectView[]> {
  const projects = await db.project.findMany({
    where: { deletedAt: null, draft: { clientId } },
    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    select: {
      id: true, title: true, status: true, deadline: true, selectionEndsAt: true, currentVersion: true,
      _count: { select: { applications: true } },
    },
  });
  const ids = projects.map(project => project.id);
  const views = ids.length
    ? await db.eventLog.groupBy({ by: ["projectId"], where: { type: EventType.SPEC_DETAIL_VIEWED, projectId: { in: ids } }, _count: { _all: true } })
    : [];
  const viewByProject = new Map(views.map(view => [view.projectId, view._count._all]));
  return projects.map(project => ({
    projectId: project.id,
    title: project.title,
    status: project.status,
    displayState: projectDisplayState(project.status, project._count.applications),
    deadline: project.deadline === null ? null : project.deadline.toISOString(),
    selectionEndsAt: project.selectionEndsAt === null ? null : project.selectionEndsAt.toISOString(),
    currentVersion: project.currentVersion,
    applicationCount: project._count.applications,
    detailViewCount: viewByProject.get(project.id) ?? 0,
  }));
}

/** 의뢰인 본인 프로젝트 상세. 발행 후에도 현재 버전 INCLUDED 명세를 그대로 보여준다. */
export async function getMyProjectDetail(
  db: PrismaClient,
  projectId: string,
  clientId: string,
): Promise<MyProjectDetail> {
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null, draft: { clientId } },
    select: {
      id: true, title: true, summary: true, industryCode: true, requiredSkills: true,
      status: true, hopeBudget: true, recruitStartAt: true, deadline: true, selectionEndsAt: true,
      currentVersion: true, _count: { select: { applications: true } },
    },
  });
  if (!project) throw new DraftError("PROJECT_NOT_FOUND", 404);

  const [items, detailViewCount] = await Promise.all([
    db.specItem.findMany({
      where: { projectId, versionNo: project.currentVersion, status: SpecItemStatus.INCLUDED },
      orderBy: { sortOrder: "asc" },
      select: { id: true, title: true, description: true, conditions: true, wireframe: true },
    }),
    db.eventLog.count({ where: { projectId, type: EventType.SPEC_DETAIL_VIEWED } }),
  ]);

  return {
    projectId: project.id,
    title: project.title,
    summary: project.summary,
    industryCode: project.industryCode,
    requiredSkills: project.requiredSkills,
    status: project.status,
    displayState: projectDisplayState(project.status, project._count.applications),
    hopeBudget: project.hopeBudget,
    hopeBudgetBand: hopeBudgetBand(project.hopeBudget),
    recruitStartAt: project.recruitStartAt?.toISOString() ?? null,
    deadline: project.deadline?.toISOString() ?? null,
    selectionEndsAt: project.selectionEndsAt?.toISOString() ?? null,
    currentVersion: project.currentVersion,
    applicationCount: project._count.applications,
    detailViewCount,
    items: items.map(item => ({
      specItemId: item.id,
      title: item.title,
      description: item.description,
      conditions: item.conditions,
      wireframe: item.wireframe,
    })),
  };
}

export async function listPublicProjects(
  db: PrismaClient,
  search: ProjectSearchPort | undefined,
  query: ProjectSearchQuery,
): Promise<PublicProjectListPage> {
  if (!search) throw new DraftError("PROJECT_SEARCH_UNAVAILABLE", 503);
  const { projectIds, total } = await search.searchPublicProjects(query);
  if (projectIds.length === 0) return { items: [], total };
  const projects = await db.project.findMany({
    where: { id: { in: projectIds }, deletedAt: null, status: { in: [ProjectStatus.RECRUITING, ProjectStatus.SELECTING, ProjectStatus.EXPIRED] } },
    select: {
      id: true, title: true, industryCode: true, requiredSkills: true, status: true, deadline: true, hopeBudget: true, currentVersion: true,
      items: { where: { status: SpecItemStatus.INCLUDED }, select: { versionNo: true } },
    },
  });
  const byId = new Map(projects.map(project => [project.id, project]));
  const items: PublicProjectSummary[] = [];
  for (const id of projectIds) {
    const project = byId.get(id);
    if (!project) continue;
    const itemCount = project.items.filter(item => item.versionNo === project.currentVersion).length;
    items.push(publicProjectSummary(project, itemCount));
  }
  return { items, total };
}

export async function getPublicProjectDetail(
  db: PrismaClient,
  ports: ProjectPorts,
  projectId: string,
  supplierId: string,
  now: Date,
): Promise<PublicProjectDetail> {
  if (!ports.view) throw new DraftError("PROJECT_VIEW_UNAVAILABLE", 503);
  if (!ports.supplierNdaVersion) throw new DraftError("NDA_UNAVAILABLE", 503);
  const supplier = await db.supplierProfile.findUnique({ where: { userId: supplierId }, select: { ndaAgreedAt: true, ndaVersion: true } });
  if (!supplier?.ndaAgreedAt || supplier.ndaVersion !== ports.supplierNdaVersion) throw new DraftError("SUPPLIER_NDA_REQUIRED", 403);

  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null, status: { in: [ProjectStatus.RECRUITING, ProjectStatus.SELECTING, ProjectStatus.EXPIRED] } },
    select: {
      id: true, title: true, industryCode: true, requiredSkills: true, status: true, deadline: true, hopeBudget: true,
      currentVersion: true, summary: true, draft: { select: { clientId: true } },
    },
  });
  if (!project) throw new DraftError("PROJECT_NOT_FOUND", 404);

  const [items, clientProfile] = await Promise.all([
    db.specItem.findMany({
      where: { projectId, versionNo: project.currentVersion, status: SpecItemStatus.INCLUDED },
      orderBy: { sortOrder: "asc" },
      select: { id: true, title: true, description: true, conditions: true, wireframe: true },
    }),
    db.clientProfile.findUnique({
      where: { userId: project.draft.clientId },
      include: { user: { select: { name: true, bio: true } } },
    }),
  ]);
  const client = clientProfile?.profileCompleted && clientProfile.businessName?.trim()
    ? {
      name: clientProfile.user.name,
      businessName: clientProfile.businessName,
      industryField: clientProfile.industryField,
      storeAddress: clientProfile.storeAddress,
      bio: clientProfile.user.bio,
      websiteUrl: clientProfile.websiteUrl,
      ratingAvg: clientProfile.ratingAvg,
      reviewCount: clientProfile.reviewCount,
    }
    : {
      name: null,
      businessName: null,
      industryField: null,
      storeAddress: null,
      bio: null,
      websiteUrl: null,
      ratingAvg: null,
      reviewCount: 0,
    };

  await ports.view.recordFirstView({ projectId, supplierId, at: now });

  return publicProjectDetail(project, {
    summary: project.summary,
    items: items.map(item => ({ specItemId: item.id, title: item.title, description: item.description, conditions: item.conditions, wireframe: item.wireframe })),
    client,
  });
}

export async function softDeleteProject(
  db: PrismaClient,
  ports: ProjectPorts,
  projectId: string,
  clientId: string,
  now: Date,
): Promise<void> {
  if (!ports.application) throw new DraftError("PROJECT_APPLICATION_PORT_UNAVAILABLE", 503);
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
    const project = await tx.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { status: true, draft: { select: { clientId: true } } } });
    if (!project || project.draft.clientId !== clientId) throw new DraftError("PROJECT_NOT_FOUND", 404);
    if (!canDeleteProject(project.status)) throw new DraftError("PROJECT_NOT_DELETABLE", 409);
    await tx.project.update({ where: { id: projectId }, data: { deletedAt: now } });
    await ports.application!.rejectPendingOnDelete(tx, { projectId, at: now });
  });
}

export async function reviseSpec(
  db: PrismaClient,
  ports: ProjectPorts,
  projectId: string,
  clientId: string,
  input: { items: SpecRevisionItem[] },
  now: Date,
): Promise<SpecRevisionResult> {
  if (input.items.length === 0) throw new DraftError("NO_SELECTED_BLOCKS", 409);
  return db.$transaction(async tx => {
    const project = await ownedProject(tx, projectId, clientId);
    if (!canEditSpec(project.status)) throw new DraftError("PROJECT_SPEC_LOCKED", 409);
    const nextVersion = project.currentVersion + 1;
    const priorItems = await tx.specItem.findMany({
      where: { projectId, versionNo: project.currentVersion },
      select: { blockId: true, origin: true, unitPrice: true },
    });
    const priorByBlock = new Map(priorItems.map(item => [item.blockId, item]));
    const missing = input.items.filter(item => !priorByBlock.has(item.blockId)).map(item => item.blockId);
    const catalog = missing.length
      ? await tx.blockCatalog.findMany({ where: { id: { in: missing } }, select: { id: true, unitPrice: true } })
      : [];
    const priceByBlock = new Map(catalog.map(block => [block.id, block.unitPrice]));

    await tx.specItem.createMany({
      data: input.items.map((item, index) => {
        const prior = priorByBlock.get(item.blockId);
        const unitPrice = prior ? prior.unitPrice : priceByBlock.get(item.blockId);
        if (unitPrice === undefined) throw new DraftError("CATALOG_BLOCK_NOT_FOUND", 404);
        return {
          projectId,
          versionNo: nextVersion,
          blockId: item.blockId,
          title: item.title,
          description: item.description,
          wireframe: jsonInput(item.wireframe),
          conditions: jsonInput(item.conditions),
          origin: prior ? prior.origin : BlockOrigin.FIRST_SENTENCE,
          status: SpecItemStatus.INCLUDED,
          unitPrice,
          sortOrder: item.sortOrder ?? index,
        };
      }),
    });
    await tx.project.update({ where: { id: projectId }, data: { currentVersion: nextVersion } });
    if (ports.application) await ports.application.markSpecStale(tx, { projectId, newVersionNo: nextVersion, at: now });
    await tx.eventLog.create({ data: { userId: clientId, projectId, type: EventType.SPEC_REVISED, payload: { versionNo: nextVersion }, occurredAt: now } });
    return { projectId, currentVersion: nextVersion, itemCount: input.items.length };
  });
}

export async function extendDeadline(
  db: PrismaClient,
  projectId: string,
  clientId: string,
  newDeadline: Date,
  now: Date,
): Promise<DeadlineExtensionResult> {
  return db.$transaction(async tx => {
    const project = await ownedProject(tx, projectId, clientId);
    if (!canExtendDeadline(project.status)) throw new DraftError("PROJECT_DEADLINE_NOT_EXTENDABLE", 409);
    if (project.deadline === null) throw new DraftError("PROJECT_DEADLINE_MISSING", 409);
    if (Number.isNaN(newDeadline.getTime()) || !isWithinExtensionCap(project.deadline, newDeadline)) {
      throw new DraftError("INVALID_DEADLINE_EXTENSION", 422);
    }
    await tx.project.update({
      where: { id: projectId },
      data: { deadline: newDeadline, status: ProjectStatus.RECRUITING, selectionEndsAt: null },
    });
    await tx.eventLog.create({ data: { userId: clientId, projectId, type: EventType.DEADLINE_EXTENDED, payload: { deadline: newDeadline.toISOString() }, occurredAt: now } });
    // D-10-R 승인: 알림 15종 불변. 마감 연장은 EventLog에만 남기고 B 알림을 만들지 않는다.
    return { projectId, deadline: newDeadline.toISOString(), status: ProjectStatus.RECRUITING };
  });
}

export async function runProjectDeadlineBatch(
  db: PrismaClient,
  ports: ProjectPorts,
  now: Date,
): Promise<DeadlineBatchResult> {
  return db.$transaction(async tx => {
    const recruiting = await tx.project.updateMany({
      where: { status: ProjectStatus.SCHEDULED, deletedAt: null, recruitStartAt: { lte: now } },
      data: { status: ProjectStatus.RECRUITING, publishedAt: now },
    });

    const closing = await tx.project.findMany({
      where: { status: ProjectStatus.RECRUITING, deletedAt: null, deadline: { lte: now } },
      select: { id: true, draft: { select: { clientId: true } } },
    });
    let selecting = 0;
    let expired = 0;
    for (const project of closing) {
      const pending = ports.application ? await ports.application.countPending(tx, project.id) : 0;
      const isSelecting = resolveClosingOutcome(pending) === "SELECTING";
      const updated = await tx.project.updateMany({
        where: { id: project.id, status: ProjectStatus.RECRUITING },
        data: isSelecting
          ? { status: ProjectStatus.SELECTING, selectionEndsAt: new Date(now.getTime() + selectionWindowMs) }
          : { status: ProjectStatus.EXPIRED },
      });
      if (updated.count !== 1) continue;
      if (isSelecting) selecting += 1;
      else expired += 1;
      if (ports.notification) await ports.notification.enqueue(tx, { userId: project.draft.clientId, type: "PROJECT_CLOSED", projectId: project.id, at: now });
    }

    const closingSelection = await tx.project.findMany({
      where: { status: ProjectStatus.SELECTING, deletedAt: null, selectionEndsAt: { lte: now } },
      select: { id: true },
    });
    for (const project of closingSelection) {
      const updated = await tx.project.updateMany({
        where: { id: project.id, status: ProjectStatus.SELECTING },
        data: { status: ProjectStatus.EXPIRED, selectionEndsAt: null },
      });
      if (updated.count !== 1) continue;
      expired += 1;
      if (ports.application) await ports.application.rejectPendingOnDelete(tx, { projectId: project.id, at: now });
    }

    return { recruiting: recruiting.count, selecting, expired };
  });
}
