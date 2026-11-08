import { PrismaClient, ProjectStatus, Role } from "@prisma/client";
import type { Request, RequestHandler, Response, Router } from "express";
import { errorResponse } from "../../core/observability.js";
import type { Actor } from "../identity/session.js";
import type { AuthenticatedDraftRoute } from "../draft/api.js";
import { DraftError } from "../draft/rules.js";
import type { ProjectPorts, ProjectSearchQuery } from "./ports.js";
import {
  extendDeadline, getMyProjectDetail, getPublicProjectDetail, listMyProjects, listPublicProjects, publishDraft, reviseSpec, softDeleteProject,
  type PublishDraftInput, type SpecRevisionItem,
} from "./service.js";

export type { ProjectPorts } from "./ports.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function body(req: Request): Record<string, unknown> {
  const value: unknown = req.body;
  if (!isRecord(value)) throw new DraftError("INVALID_REQUEST", 400);
  const allowed = ["recruitStartAt", "deadline", "disclosureConsentVersion", "disclosureScope", "disclosureConsent"];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new DraftError("INVALID_REQUEST", 400);
  return value;
}

function requiredDate(input: Record<string, unknown>, field: string): Date {
  const value = input[field];
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new DraftError("INVALID_REQUEST", 400);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new DraftError("INVALID_REQUEST", 400);
  return parsed;
}

function pathId(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 100) throw new DraftError("INVALID_REQUEST", 400);
  return value;
}

function parseInput(input: Record<string, unknown>): PublishDraftInput {
  if (typeof input.disclosureConsentVersion !== "string" || !input.disclosureConsentVersion.trim()) {
    throw new DraftError("DISCLOSURE_CONSENT_REQUIRED", 422);
  }
  if (input.disclosureConsent !== true) throw new DraftError("DISCLOSURE_CONSENT_REQUIRED", 422);
  if (input.disclosureScope !== "FULL" && input.disclosureScope !== "DETAIL") throw new DraftError("INVALID_REQUEST", 400);
  return {
    recruitStartAt: input.recruitStartAt === undefined ? undefined : requiredDate(input, "recruitStartAt"),
    deadline: requiredDate(input, "deadline"),
    disclosureConsentVersion: input.disclosureConsentVersion,
    disclosureScope: input.disclosureScope,
    disclosureConsent: true,
  };
}

function roleRoute(
  role: Role,
  handler: (req: Request, res: Response, actor: Actor) => Promise<void>,
): (req: Request, res: Response, actor: Actor) => Promise<void> {
  return async (req, res, actor) => {
    try {
      if (actor.role !== role) throw new DraftError("ROLE_MISMATCH", 403);
      await handler(req, res, actor);
    } catch (error) {
      if (!(error instanceof DraftError)) throw error;
      const message = error.status >= 500 ? "요청을 처리할 수 없습니다." : "요청을 확인해 주세요.";
      res.status(error.status).json(errorResponse(error.code, message, String(res.locals.requestId ?? "")));
    }
  };
}

function queryString(value: unknown, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new DraftError("INVALID_REQUEST", 400);
  return value;
}

function queryInt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new DraftError("INVALID_REQUEST", 400);
  return Number(value);
}

function queryDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw new DraftError("INVALID_REQUEST", 400);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new DraftError("INVALID_REQUEST", 400);
  return parsed;
}

function parseSort(value: unknown): ProjectSearchQuery["sort"] {
  if (value === undefined) return undefined;
  if (value === "LATEST" || value === "DEADLINE_SOON" || value === "BUDGET_HIGH") return value;
  throw new DraftError("INVALID_REQUEST", 400);
}

function parseSearchQuery(query: Request["query"]): ProjectSearchQuery {
  const filters: ProjectSearchQuery["filters"] = {};
  const industryCode = queryString(query.industryCode);
  if (industryCode !== undefined) filters.industryCode = industryCode;
  const skill = queryString(query.skill);
  if (skill !== undefined) filters.skill = skill;
  const keyword = queryString(query.keyword);
  if (keyword !== undefined) filters.keyword = keyword;
  const deadlineBefore = queryDate(query.deadlineBefore);
  if (deadlineBefore !== undefined) filters.deadlineBefore = deadlineBefore;
  const status = queryString(query.status);
  if (status !== undefined) {
    const allowed = Object.values(ProjectStatus) as string[];
    if (!allowed.includes(status)) throw new DraftError("INVALID_REQUEST", 400);
    filters.status = status as ProjectStatus;
  }
  const minBudget = queryInt(query.minBudget);
  if (minBudget !== undefined) filters.minBudget = minBudget;
  const maxBudget = queryInt(query.maxBudget);
  if (maxBudget !== undefined) filters.maxBudget = maxBudget;
  const sort = parseSort(query.sort);
  const page = queryInt(query.page) ?? 1;
  if (page < 1 || page > 10_000) throw new DraftError("INVALID_REQUEST", 400);
  return { filters, ...(sort === undefined ? {} : { sort }), page, pageSize: 10 };
}

function specRevisionBody(req: Request): SpecRevisionItem[] {
  const value: unknown = req.body;
  if (!isRecord(value) || Object.keys(value).some(key => key !== "items")) throw new DraftError("INVALID_REQUEST", 400);
  const items = value.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw new DraftError("INVALID_REQUEST", 400);
  const allowed = ["blockId", "title", "description", "conditions", "wireframe", "sortOrder"];
  return items.map((item: unknown) => {
    if (!isRecord(item) || Object.keys(item).some(key => !allowed.includes(key))) throw new DraftError("INVALID_REQUEST", 400);
    const blockId = item.blockId;
    const title = item.title;
    const description = item.description;
    if (typeof blockId !== "string" || !blockId || blockId.length > 100) throw new DraftError("INVALID_REQUEST", 400);
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new DraftError("INVALID_REQUEST", 400);
    if (typeof description !== "string" || !description.trim() || description.length > 5000) throw new DraftError("INVALID_REQUEST", 400);
    const result: SpecRevisionItem = { blockId, title, description };
    if (item.conditions !== undefined) {
      if (!Array.isArray(item.conditions)) throw new DraftError("INVALID_REQUEST", 400);
      result.conditions = item.conditions;
    }
    if (item.wireframe !== undefined) {
      if (!isRecord(item.wireframe)) throw new DraftError("INVALID_REQUEST", 400);
      result.wireframe = item.wireframe;
    }
    if (item.sortOrder !== undefined) {
      if (typeof item.sortOrder !== "number" || !Number.isSafeInteger(item.sortOrder)) throw new DraftError("INVALID_REQUEST", 400);
      result.sortOrder = item.sortOrder;
    }
    return result;
  });
}

export function mountProjectApi(
  router: Router,
  db: PrismaClient,
  now: () => Date,
  activeConsentVersion: () => string | null,
  authenticated: AuthenticatedDraftRoute,
  ports: ProjectPorts = {},
): void {
  router.post("/drafts/:draftId/publish", authenticated(async (req, res, actor) => {
    try {
      if (actor.role !== Role.CLIENT) throw new DraftError("ROLE_MISMATCH", 403);
      const draftId = req.params.draftId;
      if (typeof draftId !== "string" || draftId.length === 0 || draftId.length > 100) throw new DraftError("INVALID_REQUEST", 400);
      const project = await publishDraft(db, draftId, actor.userId, parseInput(body(req)), activeConsentVersion(), now());
      res.status(201).json({ data: project });
    } catch (error) {
      if (!(error instanceof DraftError)) throw error;
      res.status(error.status).json(errorResponse(error.code, "요청을 확인해 주세요.", String(res.locals.requestId ?? "")));
    }
  }));

  router.get("/me/projects", authenticated(roleRoute(Role.CLIENT, async (_req, res, actor) => {
    res.json({ data: await listMyProjects(db, actor.userId) });
  })));

  router.get("/me/projects/:projectId", authenticated(roleRoute(Role.CLIENT, async (req, res, actor) => {
    res.json({ data: await getMyProjectDetail(db, pathId(req, "projectId"), actor.userId) });
  })));

  router.get("/projects", authenticated(roleRoute(Role.SUPPLIER, async (req, res, _actor) => {
    const query = parseSearchQuery(req.query);
    const page = await listPublicProjects(db, ports.search, query);
    res.json({ data: page.items, meta: { page: query.page, pageSize: query.pageSize, total: page.total } });
  })));

  router.get("/projects/:projectId", authenticated(roleRoute(Role.SUPPLIER, async (req, res, actor) => {
    res.json({ data: await getPublicProjectDetail(db, ports, pathId(req, "projectId"), actor.userId, now()) });
  })));

  router.delete("/projects/:projectId", authenticated(roleRoute(Role.CLIENT, async (req, res, actor) => {
    await softDeleteProject(db, ports, pathId(req, "projectId"), actor.userId, now());
    res.json({ data: { deleted: true } });
  })));

  router.patch("/projects/:projectId/spec", authenticated(roleRoute(Role.CLIENT, async (req, res, actor) => {
    const items = specRevisionBody(req);
    res.json({ data: await reviseSpec(db, ports, pathId(req, "projectId"), actor.userId, { items }, now()) });
  })));

  router.post("/projects/:projectId/extend-deadline", authenticated(roleRoute(Role.CLIENT, async (req, res, actor) => {
    const deadline = requiredDate(body(req), "deadline");
    res.json({ data: await extendDeadline(db, pathId(req, "projectId"), actor.userId, deadline, now()) });
  })));
}
