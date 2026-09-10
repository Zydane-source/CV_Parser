/**
 * Runs `prisma migrate deploy` against the DIRECT (non-pooled) database URL.
 *
 * Connection poolers such as Neon's and Supabase's run in transaction mode and
 * cannot hold the session-level advisory lock Prisma Migrate takes, so DDL must
 * go to the direct host while runtime queries keep using the pooled one.
 *
 * DIRECT_URL is optional. When it is not set this falls back to DATABASE_URL,
 * which is correct for a plain Postgres with no pooler in front of it. Declaring
 * `directUrl` in schema.prisma cannot express that: Prisma makes it mandatory as
 * soon as it appears, and fails validation on an empty value.
 */
import { spawnSync } from "node:child_process";

const direct = process.env.DIRECT_URL?.trim();
const pooled = process.env.DATABASE_URL?.trim();

if (!direct && !pooled) {
  console.error("migrate: neither DIRECT_URL nor DATABASE_URL is set. Nothing to migrate against.");
  process.exit(1);
}

const url = direct || pooled;
const host = (() => {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
})();
console.log(`migrate: applying migrations to ${host}${direct ? " (DIRECT_URL)" : " (DATABASE_URL — no DIRECT_URL set)"}`);

const res = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(res.status ?? 1);
