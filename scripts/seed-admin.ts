/**
 * Create or update the initial accounts.
 *   npm run db:seed
 *
 * Environment:
 *   ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME
 *     A client administrator in the default workspace — the workspace that
 *     adopted everything created before clients existed.
 *   OWNER_EMAIL / OWNER_PASSWORD / OWNER_NAME   (optional)
 *     The platform operator: creates client workspaces and can see across them.
 *     Belongs to no client, which is why its workspace is deliberately null.
 *   SEED_USERS   (optional)
 *     '[{"email":"hr@x.com","password":"...","name":"HR","role":"RECRUITER"}]'
 *     Created in the default workspace alongside the admin.
 */
import "dotenv/config";
import { PrismaClient, type UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const DEFAULT_SLUG = "default";

/**
 * The workspace that owns everything created before workspaces existed.
 *
 * Upserted rather than assumed: migration 0005 creates it, but the seed also
 * runs against a freshly migrated database in development where a developer may
 * have reset the data.
 */
async function defaultWorkspace(): Promise<string> {
  const ws = await prisma.workspace.upsert({
    where: { slug: DEFAULT_SLUG },
    create: { name: "Default", slug: DEFAULT_SLUG },
    update: {},
    select: { id: true },
  });
  return ws.id;
}

async function upsert(email: string, password: string, name: string, role: UserRole, workspaceId: string | null) {
  // `email` is the login identifier: an address or a bare username such as "admin".
  if (!email || !password) throw new Error("identifier and password are required");
  if (/\s/.test(email.trim())) throw new Error(`Login identifier must not contain spaces: "${email}"`);
  if (password.length < 8) throw new Error(`Password for ${email} must be at least 8 characters`);
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase().trim() },
    create: { email: email.toLowerCase().trim(), passwordHash, name, role, workspaceId },
    // isActive is reset too: re-running the seed is how an operator recovers an
    // account that was deactivated, and silently leaving it locked out would
    // make the seed look like it had succeeded when nobody can sign in.
    update: { passwordHash, name, role, workspaceId, isActive: true },
  });
  console.log(`✓ ${role.toLowerCase()} ready: ${user.email}${workspaceId ? "" : " (no client — platform owner)"}`);
}

async function main() {
  const workspaceId = await defaultWorkspace();

  // Each block is independent so the script can be pointed at a live database to
  // add just one account. Requiring ADMIN_EMAIL here would mean that adding an
  // owner to production also reset the existing administrator's password — a
  // surprise nobody would ask for and few would notice until they were locked out.
  if (process.env.ADMIN_EMAIL) {
    await upsert(
      process.env.ADMIN_EMAIL,
      process.env.ADMIN_PASSWORD ?? "",
      process.env.ADMIN_NAME ?? "Admin",
      "ADMIN",
      workspaceId,
    );
  } else {
    console.log("· ADMIN_EMAIL not set — no client administrator created or updated.");
  }

  if (process.env.OWNER_EMAIL) {
    await upsert(
      process.env.OWNER_EMAIL,
      process.env.OWNER_PASSWORD ?? "",
      process.env.OWNER_NAME ?? "Platform owner",
      "OWNER",
      null,
    );
  } else {
    console.log("· OWNER_EMAIL not set — no platform owner created. Set it to manage multiple clients.");
  }

  if (process.env.SEED_USERS) {
    const extra = JSON.parse(process.env.SEED_USERS) as Array<{ email: string; password: string; name?: string; role?: UserRole }>;
    for (const u of extra) await upsert(u.email, u.password, u.name ?? u.email, u.role ?? "RECRUITER", workspaceId);
  }
}

main()
  .catch((err) => {
    console.error("Seed failed:", err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
