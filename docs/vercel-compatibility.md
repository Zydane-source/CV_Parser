# Vercel compatibility of the local engine

Measured, not assumed. A deterministic engine only helps if it fits inside a
serverless function that may be cold on any request.

## Measured footprint

`npm run measure:engine`:

| | measured | Vercel constraint |
|---|---|---|
| module import | 31.2 ms | contributes to cold start |
| first extraction (parses the role taxonomy) | 11.5 ms | paid once per instance |
| steady state | 0.46 ms/CV | — |
| long CV (~7 KB of text) | 3.48 ms/CV | — |
| RSS attributable to the engine | 15.1 MB | 1024 MB default |
| throughput | ~2,168 CVs/second/core | — |

**Cold start cost is ~43 ms**, once per function instance, after which extraction
is sub-millisecond. For comparison, the LLM call it replaces cost 1,975 ms on
*every* CV, warm or cold.

## Function bundle

Traced from the production build (`.next/server/app/api/jobs/drain/route.js.nft.json`),
the route that does the processing work on Vercel:

| | size |
|---|---|
| **total traced bundle** | **104.2 MB** (limit: 250 MB unzipped) |
| `googleapis` | 28.8 MB |
| `@napi-rs/canvas` (PDF page rendering for OCR) | 26.0 MB |
| `.prisma` client | 20.3 MB |
| `sharp` (image preprocessing for OCR) | 19.0 MB |
| `unpdf` | 1.7 MB |
| all application code | 0.9 MB |

The local engine's contribution: **84 KB of TypeScript and a 10.5 KB JSON
taxonomy**, inside that 0.9 MB. It adds no dependency.

Sizes are from a Windows build; the Linux binaries Vercel uses are comparable.

## The migration removed no weight

Worth stating because the opposite is the natural assumption: **the LLM removal
did not shrink the bundle at all.** The LLM client was hand-written over `fetch`
in `services/llm/` — there was no `openai` or `@anthropic-ai/sdk` package to
drop. What went away was a network call, not a dependency.

## Hobby-plan constraints

| constraint | effect |
|---|---|
| 60 s max function duration | Extraction now uses ~1 ms of it. The budget is spent on OCR, which `DRAIN_BATCH_SIZE` and `DRAIN_TIME_BUDGET_MS` bound. |
| daily cron only | Unchanged. The browser drives `/api/jobs/drain` while a batch is in flight; cron is the backstop. |
| 4.5 MB request body | Unchanged — an upload limit, not an extraction one. |
| no always-on process | The reason `PROCESSING_MODE=inline` exists. The local engine suits it better: no external call to time out mid-drain. |

## What the engine needs at runtime

Nothing but CPU. No API key, no outbound network, no filesystem writes, no
native module of its own. The taxonomy JSON is bundled and read once.

This makes it viable in contexts the LLM path was not: an air-gapped deployment,
a region with no egress to a model provider, or a tenant whose data policy
forbids sending candidate data to a third party.
