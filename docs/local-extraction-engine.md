# The local extraction engine

`services/cv-engine/` turns normalised CV text into the three fields the product
stores — candidate name, phone number, and the job role applied for — without
calling anything. No API key, no network request, no candidate data leaving the
process.

It replaces exactly one function call. The pipeline in
`services/cv-parser/pipeline.ts` previously did text extraction, OCR,
normalisation, **an LLM call**, then validation. Only the fourth step changed;
everything around it is the same code it always was.

---

## Why a deterministic engine at all

An LLM is a reasonable way to read a CV, and it was the right way to get the
product working. It has three properties that become liabilities once the thing
is running:

| | LLM | Local engine |
|---|---|---|
| Cost | per CV, forever | zero after the first |
| Latency | ~2 s, network-bound | ~1 ms, in-process |
| Determinism | same CV can give different answers | same CV always gives the same answer |
| Privacy | CV text is sent to a third party | text never leaves the process |
| Debuggability | "the model decided" | every answer names the line it came from |

The last row is the one that matters most in practice. When the LLM got a name
wrong there was nothing to fix — you could only re-word the prompt and hope.
When this engine gets a name wrong, it reports which signal fired and at which
line, and that is a bug with a location.

---

## Shape of the thing

```
normalised text
      │
      ▼
  document.ts      structural model: sections, headings, label/value lines
      │
      ├──▶ name.ts     five weighted signals, corroboration-gated fallback
      ├──▶ phone.ts    candidate generation, then scored elimination
      └──▶ role.ts     five evidence tiers against a role taxonomy
      │
      ▼
  index.ts         OCR penalty, assembly into the LLM's own output shape
```

The engine's output type is deliberately a **superset** of the LLM's
`LLMExtraction`. That is why validation, confidence weighting, review flagging
and persistence needed no changes at all: they receive the shape they already
understood, with extra provenance fields attached.

### `document.ts` — where text sits, not just what it says

Position carries meaning that a flat string throws away. A phone number under
*References* belongs to somebody else. A job title under *Work Experience* is a
past job, not the one being applied for. The LLM inferred this from context; here
it is modelled explicitly.

The model annotates rather than rewrites — `raw` is untouched — and recognises:

- **Section headings**, matched whole-line against the vocabulary CVs actually
  use (`OBJECTIVE`, `Bio-Data`, `Educational Qualification`, `Referees`, …),
  tolerating decorative punctuation like `*** EDUCATION ***`.
- **Label/value lines** — `Name : Rahul Sharma`, `Position Applied For - QA`.
- **Bare label lines**, which need explaining. The standard Indian bio-data
  layout is a bordered table, and a table puts label and value in adjacent
  cells. A PDF stores those as two text runs on one line, so the extracted text
  is `Name Sneha Reddy` with no separator at all. Splitting on whitespace alone
  would turn `Senior Associate Infosys` into label `Senior`, so this fires only
  for a closed vocabulary of label terms.
- **The header region**: everything before the first real heading, capped at 18
  lines. `hasSectionHeadings` records whether a real boundary was found, because
  a CV with no headings must not treat itself as all header.

### `phone.ts` — generate widely, then eliminate

Phone extraction is not a matching problem. A CV is full of digit strings: PIN
codes, years, marks, Aadhaar fragments, a referee's mobile, an office landline.
The regex is deliberately loose and the work happens in the scoring.

Rejections are structural rather than cosmetic — length outside 8–15 digits, or
all-identical digits. There is deliberately **no sequential-run rejection**:
`9876543210` is the textbook example *and* a perfectly valid Indian mobile.

Signals that move the score:

- an explicit label (`Mobile:`, `Contact No.`) — strongest
- sitting in the header or a personal-details section
- Indian mobile shape (10 digits starting 6–9), or valid E.164
- *negative*: a third-party line (`Mr. Sharma, Manager - 98xxxxxxxx`), a
  references section, a line that reads as an office or landline number

Below `ACCEPT_FLOOR = 0.32` the engine returns `Not Found`. That is a deliberate
choice: a blank field is a known gap, whereas a referee's number silently stored
as the candidate's is a wrong answer nobody will catch.

### `name.ts` — five signals and a gated fallback

| signal | weight | when |
|---|---|---|
| explicit label | 0.62 | `Name:`, `Candidate Name` |
| header position | 0.42, decaying | first lines of the CV |
| personal details | 0.30 | inside that section |
| adjacent to contact | 0.22 | next to the email/phone block |
| fallback | 0.20 | only with corroboration |

The fallback is the interesting one. Two-column PDFs are extracted in reading
order, which can bury the candidate's name inside the skills column, far from
anywhere a name is supposed to be. Allowing a free-for-all fallback made the
engine confidently return `Java, SQL` as a name. So the fallback fires only when
the candidate is **corroborated** by the email local-part or the file name.

`correctFromFileName()` handles OCR glyph confusion — OCR reads `Iyer` as `Lyer`
— using a bounded Levenshtein distance of 1 against file-name tokens. Bounded,
because unbounded correction would start inventing names.

### `role.ts` — evidence tiers with confidence ceilings

The question is not "what roles appear in this CV" but "which role is this person
applying *for*". Those are different questions, and a CV usually contains many
answers to the first.

| tier | evidence | ceiling |
|---|---|---|
| 1 | explicit applied-for label | 0.97 |
| 2 | objective/summary stating a target role | 0.90 |
| 3 | a known title in the header region | 0.82 |
| 4 | a known title near the top | 0.78 |
| 5 | current designation | 0.55 |

Tier 5 is capped **below** the 0.75 review threshold on purpose. "This person is
currently a Backend Developer" is genuine evidence about what they might be
applying for, and it is not an answer to the question asked. Capping it means
such a row always reaches a human rather than being asserted.

`lineWindows()` scans each line *and* each line joined with the next, because
titles wrap: `Applied for: Senior Backend` / `Developer` is one title split by a
line break.

### `taxonomy.ts` + `taxonomy/role-taxonomy.json`

About 90 canonical roles across 10 families, each with aliases
(`BDE` → `Business Development Executive`), plus `seniorityPrefixes` (Sr., Lead,
Assistant) and `genericRejects` (`Fresher`, `Job`, `Position`) that must never
be returned as a role.

It is a **JSON file, not code**: adding a role your organisation hires for needs
an edit and a restart, not a deploy. An unknown title still resolves through
token overlap, so the taxonomy improves accuracy rather than bounding it.

---

## Confidence, and what it is for

Each field carries a confidence in `0..1`. The existing weighting is unchanged:

```
overall = name × 0.40 + phone × 0.35 + role × 0.25
```

Anything below `CONFIDENCE_THRESHOLD` (default 0.75) marks the record
`NEEDS_REVIEW`. The number is not decoration — the confidence ceilings above are
tuned so that *weak evidence cannot reach the threshold*, which is what makes
review flagging meaningful rather than cosmetic.

`fieldMethods` stores which signal produced each field, so a wrong answer in
production can be traced without re-running anything.

---

## Running it

The engine is the default. Nothing needs configuring:

```bash
npm run verify:no-llm     # proves it works with every LLM variable absent
npm run benchmark         # scores it against the labelled corpus
npm test                  # unit + integration + e2e
```

`EXTRACTION_ENGINE` selects the path: `local` (default), `shadow` (local result
stored, LLM run alongside and compared in the logs) or `legacy` (LLM only,
rollback).

## Extending it

- **A role we don't recognise** — add it to `taxonomy/role-taxonomy.json`.
- **A field extracted wrongly** — the failing signal is named in `fieldMethods`;
  the unit tests in `tests/unit/cv-engine-*.test.ts` are the place to pin the
  case before changing a weight.
- **Changing a weight** — re-run `npm run benchmark` before and after. Weights
  interact, and a change that fixes one layout routinely breaks another.

See [benchmark.md](benchmark.md) for how accuracy is measured and what the
numbers do and do not prove.
