import type { SessionUser } from "./auth";
import { ForbiddenError } from "./errors";

/**
 * Workspace isolation.
 *
 * One client must never see another client's candidates. That guarantee is only
 * as strong as the least careful query, so the decision lives here rather than
 * being re-made at each call site: a query either passes a session through
 * `workspaceScope` or it is not scoped, and that is visible at a glance in
 * review.
 *
 * The platform owner can see across clients, but does so deliberately — through
 * the Clients pages, which pass a workspace explicitly. Their everyday pages
 * (dashboard, candidates, uploads) stay scoped to their own workspace when they
 * have one, so taking on the owner role does not flood an operator's own
 * candidate list with every client's CVs.
 */

/**
 * A Prisma `where` fragment restricting rows to the session's workspace.
 *
 * Returns `{}` for the platform owner, which is the *only* way an unscoped query
 * can happen. Everyone else, including a client's own administrator, is pinned
 * to their workspace.
 *
 * Spread it into a where clause:
 *
 *     where: { ...workspaceScope(session), status: "PROCESSED" }
 */
export type WorkspaceScope = { workspaceId?: string };

export function workspaceScope(session: SessionUser): WorkspaceScope {
  if (session.workspaceId) return { workspaceId: session.workspaceId };
  if (session.role === "OWNER") return {};
  // A non-owner with no workspace cannot be scoped, so it must not be allowed
  // to read anything. Returning {} here would hand it the whole database.
  throw new ForbiddenError("This account is not attached to a client workspace");
}

/**
 * The workspace new rows belong to.
 *
 * Distinct from `workspaceScope` because writing has no "see everything" case:
 * even the owner has to say which client a CV belongs to, so an owner acting
 * without a chosen workspace is a bug rather than a wildcard.
 */
export function workspaceForWrite(session: SessionUser, explicit?: string | null): string {
  const id = explicit ?? session.workspaceId;
  if (!id) throw new ForbiddenError("No client workspace selected for this action");
  return id;
}

/**
 * Assert that a row the caller already loaded belongs to them.
 *
 * For the id-addressed routes — open this candidate, reprocess that CV — where
 * the lookup is by primary key and a scoped `where` is easy to forget. Guessing
 * another client's cuid is unlikely, but "unlikely" is not an access control.
 */
export function assertSameWorkspace(session: SessionUser, row: { workspaceId: string | null } | null): void {
  if (!row) return; // absent rows are a 404 decided by the caller, not a leak
  if (session.role === "OWNER" && !session.workspaceId) return;
  if (row.workspaceId !== session.workspaceId) {
    // Deliberately the same error a missing row produces, so probing ids cannot
    // be used to learn whether another client holds a given record.
    throw new ForbiddenError("Not found in this workspace");
  }
}

/**
 * The workspace that adopted everything created before workspaces existed.
 *
 * Used by the seed script, the benchmark harness and the tests — places that
 * create CVs without a signed-in session. Application code should never reach
 * for this: it takes the workspace from the session instead, which is what makes
 * the isolation real.
 */
export const DEFAULT_WORKSPACE_SLUG = "default";

export async function defaultWorkspaceId(): Promise<string> {
  const { prisma } = await import("./db");
  const ws = await prisma.workspace.upsert({
    where: { slug: DEFAULT_WORKSPACE_SLUG },
    create: { name: "Default", slug: DEFAULT_WORKSPACE_SLUG },
    update: {},
    select: { id: true },
  });
  return ws.id;
}
