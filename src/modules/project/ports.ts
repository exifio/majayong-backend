import { Prisma, ProjectStatus, type PrismaClient } from "@prisma/client";
import { DraftError } from "../draft/rules.js";
import type { ProjectSpecVersion } from "../market/public-project.js";
import type { ProjectSort } from "../market/project-search.js";

export type ProjectTx = Prisma.TransactionClient;

const selectionWindowMs = 7 * 24 * 60 * 60 * 1000;

// ── Input ports (B/C provide, A calls) — Gate 0 must freeze these ──────────────
export type ProjectSearchQuery = {
  filters: {
    industryCode?: string;
    skill?: string;
    status?: ProjectStatus;
    minBudget?: number;
    maxBudget?: number;
    deadlineBefore?: Date;
    keyword?: string;
  };
  sort?: ProjectSort;
  page: number;
  pageSize: 10;
};

export interface ProjectSearchPort {
  searchPublicProjects(query: ProjectSearchQuery): Promise<{ projectIds: string[]; total: number }>;
}

export interface ProjectViewPort {
  recordFirstView(input: { projectId: string; supplierId: string; at: Date }): Promise<void>;
}

export interface ProjectApplicationPort {
  countPending(tx: ProjectTx, projectId: string): Promise<number>;
  markSpecStale(tx: ProjectTx, input: { projectId: string; newVersionNo: number; at: Date }): Promise<number>;
  rejectPendingOnDelete(tx: ProjectTx, input: { projectId: string; at: Date }): Promise<number>;
}

export interface ProjectNotificationPort {
  enqueue(tx: ProjectTx, input: { userId: string; type: "PROJECT_CLOSED"; projectId: string; at: Date }): Promise<void>;
}

export type ProjectPorts = {
  supplierNdaVersion?: string;
  search?: ProjectSearchPort;
  view?: ProjectViewPort;
  application?: ProjectApplicationPort;
  notification?: ProjectNotificationPort;
};

// ── Output ports (A provides, B/C call) ──────────────────────────────────────
export interface TransitionProjectInput {
  projectId: string;
  to: ProjectStatus;
  at: Date;
  reason?: string;
}

export interface ProjectOutputPorts {
  transitionProject(tx: ProjectTx, input: TransitionProjectInput): Promise<void>;
  readSpecVersion(projectId: string): Promise<ProjectSpecVersion | null>;
}

const allowedTransitions: Partial<Record<ProjectStatus, ProjectStatus[]>> = {
  [ProjectStatus.RECRUITING]: [ProjectStatus.ACCEPTED],
  [ProjectStatus.SELECTING]: [ProjectStatus.ACCEPTED],
  [ProjectStatus.ACCEPTED]: [ProjectStatus.CONTRACTED, ProjectStatus.RECRUITING, ProjectStatus.SELECTING, ProjectStatus.EXPIRED],
  [ProjectStatus.CONTRACTED]: [ProjectStatus.RECRUITING, ProjectStatus.SELECTING, ProjectStatus.EXPIRED],
};

export function createProjectOutputPorts(db: PrismaClient): ProjectOutputPorts {
  return {
    async transitionProject(tx, input) {
      const project = await tx.project.findUnique({ where: { id: input.projectId }, select: { status: true } });
      if (!project) throw new DraftError("PROJECT_NOT_FOUND", 404);
      const allowed = allowedTransitions[project.status] ?? [];
      if (!allowed.includes(input.to)) throw new DraftError("INVALID_PROJECT_TRANSITION", 409);
      const updated = await tx.project.updateMany({
        where: { id: input.projectId, status: project.status },
        data: {
          status: input.to,
          selectionEndsAt: input.to === ProjectStatus.SELECTING ? new Date(input.at.getTime() + selectionWindowMs) : null,
        },
      });
      if (updated.count !== 1) throw new DraftError("INVALID_PROJECT_TRANSITION", 409);
    },
    async readSpecVersion(projectId) {
      const project = await db.project.findUnique({ where: { id: projectId }, select: { currentVersion: true, status: true } });
      if (project === null) return null;
      const items = await db.specItem.findMany({
        where: { projectId, versionNo: project.currentVersion, status: "INCLUDED" },
        select: { id: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      return { ...project, specItemIds: items.map((item) => item.id) };
    },
  };
}
