/**
 * Create or update the initial admin user from ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME.
 *   npm run db:seed
 * Optional: SEED_USERS='[{"email":"hr@x.com","password":"...","name":"HR","role":"RECRUITER"}]'
 */
import "dotenv/config";
import { PrismaClient, type UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function upsert(email: string, password: string, name: string, role: UserRole) {
  // `email` is the login identifier: an address or a bare username such as "admin".
  if (!email || !password) throw new Error("identifier and password are required");
  if (/\s/.test(email.trim())) throw new Error(`Login identifier must not contain spaces: "${email}"`);
  if (password.length < 8) throw new Error(`Password for ${email} must be at least 8 characters`);
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase().trim() },
    create: { email: email.toLowerCase().trim(), passwordHash, name, role },
    update: { passwordHash, name, role },
  });
  console.log(`✓ ${role.toLowerCase()} user ready: ${user.email}`);
}

async function main() {
  await upsert(process.env.ADMIN_EMAIL ?? "", process.env.ADMIN_PASSWORD ?? "", process.env.ADMIN_NAME ?? "Admin", "ADMIN");
  if (process.env.SEED_USERS) {
    const extra = JSON.parse(process.env.SEED_USERS) as Array<{ email: string; password: string; name?: string; role?: UserRole }>;
    for (const u of extra) await upsert(u.email, u.password, u.name ?? u.email, u.role ?? "RECRUITER");
  }
}

main()
  .catch((err) => {
    console.error("Seed failed:", err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
