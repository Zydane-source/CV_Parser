# Migrating from the LLM to the local engine

What changed, how to deploy it, how to verify it, and how to go back.

---

## What actually changed

One function call. The pipeline in `services/cv-parser/pipeline.ts` ran

```
text extraction → OCR → normalisation → extractWithLLM() → validation
```

and now runs

```
text extraction → OCR → normalisation → runExtraction() → validation
```

where `runExtraction()` dispatches on `EXTRACTION_ENGINE`. Everything on either
side is the same code it was before. The pre-migration audit
([AUDIT.md](AUDIT.md)) found the LLM had exactly one production seam, which is
why the swap is this small.

The local engine's output type is a superset of the LLM's `LLMExtraction`, so
validation, confidence weighting, review flagging, the UI and the CSV export
needed no changes to accept it.

### Database

Additive only — `database/migrations/0002_local_extraction_engine/`:

| column | purpose |
|---|---|
| `extractionEngine` | `"local"` or `"llm"` |
| `extractionVersion` | engine version, or prompt version for the LLM |
| `fieldMethods` (JSONB) | which signal produced each field |
| `extractionMs` | time in field extraction alone |
| `ocrUsed` | whether OCR ran |
| `reviewRequired` | denormalised review flag, for indexing |

No column was dropped, no column was changed, and existing rows keep their
values. `llmModel` and `promptVersion` remain, and are `NULL` for rows the local
engine produced — the local engine is not a model, and writing a stand-in value
into a column named `llmModel` would break the first query anyone writes to find
rows a model actually touched.

---

## Deploying

The local engine is the **default**. A deployment that sets nothing gets it.

1. Deploy the branch.
2. Optionally delete `LLM_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`,
   `LLM_TIMEOUT_MS`, `LLM_TEMPERATURE`, `LLM_PROMPT_VERSION` and
   `LLM_RATE_LIMIT_PER_MINUTE` from the environment. Nothing reads them in
   `local` mode; deleting them removes the key from the platform rather than
   leaving it lying around unused.
3. Upload a CV and confirm it processes.

There is no migration of existing rows and no backfill. Previously processed
candidates keep their LLM-produced values and their `llmModel`; new ones are
produced locally. Reprocess a CV from its detail page if you want it re-extracted
by the local engine.

### Verifying

```bash
npm run verify:no-llm
```

This is the acceptance check for the whole migration. It deletes every
LLM-shaped environment variable before any application module loads, makes a
request to any known model-provider host throw, then runs a real CV through the
actual worker entry point into Postgres and asserts the row came from the local
engine.

One wrinkle it encodes, which will bite anyone writing a similar check:
**`@prisma/client` auto-loads `.env` when imported**, putting the scrubbed
variables straight back. Configuration is therefore resolved before that import
(`env()` memoises, so the scrubbed view is what the run uses), and the
environment is scrubbed again afterwards.

---

## Rolling back

Set `EXTRACTION_ENGINE=legacy` and restore the LLM credentials. The old path is
still there, still tested, and still works — `tests/e2e/processing-flow.test.ts`
exercises it explicitly. No redeploy of different code is needed; it is an
environment variable.

Rollback affects **new** extractions only. Rows already written by the local
engine keep their values until reprocessed.

## Shadow mode

`EXTRACTION_ENGINE=shadow` stores the local engine's result and *also* runs the
LLM, logging a field-by-field comparison. The LLM's output is never stored as
production data.

Use it to evaluate a model against the local engine on your own real CVs, which
is the evidence the synthetic benchmark cannot give you. It costs the same per
CV as `legacy`, so it is a measurement mode, not a way to run.

---

## What did *not* get removed

Worth stating plainly, because the expected answer is wrong:

- **No dependency was removed.** The LLM client was hand-written over `fetch`
  (`services/llm/`, ~400 lines). There was no `openai` or `@anthropic-ai/sdk`
  package to drop. The install size is unchanged.
- **`services/llm/` still exists**, and so do its tests. It is reachable through
  `shadow` and `legacy` only. Deleting it would remove the rollback path and the
  ability to benchmark against a model, both of which are worth more than the
  400 lines.
- **Google APIs are still called** — Drive, Sheets, OAuth. Those are product
  features, not extraction. The claim is that no CV content is sent to a
  generative model, not that the app makes no network calls.
- **Tesseract still runs** for scanned CVs. It is WASM OCR running locally, no
  credential and no network beyond a one-time language-data download.

---

## Known limitations

- The engine is tuned to English-language CVs and Indian phone conventions.
  Other numbering plans are handled through E.164 but less thoroughly tested.
- Roles outside `taxonomy/role-taxonomy.json` resolve by token overlap, which is
  weaker than an exact taxonomy hit. Add roles you hire for.
- 61% of benchmark CVs are flagged for human review despite being extracted
  correctly — see [benchmark.md](benchmark.md#review-flagging-which-the-accuracy-table-hides).
- The accuracy numbers come from a synthetic corpus the engine was tuned
  against. They are a regression guard, not a capability claim.
