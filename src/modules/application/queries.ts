/**
 * B-08: 읽기 전용 내 지원 목록·상세 조회 서비스.
 *
 * HTTP/DTO는 Gate 0 동결 전이므로 저장 record/revision을 그대로 노출한다.
 * 표시 상태(ON_HOLD)는 예치 상태가 C에 있어 목록 서비스에서 파생하지 않는다.
 */
import {
  ApplicationAccessError,
  requireApplicationParty,
  type Actor,
  type ApplicationRecord,
} from './dto.js';
import type { ApplicationRevision } from './submission.js';
import {
  attachSupplierProfileSummaries,
  compareApplicationCards,
  type ApplicationCard,
  type SupplierProfileSummary,
  type SupplierApplicationCard,
} from './submission.js';

export interface ApplicationReadPort {
  listForUser(input: {
    readonly userId: string;
    readonly role: 'CLIENT' | 'SUPPLIER';
  }): Promise<readonly ApplicationRecord[]>;
  findRevision(applicationId: string): Promise<ApplicationRevision | null>;
  listRevisions?(applicationId: string): Promise<readonly ApplicationRevision[]>;
}

function isMine(application: ApplicationRecord, actor: Actor): boolean {
  return actor.role === 'CLIENT'
    ? application.clientUserId === actor.userId
    : application.supplierId === actor.userId;
}

/** `GET /me/applications`: 내가 의뢰한/지원한 지원을 최신 제출 순으로. */
export async function listMyApplications(
  port: ApplicationReadPort,
  input: { readonly actor: Actor },
): Promise<readonly ApplicationRecord[]> {
  if (input.actor.role === 'ADMIN') return [];

  const rows = await port.listForUser({
    userId: input.actor.userId,
    role: input.actor.role,
  });
  return rows
    .filter((application) => isMine(application, input.actor))
    .sort(
      (a, b) =>
        b.submittedAt.getTime() - a.submittedAt.getTime() || a.id.localeCompare(b.id),
    );
}

/** `GET /applications/{id}`: 당사자만 최신 회차 전체를 본다. */
export async function getApplicationDetail(
  port: ApplicationReadPort,
  input: { readonly actor: Actor; readonly applicationId: string },
): Promise<ApplicationRevision> {
  const revision = await port.findRevision(input.applicationId);
  if (revision === null) throw new ApplicationAccessError();
  requireApplicationParty(input.actor, {
    clientUserId: revision.clientUserId,
    supplierUserId: revision.supplierId,
  });
  return revision;
}

/** `GET /applications/{id}/revisions`: 같은 공급자의 제안 회차를 오래된 순으로. */
export async function listApplicationRevisions(
  port: ApplicationReadPort,
  input: { readonly actor: Actor; readonly applicationId: string },
): Promise<readonly ApplicationRevision[]> {
  if (port.listRevisions === undefined) throw new ApplicationAccessError();
  const current = await port.findRevision(input.applicationId);
  if (current === null) throw new ApplicationAccessError();
  requireApplicationParty(input.actor, {
    clientUserId: current.clientUserId,
    supplierUserId: current.supplierId,
  });
  const rows = await port.listRevisions(input.applicationId);
  return [...rows].sort((a, b) => a.revisionNo - b.revisionNo || a.id.localeCompare(b.id));
}

export interface ProjectApplicationsPort {
  findProjectClientId(projectId: string): Promise<string | null>;
  listRevisionsByProject(projectId: string): Promise<readonly ApplicationRevision[]>;
  listSupplierProfileSummaries(supplierIds: readonly string[]): Promise<readonly SupplierProfileSummary[]>;
}

/**
 * `GET /projects/{id}/applications`: 의뢰인 본인만. 공급자별 최신 회차 카드만
 * 지원 순서대로 돌려주고 최저가·추천 같은 판정 값은 만들지 않는다.
 */
export async function listProjectApplicationCards(
  port: ProjectApplicationsPort,
  input: { readonly actor: Actor; readonly projectId: string },
): Promise<readonly SupplierApplicationCard[]> {
  const clientUserId = await port.findProjectClientId(input.projectId);
  if (
    clientUserId === null ||
    input.actor.role !== 'CLIENT' ||
    input.actor.userId !== clientUserId
  ) {
    throw new ApplicationAccessError();
  }

  const revisions = await port.listRevisionsByProject(input.projectId);
  const cards = compareApplicationCards(
    revisions.filter((revision) => revision.projectId === input.projectId && revision.clientUserId === clientUserId),
  );
  const profiles = await port.listSupplierProfileSummaries([...new Set(cards.map((card) => card.supplierId))]);
  return attachSupplierProfileSummaries(cards, profiles);
}
