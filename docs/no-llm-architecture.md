# No-LLM architecture

```
CV file
  → document extraction   pdf.js (unpdf) / mammoth / word-extractor
  → local OCR if needed   Tesseract WASM + sharp + @napi-rs/canvas
  → text normalisation    NFKC, ligatures, headers/footers, truncation
  → deterministic extraction
        ├─ document model     sections, headings, label/value lines, header region
        ├─ name               5 weighted signals + corroboration-gated fallback
        ├─ phone              generate widely, eliminate by score
        └─ role               5 evidence tiers against a configurable taxonomy
  → validation             anti-hallucination, phone verified against source text
  → confidence scoring     per field, weighted overall, review threshold
  → PostgreSQL
```

**No generative model is called on any path.** Verified by `npm run verify:no-llm`,
which deletes every LLM-shaped environment variable before a single application
module loads, makes a request to any known model-provider host throw, then runs a
real CV through the production worker into Postgres.

`LOCAL_ONLY=true` turns that from a default into a guarantee: a contradicting
`EXTRACTION_ENGINE` is refused at startup, and the single function every model
call passes through refuses outright.

Full detail: **[local-extraction.md](local-extraction.md)**.
Why Tesseract and not PaddleOCR/EasyOCR: **[ocr-evaluation.md](ocr-evaluation.md)**.
Measured accuracy: **[benchmark-results.md](benchmark-results.md)**.
