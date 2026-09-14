import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword, type SessionUser } from "@/lib/auth";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Client workspaces and the people in them.
 *
 * Two audiences with deliberately different reach:
 *   - the platform owner creates clients and their first administrator;
 *   - a client's own administrator manages people inside their workspace only.
 *
 * Nothing here takes a workspace id from the request body for a non-owner. The
 * workspace always comes from the session, so "create a user" cannot be aimed at
 * someone else's client by editing the payload.
 */

/** URL-safe handle derived from the client's name, e.g. "Apex Ventures" → "apex-ventures". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** Optional: derived from the name when omitted. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, numbers and hyphens")
    .min(2)
    .max(48)
    .optional(),
  /**
   * The client's first administrator. Created together with the workspace: a
   * client nobody can sign in to is a half-finished state that someone has to
   * remember to come back and fix.
   */
  admin: z.object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().toLowerCase().min(3).max(160),
    password: z.string().min(10).max(200),
  }),
});

export const updateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const createUserSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().min(3).max(160),
  password: z.string().min(10).max(200),
  role: z.enum(["ADMIN", "RECRUITER"]).default("RECRUITER"),
});

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    role: z.enum(["ADMIN", "RECRUITER"]).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(10).max(200).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

const workspaceSelect = {
  id: true,
  name: true,
  slug: true,
  isActive: true,
  createdAt: true,
  _count: { select: { users: true, cvFiles: true } },
} satisfies Prisma.WorkspaceSelect;

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

/** Every client, with how many people and CVs each holds. Owner only. */
export async function listWorkspaces() {
  return prisma.workspace.findMany({ select: workspaceSelect, orderBy: { name: "asc" } });
}

/**
 * Create a client and its first administrator in one transaction.
 *
 * Both or neither: a workspace whose admin failed to be created cannot be signed
 * into and cannot be finished from the UI, and a user row pointing at a
 * workspace that was rolled back is worse still.
 */
export async function createWorkspace(input: z.infer<typeof createWorkspaceSchema>) {
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw new ValidationError("Could not derive a handle from that name — enter one explicitly");

  const [slugTaken, emailTaken] = await Promise.all([
    prisma.workspace.findUnique({ where: { slug }, select: { id: true } }),
    prisma.user.findUnique({ where: { email: input.admin.email }, select: { id: true } }),
  ]);
  // Checked up front so the message names the actual clash. The unique indexes
  // still stand behind this for the concurrent case.
  if (slugTaken) throw new ConflictError(`The handle "${slug}" is already in use by another client`);
  if (emailTaken) throw new ConflictError(`${input.admin.email} already has an account`);

  const passwordHash = await hashPassword(input.admin.password);
  const created = await prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({ data: { name: input.name, slug } });
    const admin = await tx.user.create({
      data: {
        workspaceId: ws.id,
        name: input.admin.name,
        email: input.admin.email,
        passwordHash,
        role: "ADMIN",
      },
      select: userSelect,
    });
    return { ws, admin };
  });

  logger.info({ workspaceId: created.ws.id, slug }, "Client workspace created");
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: created.ws.id }, select: workspaceSelect });
  return { workspace, admin: created.admin };
}

export async function updateWorkspace(id: string, patch: z.infer<typeof updateWorkspaceSchema>) {
  const existing = await prisma.workspace.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new NotFoundError("Client not found");
  // Deactivating keeps every CV and every account; it only stops sign-in, so a
  // client can be suspended and restored without losing their history.
  return prisma.workspace.update({ where: { id }, data: patch, select: workspaceSelect });
}

/**
 * The people in a workspace.
 *
 * `workspaceId` is resolved by the caller from the session (or, for the owner,
 * from an explicit choice) rather than read from a query string here, so this
 * function has no way to be pointed at the wrong client.
 */
export async function listUsers(workspaceId: string) {
  return prisma.user.findMany({ where: { workspaceId }, select: userSelect, orderBy: [{ role: "asc" }, { name: "asc" }] });
}

export async function createUser(workspaceId: string, input: z.infer<typeof createUserSchema>) {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!ws) throw new NotFoundError("Client not found");
  const taken = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  // Deliberately explicit. Accounts are created by an administrator who needs to
  // know the address is spoken for; there is no public sign-up here for the
  // usual enumeration concern to apply to.
  if (taken) throw new ConflictError(`${input.email} already has an account`);

  const user = await prisma.user.create({
    data: {
      workspaceId,
      name: input.name,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      role: input.role,
    },
    select: userSelect,
  });
  logger.info({ workspaceId, userId: user.id, role: user.role }, "User created");
  return user;
}

/**
 * Update someone in a workspace.
 *
 * Takes the acting session so it can refuse the two self-inflicted lockouts:
 * an administrator deactivating themselves, and the last active administrator
 * in a client demoting themselves — either of which leaves a workspace nobody
 * can administer, recoverable only by the platform owner.
 */
export async function updateUser(
  session: SessionUser,
  workspaceId: string,
  userId: string,
  patch: z.infer<typeof updateUserSchema>,
) {
  const target = await prisma.user.findFirst({ where: { id: userId, workspaceId }, select: { id: true, role: true, isActive: true } });
  if (!target) throw new NotFoundError("User not found");

  const losingAdmin =
    (patch.isActive === false && target.isActive && target.role === "ADMIN") ||
    (patch.role === "RECRUITER" && target.role === "ADMIN");

  if (target.id === session.id && patch.isActive === false) {
    throw new ValidationError("You cannot deactivate your own account");
  }
  if (losingAdmin) {
    const otherAdmins = await prisma.user.count({
      where: { workspaceId, role: "ADMIN", isActive: true, id: { not: userId } },
    });
    if (otherAdmins === 0) {
      throw new ValidationError("This is the only active administrator for this client — promote someone else first");
    }
  }

  const data: Prisma.UserUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.role !== undefined) data.role = patch.role;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;
  if (patch.password !== undefined) data.passwordHash = await hashPassword(patch.password);

  const user = await prisma.user.update({ where: { id: userId }, data, select: userSelect });
  logger.info({ workspaceId, userId, fields: Object.keys(patch) }, "User updated");
  return user;
}
