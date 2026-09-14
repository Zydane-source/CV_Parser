import { prisma } from "@/lib/db";
import type { WorkspaceScope } from "@/lib/tenant";

/**
 * Workspaces for tests.
 *
 * Application code takes its workspace from the session; tests have no session,
 * so they say which client they are acting as explicitly. Keeping that in one
 * helper means a test reads as "this client's view" rather than as a bag of ids.
 */

/** A fresh, isolated client. Use two of these to prove one cannot see the other. */
export async function makeWorkspace(label: string): Promise<{ id: string; scope: WorkspaceScope }> {
  const slug = `test-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const ws = await prisma.workspace.create({ data: { name: `Test ${label}`, slug }, select: { id: true } });
  return { id: ws.id, scope: { workspaceId: ws.id } };
}

/** Delete a test workspace and everything in it (CVs, candidates, jobs cascade). */
export async function dropWorkspace(id: string): Promise<void> {
  await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
}

/**
 * The scope a platform owner has: none.
 *
 * Spelled out rather than written as a bare `{}` at each call site, so a test
 * that deliberately reads across clients is distinguishable from one that forgot
 * to pass a scope.
 */
export const OWNER_SCOPE: WorkspaceScope = {};
