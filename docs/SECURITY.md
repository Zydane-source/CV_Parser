# Security review

Reviewed at the local-extraction migration (branch `feature/local-cv-extraction`).
Findings are stated as checks that were actually run, not as assurances.

---

## What the migration changed, security-wise

The headline change is a reduction in exposure: **CV text is no longer
transmitted to a third party.** Under the LLM engine every CV — names, phone
numbers, addresses, employment history — was serialised into a prompt and sent
to an external API, where retention and training policy was the provider's to
decide. The local engine reads the text in-process and discards it when the
function returns.

Verified by `npm run verify:no-llm`, which deletes every LLM-shaped environment
variable before any application module loads, makes a request to any known
model-provider host throw, and then runs a real CV through the production worker
path.

---

## Checks run

| check | result |
|---|---|
| `.env` in git history | **0 commits** — never committed |
| `.env` / `.env.*` ignored | yes (`.gitignore:31-32`) |
| API keys, DB passwords, tokens hard-coded in source | none found (scanned `sk-`, `npg_`, `AIza` patterns across all tracked source) |
| CV text in logs | no — no logging call in the engine or pipeline carries document text |
| candidate fields in logs | no — no log statement references `candidateName`, `phoneNumber` or `jobRole` |
| shadow-mode comparison logging | booleans only (`nameAgrees`, `phoneAgrees`, `roleAgrees`, `agreementCount`) — never the values |
| raw SQL | only `SELECT 1` health checks; all data access goes through Prisma's parameterised client |
| session cookie | `httpOnly`, `sameSite=lax`, `secure` when `APP_URL` is HTTPS, bounded TTL |
| upload validation | magic-byte detection via `file-type`, independent of the client-supplied MIME type and extension; size capped |
| file name handling | control characters and path separators stripped; basename only; length capped |
| download route | authenticated; `X-Content-Type-Options: nosniff`; attachment disposition for non-inline types |
| CSV formula injection | neutralised (`services/export/csv.ts`) — `=`, `+`, `-`, `@`, tab and CR prefixed with `'`, with a deliberate exemption for plain phone numbers |
| rate limiting | login, uploads, bulk delete, CSV export, Sheets export |
| `/api/jobs/drain` | bearer `CRON_SECRET` |
| benchmark corpus in git | binaries untracked; corpus is synthetic, no real candidate data |

---

## Findings

### 1. Vercel Blob was storing CVs publicly — fixed on this branch

`services/storage/index.ts` uploaded with `access: "public"`. A public blob is
readable by **anyone who has the URL, with no authentication**. The keys are
unguessable, but that is obscurity, not access control, and URLs leak through
logs, proxies, referrer headers and browser history.

Fixed: new uploads are written with `access: "private"` and read through the
authenticated SDK endpoint. Private blobs are not available on every plan or SDK
version, so a failure there falls back to a public write with a loud warning —
losing the upload entirely would be worse than storing it the way this store has
stored every CV so far. **Check your logs for that warning after deploying.** Blobs written before this change are still public,
so the read path falls back to the URL read — otherwise every CV uploaded before
the change would become undownloadable.

**Action required by the operator:** existing blobs are not retroactively made
private. Either re-upload them, or accept that CVs stored before this deploy
remain publicly readable by URL.

### 2. `sharp` has open high-severity libvips CVEs — not fixed, needs its own change

`sharp@0.34.5` carries inherited libvips vulnerabilities (CVE-2026-33327,
CVE-2026-33328 and others). This matters more here than the average advisory
because `services/ocr/tesseract-provider.ts` runs sharp over **images uploaded by
users** — precisely the attacker-controlled input the CVEs concern.

The fix is `sharp@0.35.4`. npm classifies it as semver-major against the declared
`^0.34.0`, and sharp is a native module in the OCR path, so this is a change that
needs its own testing rather than a quiet bump inside a migration branch. It is
the highest-priority follow-up.

### 3. Remaining advisories need major upgrades

`npm audit fix` was run and **resolved nothing** — every remaining item needs a
breaking upgrade:

| package | severity | route to a fix |
|---|---|---|
| `tar` (via `@mapbox/node-pre-gyp` ← `sharp`) | critical | resolved by the sharp upgrade |
| `sharp` | high | `sharp@0.35.4` (finding 2) |
| `postcss` (via `next`) | high | `next@16` — major framework upgrade |
| `deepmerge-ts` (via `@prisma/config` ← `prisma`) | high | Prisma major |

None are in the extraction path, and none were introduced by this migration.
They are recorded here so that "the audit passed" is not mistaken for "there is
nothing outstanding".

---

## Data flow, after the migration

```
browser ──upload──▶ /api/uploads ──▶ Vercel Blob (private)
                         │
                         ▼
                    Postgres (Neon, TLS)
                         │
            drain / worker ──▶ text extraction ──▶ OCR (local WASM)
                         │
                         ▼
                 local engine (in-process)
                         │
                         ▼
            three fields + confidence ──▶ Postgres
```

Still external, by design and unrelated to extraction:

- **Google Drive / Sheets / OAuth** — a product feature. Drive files are read
  from the user's own account; Sheets export writes where the user asked.
- **Tesseract language data** — downloaded once, then cached locally. OCR itself
  runs in WASM, in-process.
- **Neon Postgres** — the database, over TLS.

No CV content reaches a generative model on any path. That is the claim the
migration makes, and `npm run verify:no-llm` is what backs it.
