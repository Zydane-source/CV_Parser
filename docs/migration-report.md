# Migration report: LLM → local extraction engine

Branch `feature/local-cv-extraction`. `main` untouched.

---

## 1. Old architecture

```
file bytes → validation → text extraction (pdf.js / mammoth / word-extractor)
           → OCR if needed (Tesseract, local WASM)
           → normalisation
           → extractWithLLM()  ← HTTP POST to an external model provider
           → validation → confidence scoring → Postgres
```

The pre-migration audit ([AUDIT.md](AUDIT.md)) found the LLM had **exactly one
production seam**:

| location | call | on the production path? |
|---|---|---|
| `services/cv-parser/pipeline.ts:93` | `extractWithLLM(...)` | **yes — the only one** |
| `services/processing/processor.ts:46` | `getLLMProvider()` | configuration guard only |
| `workers/index.ts:73` | `verifyLLMCredentials()` | startup preflight only |
| `services/cv-parser/validate.ts` | `import type { LLMExtraction }` | type-only, erased at compile |

That single seam is why the migration is as small as it is.

## 2. New architecture

```
file bytes → validation → text extraction → OCR if needed → normalisation
           → runExtraction()  ← dispatches on EXTRACTION_ENGINE
                 ├─ local  (default)  services/cv-engine, in-process
                 ├─ shadow            local stored; LLM run and compared in logs
                 └─ legacy            the old LLM path, for rollback
           → validation → confidence scoring → Postgres
```

`services/cv-engine/` (1,344 lines):

- **`document.ts`** — structural model. Sections, headings, label/value pairs,
  the header region. Position carries meaning a flat string discards: a number
  under *References* belongs to somebody else; a title under *Work Experience*
  is a past job, not an application. Includes a bare-label matcher for bordered
  Indian bio-data tables, where a PDF yields `Name Sneha Reddy` with no
  separator at all.
- **`phone.ts`** — generate widely, then eliminate by score. Rejects only what is
  structurally impossible. Below `ACCEPT_FLOOR = 0.32` it returns `Not Found`,
  because a blank field is a known gap and a referee's number stored as the
  candidate's is a wrong answer nobody catches.
- **`name.ts`** — five weighted signals plus a fallback gated on corroboration
  from the email local-part or file name, because an ungated fallback
  confidently returned `Java, SQL` as a name on two-column layouts.
- **`role.ts`** — five evidence tiers with confidence ceilings. Tier 5 (current
  designation) is capped at 0.55, *below* the 0.75 review threshold, on purpose.
- **`taxonomy/role-taxonomy.json`** — ~90 canonical roles with aliases. Data, not
  code: editable without a deploy.

Output is a **superset** of the LLM's `LLMExtraction`, which is why validation,
confidence weighting, review flagging, the UI and CSV export needed no changes.

## 3. Dependencies removed

**None.** The expected answer is wrong and worth stating plainly: the LLM client
was hand-written over `fetch` in `services/llm/` — there was never an `openai` or
`@anthropic-ai/sdk` package installed. What went away is a network call, not a
dependency. The install size and the function bundle are unchanged.

The local engine adds no dependency either: 84 KB of TypeScript and a 10.5 KB
JSON taxonomy.

## 4. External APIs still called

| service | why | carries CV content? |
|---|---|---|
| Google Drive / Sheets / OAuth | product features — ingest from a folder, export to a sheet | Drive returns the file the user asked for; Sheets receives the three extracted fields, as the user requested |
| Neon Postgres | the database, over TLS | yes — it is the store of record |
| Vercel Blob | uploaded file storage | yes — now **private** (see §12) |
| Tesseract language data | one-time ~4 MB download, then cached | no |

**No generative model API is called on any path.** No `openai.com`,
`anthropic.com`, `openrouter.ai`, Gemini, or Vercel AI Gateway.

## 5. Accuracy benchmark

120 labelled CVs, scored taxonomy-aware for both engines so neither is
advantaged.

| field | local | legacy (LLM) | delta | target | met |
|---|---|---|---|---|---|
| candidate name | **100.0%** | 99.2% | +0.8pp | ≥95% | ✅ |
| phone number | **100.0%** | 100.0% | ±0 | ≥99% | ✅ |
| job role applied for | **100.0%** | 62.5% | +37.5pp | 90–95% | ✅ |
| all three correct | **100.0%** | 61.7% | +38.3pp | ≥95% | ✅ |

**The caveat that belongs next to those numbers, not below them:** the corpus is
synthetic and the local engine was tuned against it; the LLM saw it cold. 100%
means "fits this corpus", not "solves CV parsing". Treat it as a regression
guard.

Two more honesty notes:

- The LLM's role score was initially 50%. Investigating rather than reporting it
  found a bug in **my** scorer — it marked `Sr. Software Engineer` wrong against
  a label of `Senior Software Engineer`, because the local engine has an alias
  taxonomy and the LLM does not. Fixing the scorer raised the LLM to 62.5%.
- Of the LLM's 45 role misses, 17 are CVs stating only a current designation,
  where the ground truth says that designation is the answer. That is **my
  labelling judgement** and the LLM's refusal is defensible. Excluding them, the
  LLM still scores 75/103 (72.8%).

**Review flagging, which the accuracy table hides:** the local engine flags
**73/120 (61%)** for human review despite getting all 120 right — 68 driven by
role confidence. 17 of those are CVs that state no role at all (correct to
flag); the other ~51 are correct answers the engine deliberately refuses to
assert. The LLM flagged 65/120 on the same corpus, so this is not a regression,
but it is an operational cost. Details in [benchmark.md](benchmark.md).

## 6. Speed benchmark

| | local | legacy (LLM) |
|---|---|---|
| field extraction, mean | **0.8 ms** | 1,975 ms |
| field extraction, p50 | 0.5 ms | 1,315 ms |
| field extraction, p95 | 1.7 ms | 4,785 ms |
| end to end, mean | 262 ms | 2,258 ms |
| end to end, p95 | 1,594 ms | 5,086 ms |

**~2,500× faster** on the step that changed. End-to-end p95 is OCR on the 20
scan-only CVs, which both engines pay identically.

Footprint (`npm run measure:engine`): 31.2 ms import + 11.5 ms first call
(taxonomy parse) = **~43 ms cold start, once per instance**; 15.1 MB RSS;
~2,168 CVs/second/core.

## 7. Cost comparison

At a measured 1,800 input + 80 output tokens (a typical 2-page CV; the synthetic
corpus is ~3× shorter and would understate this). List prices at time of
writing — verify before relying on them.

| CVs/month | gpt-4o-mini | llama-3.3-70b | claude-haiku | gpt-4o | local |
|---|---|---|---|---|---|
| 1,000 | $0.32 | $0.24 | $1.76 | $5.30 | **$0** |
| 10,000 | $3.18 | $2.40 | $17.60 | $53.00 | **$0** |
| 50,000 | $15.90 | $12.00 | $88.00 | $265.00 | **$0** |
| 100,000 | $31.80 | $24.00 | $176.00 | $530.00 | **$0** |

Plus the bill that is easy to miss: a serverless function is billed while it
waits on the network. 1,975 ms per CV at 1 GB is **54.9 GB-hours (~$9.90) per
100k CVs** of pure idle. Full working: [cost-comparison.md](cost-comparison.md).

Honest accounting: the cost is not removed, it is paid once as engineering time,
plus ongoing taxonomy maintenance and coverage risk on CV shapes nobody
anticipated.

## 8. Files changed

44 files — 28 new, 16 modified. Of 14,714 inserted lines, 10,451 are the three
benchmark JSON data files; roughly 4,300 lines are code and documentation.

| area | what |
|---|---|
| `services/cv-engine/` | **new** — the engine (7 files + taxonomy JSON) |
| `services/cv-parser/pipeline.ts` | the seam: `runExtraction()` dispatch, shadow comparison, stage renamed `LLM_EXTRACTION` → `EXTRACTION` |
| `services/processing/processor.ts` | credential guard only when an LLM will run; persists the new provenance columns |
| `services/storage/index.ts` | Vercel Blob writes are now private |
| `lib/config.ts` | `EXTRACTION_ENGINE` |
| `backend/candidates.ts`, `components/CandidateDetail.tsx` | surface engine provenance |
| `database/` | additive migration `0002_local_extraction_engine` |
| `scripts/` | `generate-benchmark-corpus`, `benchmark`, `rescore`, `verify-no-llm`, `measure-engine` |
| `tests/` | 39 new engine unit tests, a local-pipeline integration suite, e2e updates |
| `docs/` | 6 new documents; ARCHITECTURE and AUDIT updated |

**194 tests pass across 21 files.** Typecheck clean, lint clean, production build
succeeds.

## 9. Environment variables removed

**None were removed** — every variable still parses, so an existing deployment
cannot break on a missing key.

What changed is that these are **no longer required**, and are commented out in
`.env.example` so a fresh deployment does not inherit empty credentials it will
never read (Vercel pre-fills its import form from that file):

`LLM_PROVIDER` · `LLM_API_KEY` · `LLM_MODEL` · `LLM_BASE_URL` ·
`LLM_TIMEOUT_MS` · `LLM_TEMPERATURE` · `LLM_PROMPT_VERSION` ·
`LLM_RATE_LIMIT_PER_MINUTE`

They are read only when `EXTRACTION_ENGINE` is `shadow` or `legacy`. Deleting
them from the platform is recommended — it removes the key rather than leaving
it unused.

## 10. Environment variables required

Unchanged, minus the LLM block:

**Required:** `DATABASE_URL`, `AUTH_SECRET`, `APP_URL`, `ADMIN_EMAIL`,
`ADMIN_PASSWORD`, `PROCESSING_MODE`, plus `STORAGE_DRIVER` and its credentials.

**Optional, new:** `EXTRACTION_ENGINE` — `local` (default), `shadow`, `legacy`.
Omit it entirely for the supported configuration.

## 11. Deployment changes

None required. **The local engine is the default**; a deployment that sets
nothing gets it.

- No backfill, no data migration. Existing candidates keep their LLM-produced
  values; new ones are produced locally. Reprocess a CV to re-extract it.
- The database migration is **additive only** — six new columns, two new indexes,
  nothing dropped or altered. Already applied to both the local Postgres and the
  live Neon database.
- Rollback is an environment variable: `EXTRACTION_ENGINE=legacy` plus the
  credentials. The old path is still there and still tested.

Acceptance criterion verified: `npm run verify:no-llm` deletes every LLM-shaped
variable before any application module loads, makes a request to any known
model-provider host throw, and runs a real CV through the production worker into
Postgres. It passes.

One implementation detail that will bite anyone writing a similar check:
**`@prisma/client` auto-loads `.env` on import** and silently restores variables
you deleted. Configuration is resolved before that import (`env()` memoises), and
the environment is scrubbed again afterwards.

## 12. Known limitations

**Engine**

- Tuned for English-language CVs and Indian phone conventions. Other numbering
  plans go through E.164 but are less thoroughly tested.
- Roles outside the taxonomy resolve by token overlap — weaker than an exact hit.
- 61% of benchmark CVs are flagged for review despite being extracted correctly.
- The accuracy numbers come from a synthetic corpus the engine was tuned
  against. The real-world boundary is not yet known.

**Security** (full review: [SECURITY.md](SECURITY.md))

- **Fixed on this branch:** CVs were being written to Vercel Blob with
  `access: "public"` — readable by anyone holding the URL, with no
  authentication. New uploads are private; **blobs written before this deploy
  remain public** and are not retroactively fixed. Re-upload them or accept that.
- **Fixed since:** `sharp` upgraded to 0.35.4, closing the high-severity libvips
  CVEs that ran over user-uploaded images during OCR; `unpdf` upgraded to 1.8.1,
  which removed the unused `canvas` dependency and with it the critical `tar`
  advisory; `deepmerge-ts` and `postcss` pinned via `overrides`.
- **Result: 1 critical + 6 high → 0 critical, 0 high.** Five moderate advisories
  remain, all development-only tooling.

**Production state, verified directly against Neon**

- The `admin` user exists with role ADMIN, and the configured password
  authenticates against the stored bcrypt hash.
- Migration `0002` is applied: all six new `Candidate` columns are present.
- The database held 0 CV files and 0 candidates at the time of checking, so the
  local engine has not yet processed anything in production.

## 13. Next improvements

1. **Keep the dependency audit at zero high/critical.** It is there now; the
   `overrides` on `deepmerge-ts` and `postcss` are pins, not fixes, and should be
   dropped once `prisma` and `next` ship versions that resolve them upstream.
2. **Shadow-mode a real corpus.** `EXTRACTION_ENGINE=shadow` runs a model
   alongside the local engine and logs field-by-field disagreement without
   storing model output. A few hundred real CVs would replace the synthetic
   benchmark's biggest weakness with evidence.
3. **Revisit the confidence ceilings — but only after (2).** Tier 3–5 evidence
   was correct on all 51 corpus CVs where it fired, which suggests the ceilings
   are conservative and are sending correct answers to review unnecessarily.
   Raising them on synthetic evidence would be exactly the mistake
   [benchmark.md](benchmark.md) warns about.
4. **Grow the taxonomy from production data.** Log role surfaces that resolve
   only by token overlap; those are the roles worth adding.
5. **Retire `services/llm/` eventually** — but not before (2). It costs 400 lines
   and buys the rollback path and the ability to benchmark against a model.
