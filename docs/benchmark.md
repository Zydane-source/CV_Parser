# Benchmark

How the extraction engines are measured, what the numbers say, and — more
importantly — what they do not.

```bash
npm run corpus                        # generate the 120-CV labelled corpus
npm run benchmark                     # score the local engine
npm run benchmark -- --engine legacy  # score the LLM (spends money)
npm run rescore                       # re-score saved results, no re-spend
```

---

## Read this before the numbers

**The corpus is synthetic, and the local engine was tuned against it.** The LLM
saw it cold. That asymmetry is real and it inflates the gap.

`scripts/generate-benchmark-corpus.ts` produces 120 CVs from a combinatorial
grid — 7 role styles × 5 layouts × 3 formats, with decoy phone numbers, referee
blocks, honorifics and scan-only pages mixed in. They are *modelled on* real
Indian and international CV conventions, not sampled from them. Real CVs are
messier in ways a generator does not think of.

During development the loop was: run the benchmark, look at a failure, decide
whether it was an engine bug or a corpus artefact, fix the one that was actually
broken. Several failures were corpus artefacts and were fixed in the generator —
a PDF writer truncating lines mid-word so a role never appeared in the document
at all, for instance. Tuning the engine around that would have been fitting to
noise. But the honest summary is still: **100% here means "fits this corpus",
not "solves CV parsing"**. Treat it as a regression guard, not a capability
claim.

The trustworthy claim is narrower and still useful: *on a corpus built to
exercise known-hard layouts, the local engine matches or beats the LLM on every
field, at roughly 1/2500th the latency and no per-CV cost.*

---

## Results

120 CVs, scored taxonomy-aware for both engines (see *Fair scoring* below).

| field | local | legacy (LLM) | delta |
|---|---|---|---|
| candidate name | **100.0%** | 99.2% | +0.8pp |
| phone number | **100.0%** | 100.0% | ±0 |
| job role applied for | **100.0%** | 62.5% | +37.5pp |
| all three correct | **100.0%** | 61.7% | +38.3pp |

| latency | local | legacy (LLM) |
|---|---|---|
| field extraction, mean | **0.8 ms** | 1,975 ms |
| field extraction, p50 | 0.5 ms | 1,315 ms |
| field extraction, p95 | 1.7 ms | 4,785 ms |
| end to end, mean | 262 ms | 2,258 ms |
| end to end, p50 | 3.0 ms | 1,374 ms |
| end to end, p95 | 1,594 ms | 5,086 ms |

End-to-end p95 is dominated by OCR on the 20 scan-only CVs, which both engines
pay identically — it is not an extraction cost.

Targets from the migration brief: phone ≥99% ✅, name ≥95% ✅, role 90–95% ✅,
overall ≥95% ✅.

### Where the LLM lost the role field

Its 45 misses were **45 `Not Found` and 15 wrong** — it under-claimed rather than
hallucinated, which is the better failure mode of the two.

| CV style | LLM misses |
|---|---|
| current designation only | 17 |
| role in the header title | 16 |
| résumé headline | 10 |
| `Position:` label | 8 |
| `Applied for:` label | 5 |
| stated in the objective | 4 |

The 17 *current designation only* CVs deserve a caveat. Those CVs state what the
person does now and never state what they are applying for; the ground truth
says the current designation is the expected answer. That is **my labelling
judgement**, and the LLM's refusal to answer is defensible. Excluding them
entirely, the LLM still scores 75/103 (72.8%) on role. The gap is real but it is
not as large as the headline row implies.

---

## Fair scoring

The LLM initially scored 50% on role. Investigating rather than reporting it
turned up a scoring bug on *my* side, not the model's: it was returning
`Sr. Software Engineer` where the label said `Senior Software Engineer`, and
`BDE` where the label said `Business Development Executive`. Both are correct
answers marked wrong, because the local engine has a role taxonomy that resolves
aliases and the LLM does not.

`rolesMatch()` in `scripts/benchmark.ts` now resolves both engines' output
through the same taxonomy before comparing. That raised the LLM from 50% to
62.5%. The rule: a scorer that advantages the system you are advocating for
produces a number that is worth nothing.

---

## Review flagging, which the accuracy table hides

The local engine flags **73 of 120 (61%)** as `NEEDS_REVIEW` — despite getting
all 120 right.

| cause | count |
|---|---|
| role below the 0.75 threshold | 68 |
| phone below threshold | 7 |
| name below threshold | 3 |

Of the 73, **17 are CVs that state no role at all** — flagging those is exactly
right. The other ~51 are answers the engine got correct but deliberately refuses
to assert, because they rest on tier 3–5 evidence (a title in the header, or a
current designation) whose confidence is capped below the threshold by design.

This is a deliberate trade — a flagged correct answer costs a human ten seconds,
a confidently wrong answer costs a bad hire — but it is an operational cost and
it belongs next to the accuracy number, not behind it. The LLM flagged 65/120 on
the same corpus, so this is not a regression; it is a property of the confidence
model both engines feed.

The benchmark shows tier 3–5 evidence was correct on all 51 of those CVs, which
suggests the ceilings are conservative relative to measured reality. **Raising
them on the strength of a synthetic corpus would be exactly the mistake this
document warns about** — that needs a few hundred real CVs first.

---

## The corpus

`tests/fixtures/benchmark/` — binaries are git-ignored and regenerated by
`npm run corpus`; `ground-truth.json` and the scored `results-*.json` are
tracked, because those are what a future change gets compared against.

**Dimensions.** Role styles: `applied_label`, `position_label`,
`objective_phrase`, `headline`, `header_title`, `current_only`, `absent`.
Layouts: traditional, modern, two-column, bordered table (Indian bio-data),
scan-only. Formats: PDF, DOCX, PNG.

**Adversarial traits**, sprinkled across the grid: decoy phone numbers (PIN
codes, Aadhaar-like digits, years), referee blocks with their own contact
details, honorific-prefixed third parties (`Mr. Sharma, Manager - 98…`),
OCR-only pages, titles wrapped across a line break, and CVs with no stated role
at all.

Never put real candidate CVs in this directory.

---

## Adding a case

When you fix an extraction bug, add the shape that caused it to the generator so
it is measured from then on. A case that only exists in a unit test proves the
line of code works; a case in the corpus proves the *system* still works after
the next weight change.
