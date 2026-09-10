# Architecture

## Unified parsing pipeline

Manual uploads and Google Drive files go through **one** pipeline (`services/cv-parser/pipeline.ts`). The only
difference is where the bytes come from (`services/processing/processor.ts` loads them from object storage or
downloads them from Drive).

```text
             ┌── Manual Upload  (POST /api/uploads → object storage → CVFile row)
             │
CV INPUT ────┤
             │
             └── Google Drive   (drive-sync job → Drive Changes API / folder listing → CVFile row)
                    ↓
              ProcessingJob row + BullMQ job  (services/processing/enqueue.ts)
                    ↓
              Worker  (workers/index.ts → processor.ts)
                    ↓
              File Validation      magic bytes, size, extension  (services/cv-parser/file-validation.ts)
                    ↓
              Text Extraction      pdf.js / mammoth / word-extractor  (services/text-extraction)
                    ↓
              OCR if needed        Tesseract (images, scanned PDFs)    (services/ocr)
                    ↓
              Text Normalization   ligatures, whitespace, dedupe, truncation (normalize.ts)
                    ↓
              LLM Extraction       versioned prompt, JSON-schema output  (services/llm)
                    ↓
              Validation           name/phone/role rules, anti-hallucination (validate.ts)
                    ↓
              Confidence Scoring   per-field + weighted overall, threshold → NEEDS_REVIEW
                    ↓
              Database             Candidate upsert (manual corrections preserved), job + file status
                    ↓
              Dashboard / Candidates / Export to Google Sheets
```

### Stage details

| Stage | Implementation notes |
|---|---|
| Text extraction | pdf.js returns items in reading order, so one- and two-column layouts, tables, headers and footers work without coordinates or templates. A *usable text* heuristic (letters/digits count, symbol ratio, per-page density) detects scanned PDFs and broken font encodings. |
| OCR | `OCRProvider` interface (`extractFromImage`, `extractFromScannedPDF`). Default `TesseractOCRProvider` runs locally (WASM), pre-processes with sharp (grayscale, upscale, sharpen), renders PDF pages via pdf.js + `@napi-rs/canvas`. Provider is selected by `OCR_PROVIDER`; add Google Vision / Textract by implementing the interface. |
| Normalisation | NFKC, ligature/quote/dash fixes, control-char and box-drawing removal, whitespace collapse, repeated header/footer removal, head+tail truncation to `MAX_CV_TEXT_CHARS`. |
| LLM | `LLMProvider` interface. `OpenAICompatibleProvider` (OpenAI, Azure, Groq, OpenRouter, Ollama, vLLM…) tries `response_format: json_schema (strict)` → `json_object` → tolerant parsing. `AnthropicProvider` forces a tool call whose `input_schema` is the extraction schema. Prompt lives in `services/llm/prompts/v1.ts`; select with `LLM_PROMPT_VERSION`. Exactly one LLM call per CV. |
| Validation | Rejects labels ("Resume"), organisations, recruiters, generic roles ("Job Seeker"); normalises Indian phone numbers to `+91XXXXXXXXXX`; verifies the phone digits actually occur in the CV text (anti-hallucination) and lowers confidence when several numbers exist. Any failure → `Not Found` + review reason. |
| Confidence | Per-field 0–1 from the model, clamped and adjusted by validation; overall = 0.4·name + 0.35·phone + 0.25·role. Any required field below `CONFIDENCE_THRESHOLD` (default 0.75) → `NEEDS_REVIEW`. |
| Persistence | `Candidate` upsert keyed by `cvFileId`. Fields listed in `correctedFields` are never overwritten and keep confidence 1.0. `CVFile.status` mirrors the latest job for fast listing. |

## Background processing

* **Queue**: BullMQ on Redis. `cv-processing` (one job per CV) and `drive-sync` (repeatable poll + on-demand).
* **Concurrency**: `WORKER_CONCURRENCY` per worker process + a global limiter (`LLM_RATE_LIMIT_PER_MINUTE`).
* **Retries**: transient errors (timeouts, 429/5xx, network) are re-thrown → BullMQ retries with exponential backoff
  (`MAX_RETRIES`, `RETRY_BACKOFF_MS`). Permanent errors (bad API key, unreadable file, password-protected PDF)
  throw `UnrecoverableError` → `FAILED` immediately. One failed CV never affects others.
* **Live status**: `/api/jobs/stream` (Server-Sent Events, 2 s cadence) drives the Upload and Processing pages;
  clients fall back to polling if SSE fails.

## Duplicate detection

* Manual uploads: SHA-256 of the bytes; an existing hash returns `duplicate` with the existing record
  (UI shows *Already Processed → View Existing Result / Reprocess*). No second record is created.
* Google Drive: `(sourceType, sourceFileId)` is a unique key, so a Drive file is registered once. Unchanged files
  (same `modifiedTime`) are never reprocessed; modified files are re-queued preserving manual corrections.
  If a Drive file's content hash matches an already-parsed CV from any source, it is marked `SKIPPED` with a
  reference to the original.

## Google Drive synchronisation

1. **Connect**: OAuth 2.0 (`drive.readonly`, `spreadsheets`, `userinfo.email`), signed state parameter bound to the
   user, tokens encrypted with AES-256-GCM, auto-refresh persisted.
2. **Folder selection**: folder picker (browse / search) → `folderId` stored → full listing queued.
3. **Detection**: the worker's repeatable `drive-sync` job calls the **Changes API** from the stored
   `startPageToken` (cheap, incremental). On HTTPS deployments a `changes.watch` channel is registered and renewed
   daily; Google's push notification hits `/api/google-drive/webhook`, which queues a debounced sync.
4. **Processing**: bytes are downloaded on demand into memory for parsing and discarded; Drive remains the source of
   truth and is never modified.

## Security

Authentication (bcrypt + signed HttpOnly SameSite cookie), role-based settings (ADMIN), CSRF (same-origin check on
mutating API calls + SameSite cookie), Zod validation on every request, magic-byte file validation, size limits,
rate limits (login/uploads/exports), secrets only in env (never in DB/UI), CSP/security headers, uploaded files
served only as attachments with `nosniff` (never executed or rendered inline as HTML), PII redaction in logs, raw CV
text discarded after processing.

## Data model

See `database/schema/schema.prisma`: `User`, `CVFile`, `Candidate`, `ProcessingJob`, `GoogleDriveConnection`,
`Setting`, `SheetsExport`. Indexed columns: candidate name, phone, job role, source type, source file id, file
hash, status, created/processed timestamps, batch id.
