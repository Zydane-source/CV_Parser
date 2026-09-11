# Pre-migration audit

State of the deployed application **before** the local extraction engine was introduced.
Written first so the migration could be judged against what actually existed, not against memory.

> This is a historical snapshot and is deliberately not updated. For the system as it
> now stands see [local-extraction-engine.md](local-extraction-engine.md) and
> [migration-from-llm.md](migration-from-llm.md).

## Stack

| Concern | Implementation |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, Tailwind CSS 4 |
| Backend | Next.js route handlers in `app/api/`, domain logic in `backend/`, integrations in `services/` |
| Database | PostgreSQL (Neon, `us-east-2`) + Prisma 6; schema `database/schema/schema.prisma`, migrations `database/migrations/` |
| Auth | bcrypt + signed HttpOnly cookie (`jose`), `middleware.ts` gate, CSRF origin check |
| Deployment | Vercel (`vercel.json`), Hobby plan, region `iad1`, build runs `scripts/migrate.mjs` |
| Object storage | `services/storage/index.ts` — `local` \| `s3` \| `vercel-blob` behind one `StorageProvider` interface |
| Background work | `PROCESSING_MODE=queue` (BullMQ worker) or `inline` (`/api/jobs/drain`, browser-pumped + cron) |

## CV flow, end to end

```text
Manual upload (app/api/uploads/route.ts)          Google Drive (services/google-drive/sync.ts)
  validate magic bytes, size                        Changes API / folder listing
  SHA-256 hash -> duplicate check                   Drive file id -> duplicate check
  store object                                      (Drive file never modified)
                    \                              /
                     CVFile row + ProcessingJob row
                                 |
                  services/processing/enqueue.ts
                                 |
        queue mode: BullMQ worker   |   inline mode: /api/jobs/drain
                                 |
                  services/processing/processor.ts
                                 |
                  services/cv-parser/pipeline.ts  <-- parseCV()
                                 |
   1 text extraction   services/text-extraction/index.ts
                         PDF  -> unpdf (pdf.js)
                         DOCX -> mammoth
                         DOC  -> word-extractor
   2 OCR fallback      services/ocr/tesseract-provider.ts (tesseract.js WASM)
                         scanned PDF pages via services/ocr/pdf-render.ts (@napi-rs/canvas)
   3 normalisation     services/cv-parser/normalize.ts
   4 EXTRACTION        services/llm/index.ts  <-- THE ONLY EXTERNAL AI CALL
   5 validation        services/cv-parser/validate.ts
                                 |
                   Candidate row (upsert, manual corrections preserved)
                                 |
              dashboard / search / CSV / Google Sheets export
```

## Every LLM touch point

Exhaustive, from `grep` over `app/ lib/ services/ backend/ workers/ scripts/ tests/`:

| Location | Call | Production path? |
|---|---|---|
| `services/cv-parser/pipeline.ts:93` | `extractWithLLM(...)` | **Yes — the only one** |
| `services/processing/processor.ts:46` | `getLLMProvider()` | Yes, but only a fail-fast config guard |
| `workers/index.ts:73` | `verifyLLMCredentials()` | Worker startup preflight only |
| `services/cv-parser/validate.ts` | `import type { LLMExtraction }` | Type-only, erased at compile time |
| `app/api/settings/route.ts` | `availablePromptVersions()` | Displays prompt versions in Settings |
| `scripts/bench-models.ts`, `tests/**` | various | Tooling and tests, not production |

**Consequence:** the migration has a single seam. Step 4 of `parseCV()` is the only place where CV
text leaves the process.

## Current extraction contract

`services/llm/types.ts` defines what step 4 must return, and `validate.ts` consumes it:

```ts
{ candidate_name, phone_number, job_role_applied_for,
  confidence: { candidate_name, phone_number, job_role_applied_for } }
```

Any replacement that produces this shape drops in without touching validation, confidence scoring,
persistence, or the UI. That is the strategy the migration follows.

## Behaviour that must survive

- `Candidate` fields: `candidateName`, `phoneNumber`, `jobRoleAppliedFor`, the three per-field
  confidences, `overallConfidence`, `isManuallyCorrected`, `correctedFields`, `reviewReasons`,
  `extractionMethod`, `llmModel`, `promptVersion`, `processedAt`.
- Confidence weighting `0.4 name + 0.35 phone + 0.25 role`, threshold `CONFIDENCE_THRESHOLD`
  (default 0.75) driving `NEEDS_REVIEW`.
- Validation rejections: organisation/label names, generic roles, unverifiable phone numbers.
- `"Not Found"` as the sentinel for a missing field — never a guess.
- Duplicate detection, reprocessing preserving manual corrections, retry classification, Drive
  sync and ignore list, CSV and Sheets export, delete, dashboard, search and filters.

## Production environment variables before migration

Required: `DATABASE_URL`, `AUTH_SECRET`, `PROCESSING_MODE`, `STORAGE_DRIVER`, `OCR_CACHE_PATH`,
`ADMIN_*`, `CRON_SECRET`, and **`LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`**.
Optional: `DIRECT_URL`, `GOOGLE_*`, `REDIS_URL` (queue mode only), limits and tuning.

The four `LLM_*` variables are what this migration exists to remove from the required set.

## Risks identified before starting

1. `parseCV()` is called from two processors (worker and drain). Both must keep working.
2. `validateExtraction` cross-checks the phone against the CV text; a local extractor that reads
   the same text will always pass that check, so the check stops being an independent signal and
   confidence must come from real evidence instead.
3. Tests import `setLLMProvider` to inject a fake. Removing the LLM module would break them, so it
   stays behind a flag rather than being deleted.
4. Vercel Hobby caps functions at 60s; the local engine must be faster than the LLM path, not slower.
