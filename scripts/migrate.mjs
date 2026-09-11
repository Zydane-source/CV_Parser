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

// ── 3. Apply migrations, retrying the two transient failures ────────────────
//
// A build container gets one attempt at this, so anything momentary becomes a
// failed deploy. Two things are momentary, and both were observed failing real
// deployments of this project:
//
//   unreachable — serverless Postgres suspends when idle. Neon's first
//                 connection after a quiet period can fail outright ("Can't
//                 reach database server", or DNS not resolving the endpoint at
//                 all) and succeed seconds later once the compute has woken.
//
//   locked      — P1002. Prisma Migrate takes a session-level advisory lock
//                 before applying anything and waits only 10s for it. When more
//                 than one build runs at once — a preview and a production
//                 deploy of the same commit, or several connected projects —
//                 they contend for that lock, one wins and the rest fail. The
//                 loser's migrations are already being applied by the winner,
//                 so waiting and re-checking is exactly the right response.
//
// Nothing else is retried. A conflicting migration or a wrong credential fails
// identically every time; retrying those would only delay the same report.
const RETRYABLE =
  /P1001|P1002|P1017|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Can't reach database server|Server has closed the connection|advisory lock/i;
const LOCKED = /P1002|advisory lock/i;
const ATTEMPTS = 6;

let last = null;
let used = 0;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  used = attempt;
  // Captured rather than inherited so the failure can be classified; the output
  // is echoed either way, so the build log still shows Prisma's own words.
  const res = spawnSync(process.execPath, [cliEntry, "migrate", "deploy"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
  });

  if (res.error) fail(`could not start the Prisma CLI: ${res.error.message}`);
  if (res.signal) {
    fail(`the Prisma CLI was terminated by signal ${res.signal}.`, "The build container may have run out of memory.");
  }

  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.status === 0) {
    process.stdout.write(output);
    console.log("migrate: schema is up to date.");
    process.exit(0);
  }

  last = { status: res.status, output };
  if (!RETRYABLE.test(output) || attempt === ATTEMPTS) break;

  const locked = LOCKED.test(output);
  // A contended lock needs longer than a sleeping database: the build holding it
  // has to finish applying before this one can proceed.
  const waitMs = locked ? Math.min(5000 * attempt, 20000) : Math.min(2000 * attempt, 8000);
  console.log(
    locked
      ? `migrate: another migration is holding the advisory lock (attempt ${attempt}/${ATTEMPTS}). ` +
          `A concurrent build is probably applying the same migrations; waiting ${waitMs}ms.`
      : `migrate: ${host} did not answer (attempt ${attempt}/${ATTEMPTS}). ` +
          `Serverless Postgres suspends when idle; waiting ${waitMs}ms for it to wake.`,
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
}

process.stdout.write(last.output);
fail(
  `prisma migrate deploy exited with code ${last.status} after ${used} attempt(s). The Prisma output above explains why.`,
  LOCKED.test(last.output)
    ? "Another migration held the advisory lock throughout. That usually means several builds ran at once; if none are running, a killed migration may have left the lock behind — see https://pris.ly/d/migrate-advisory-locking"
    : RETRYABLE.test(last.output)
      ? `${host} stayed unreachable. Check that the database is not deleted or suspended beyond waking, and that this network may reach it.`
      : "Common causes: a conflicting migration, wrong credentials, or Prisma's engine binaries missing because the installer skipped package scripts.",
);
