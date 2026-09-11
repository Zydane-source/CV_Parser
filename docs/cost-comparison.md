# Cost comparison

What the LLM path costs per month at volume, and what replaces it.

## Method

Token counts are **measured**, not guessed. `services/llm/prompts/v1.ts` renders
to 2,158 characters of instruction overhead, to which the CV text is appended.

| | chars | ≈ input tokens |
|---|---|---|
| prompt overhead | 2,158 | 540 |
| benchmark corpus CV (mean) | 571 | 143 |
| a real 1-page CV | ~3,000 | 750 |
| a real 2-page CV | ~5,000 | 1,250 |
| a dense 3-page CV | ~8,000 | 2,000 |

At 4 characters per token. Output is a small JSON object — three fields plus
confidences — at roughly 80 tokens.

The figures below use **1,800 input + 80 output tokens**, i.e. a typical 2-page
CV. The synthetic corpus is far shorter than real CVs, so using its mean would
understate the real bill by about 3×.

## Per-CV cost

List prices at the time of writing — **verify current pricing before relying on
these**, as providers change them.

| model | $/M input | $/M output | cost per CV |
|---|---|---|---|
| gpt-4o-mini | 0.15 | 0.60 | $0.00032 |
| llama-3.3-70b (OpenRouter) | 0.12 | 0.30 | $0.00024 |
| claude-haiku-3.5 | 0.80 | 4.00 | $0.00176 |
| gpt-4o | 2.50 | 10.00 | $0.00530 |
| **local engine** | — | — | **$0.00000** |

## Monthly

| CVs/month | gpt-4o-mini | llama-3.3-70b | claude-haiku | gpt-4o | local |
|---|---|---|---|---|---|
| 1,000 | $0.32 | $0.24 | $1.76 | $5.30 | **$0** |
| 10,000 | $3.18 | $2.40 | $17.60 | $53.00 | **$0** |
| 50,000 | $15.90 | $12.00 | $88.00 | $265.00 | **$0** |
| 100,000 | $31.80 | $24.00 | $176.00 | $530.00 | **$0** |

## The bill that is easy to miss

A serverless function is billed for the time it is *open*, including time spent
waiting on a network round trip. The LLM call added a measured **1,975 ms mean**
to every CV, during which the function sits idle holding 1 GB of memory.

At Vercel's $0.18/GB-hour beyond the included allowance:

| CVs/month | extra function time | extra cost |
|---|---|---|
| 10,000 | 5.5 GB-hours | ~$1.00 |
| 100,000 | 54.9 GB-hours | ~$9.90 |

So at 100k CVs/month on gpt-4o-mini the real difference is roughly **$42/month**,
not $32 — and on gpt-4o roughly **$540**.

The local engine's 0.8 ms is not worth costing.

## Where cost is not the point

Three things change that no table captures:

**The failure mode moves from billing to logic.** `LLM_QUOTA` meant every CV
failed at once because a card expired. That class of outage no longer exists.

**Latency stops depending on somebody else.** p95 extraction went from 4,785 ms
to 1.7 ms. The remaining end-to-end p95 is OCR, which is work the machine is
actually doing.

**Rate limits disappear.** `LLM_RATE_LIMIT_PER_MINUTE` existed to avoid
overwhelming a provider. Throughput is now ~2,100 CVs/second/core, bounded by
CPU rather than by somebody's quota.

## The cost that is real

Not zero — just paid differently, and once:

- **Engineering time** to build and tune the engine, versus an afternoon to write
  a prompt.
- **Maintenance**: an unrecognised role means editing a taxonomy file. An LLM
  would probably have got it right with no intervention at all.
- **Coverage risk**: the LLM generalises to CV shapes nobody anticipated; the
  local engine handles the shapes it was built and measured against. The
  benchmark corpus is synthetic, so that boundary is not yet known precisely —
  see [benchmark.md](benchmark.md).

`EXTRACTION_ENGINE=shadow` exists for exactly that last point: run a model
alongside the local engine on your real CVs and measure the disagreement, before
deciding the coverage question is settled.
