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
 *
 * The Prisma CLI is launched through Node against its resolved entry point rather
 * than through `npx`, so this does not depend on npx being on PATH in a build
 * container, and every failure mode prints a reason rather than a bare exit code.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function fail(message, hint) {
  console.error(`\nmigrate: ${message}`);
  if (hint) console.error(`migrate: ${hint}`);
  process.exit(1);
}

// ── 1. Which database? ──────────────────────────────────────────────────────
const direct = process.env.DIRECT_URL?.trim();
const pooled = process.env.DATABASE_URL?.trim();

if (!direct && !pooled) {
  fail(
    "neither DIRECT_URL nor DATABASE_URL is set, so there is nothing to migrate against.",
    "On Vercel: Project -> Settings -> Environment Variables, then redeploy.",
  );
}

const url = direct || pooled;
let host = "(unparseable)";
try {
  host = new URL(url).host;
} catch {
  fail(`the connection string could not be parsed as a URL.`, "Check DATABASE_URL for stray quotes or line breaks.");
}
console.log(`migrate: target ${host} ${direct ? "(from DIRECT_URL)" : "(from DATABASE_URL — no DIRECT_URL set)"}`);

// ── 2. Locate the Prisma CLI without relying on npx or PATH ─────────────────
let cliEntry;
try {
  const pkgPath = require.resolve("prisma/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.prisma;
  if (!rel) throw new Error("the prisma package declares no bin entry");
  cliEntry = path.join(path.dirname(pkgPath), rel);
  if (!existsSync(cliEntry)) throw new Error(`resolved CLI path does not exist: ${cliEntry}`);
} catch (err) {
  fail(
    `could not locate the Prisma CLI (${err instanceof Error ? err.message : String(err)}).`,
    "Dependencies may not be installed, or install scripts were blocked. Run `npm install` first.",
  );
}

// ── 3. Apply migrations ─────────────────────────────────────────────────────
const res = spawnSync(process.execPath, [cliEntry, "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
});

if (res.error) {
  fail(`could not start the Prisma CLI: ${res.error.message}`);
}
if (res.signal) {
  fail(`the Prisma CLI was terminated by signal ${res.signal}.`, "The build container may have run out of memory.");
}
if (res.status !== 0) {
  fail(
    `prisma migrate deploy exited with code ${res.status}. The Prisma output above explains why.`,
    "Common causes: the database is unreachable from this network, the credentials are wrong, or Prisma's engine binaries are missing because the installer skipped package scripts.",
  );
}

console.log("migrate: schema is up to date.");
