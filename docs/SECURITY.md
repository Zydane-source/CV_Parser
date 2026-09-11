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
| `npm audit --omit=dev` | 5 moderate, **0 high, 0 critical** (was 1 critical + 6 high) |

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

When no object store is configured, uploads go to a `StoredFile` row instead.
That is *more* private than a public blob, not less: the bytes have no URL at
all, and reads go through the same authenticated download route.

**Action required by the operator:** existing blobs are not retroactively made
private. Either re-upload them, or accept that CVs stored before this deploy
remain publicly readable by URL.

### 2. `sharp` had open high-severity libvips CVEs — fixed

`sharp@0.34.5` carried inherited libvips vulnerabilities (CVE-2026-33327,
CVE-2026-33328 and others). That mattered more here than the average advisory
because `services/ocr/tesseract-provider.ts` runs sharp over **images uploaded by
users** — precisely the attacker-controlled input those CVEs concern.

Upgraded to `sharp@0.35.4`. npm classified it as semver-major against the
declared `^0.34.0` range, so it was verified rather than assumed: the OCR
integration tests exercise the real code path over PNG, JPEG, WEBP and scanned-
PDF fixtures, and they pass.

### 3. A critical `tar` advisory arrived through an unused PDF dependency — fixed

`tar@6.2.1` (arbitrary file create/overwrite via hardlink path traversal) came in
through `unpdf@0.12.2` → `canvas@2.11.2` → `@mapbox/node-pre-gyp` → `tar`.

The interesting part is that `canvas` was never used. PDF pages are rendered with
`@napi-rs/canvas`; plain `canvas` was only ever a transitive dependency of an old
unpdf. `unpdf@1.8.1` has **no dependencies at all**, so upgrading removed the
entire chain and the critical advisory with it.

It needed three small API changes in `services/ocr/pdf-render.ts` (`canvas` →
`canvasImport`, `canvasFactory` → `CanvasFactory`, and tearing the worker down
through `loadingTask` rather than a `destroy()` that no longer exists). It also
deleted the casts that file used to need, because unpdf now types
`@napi-rs/canvas` directly.

### 4. Remaining advisories, pinned rather than upgraded

Two were resolved with `overrides` in `package.json` instead of major upgrades of
their parents:

| package | advisory | resolution |
|---|---|---|
| `deepmerge-ts` | stack exhaustion on recursive object graphs (via `prisma` → `@prisma/config`) | pinned to `^8.0.2`; verified `prisma generate` and `prisma migrate status` still work, which is the exact path that loads `prisma.config.ts` |
| `postcss` | XSS via unescaped `</style>`, path traversal in source-map resolution (via `next`) | pinned to `^8.5.28`; the alternative was `next@16`, a major framework upgrade. Verified the CSS build is intact and the rendered UI unchanged |

An override forces a version the parent did not pick, so each was tested against
the thing it could plausibly break rather than trusted.

**Result: 13 advisories (1 critical, 6 high) → 5 moderate, 0 high, 0 critical.**
The remaining moderate items are development-only tooling.
---

## Data flow, after the migration

```
browser ──upload──▶ /api/uploads ──▶ Vercel Blob (private)  or  Postgres (no URL)
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
