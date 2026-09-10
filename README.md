# CV Parser

Production-ready CV intake for HR/recruitment teams. CVs arrive by **manual upload** (single, multiple, bulk)
or from a **Google Drive folder** (detected automatically), go through one parsing pipeline
(text extraction → OCR fallback → LLM extraction → validation → confidence scoring), and are stored in
PostgreSQL. Recruiters search, filter, review, correct, reprocess and export candidates to **Google Sheets**.

Extracted fields: **Candidate Name**, **Phone Number** (normalised to `+91XXXXXXXXXX`), **Job Role Applied For**,
each with a confidence score. Missing information is reported as `Not Found` – never invented.

## Contents

- [Architecture](#architecture)
- [Folder structure](#folder-structure)
- [Technology stack](#technology-stack)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [Database setup](#database-setup)
- [Google Cloud / OAuth / Drive / Sheets setup](#google-cloud--oauth--drive--sheets-setup)
- [LLM setup](#llm-setup)
- [OCR setup](#ocr-setup)
- [Local development](#local-development)
- [Background worker](#background-worker)
- [API](#api)
- [Testing](#testing)
- [Production deployment](#production-deployment)
- [Troubleshooting](#troubleshooting)

## Architecture

```text
Manual upload ──┐                                        ┌─ Dashboard / Candidates
                ├─► CVFile + ProcessingJob ─► Redis queue ─► Worker ─► Pipeline ─► PostgreSQL ─┤
Google Drive ───┘   (dedupe: SHA-256 / Drive file id)     (BullMQ)     (see below)             └─ Google Sheets export

Pipeline: File validation → Text extraction (pdf.js / mammoth / word-extractor) → OCR if needed (Tesseract)
          → Normalisation → LLM extraction (JSON schema) → Validation → Confidence scoring → Database
```

Full description: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Folder structure

```text
cv-parser/
├── app/                     Next.js App Router: pages + API route handlers
│   ├── (app)/               authenticated UI: dashboard, upload, candidates, jobs, google-drive, settings
│   ├── login/
│   └── api/                 uploads, candidates, jobs, stats, cv-files, google-drive, google-sheets, settings, auth, health
├── components/              React UI (upload dropzone, candidates table, detail, jobs monitor, drive connect, settings)
├── backend/                 domain logic shared by API routes + exports (candidates, jobs, stats)
├── services/
│   ├── cv-parser/           pipeline, normalisation, validation, phone rules, file validation
│   ├── text-extraction/     PDF / DOC / DOCX text extraction + scanned-PDF detection
│   ├── ocr/                 OCRProvider abstraction, Tesseract provider, PDF page rendering
│   ├── llm/                 LLMProvider abstraction, OpenAI-compatible + Anthropic providers, versioned prompts
│   ├── google-drive/        OAuth, file listing, Changes API sync, push-notification watch
│   ├── google-sheets/       Sheets export
│   ├── storage/             object storage (S3-compatible or local)
│   └── processing/          BullMQ queues, enqueue/reprocess/retry, worker-side processor
├── workers/                 background worker entry point
├── database/
│   ├── schema/schema.prisma
│   └── migrations/
├── lib/                     config, db, auth, crypto, logger, settings, rate limiting, API helpers, client helpers
├── tests/
│   ├── unit/                validation, phone, normalisation, LLM JSON parsing, file validation, crypto, sheets/drive mapping
│   ├── integration/         real text extraction, OCR, pipeline over 14 CV variations, LLM providers, DB, queue
│   ├── e2e/                 upload → queue → worker → DB, duplicates, reprocess, retry
│   ├── helpers/             fixture loader, deterministic test LLM
│   └── fixtures/            generated CV fixtures (npm run fixtures)
├── scripts/                 seed-admin, generate-fixtures
├── docs/                    ARCHITECTURE, DEPLOYMENT, GOOGLE_CLOUD_SETUP
├── public/  uploads/        static assets / local-storage directory (dev only)
├── middleware.ts            auth gate, CSRF check, security headers
├── docker-compose.yml       local Postgres + Redis
├── docker-compose.prod.yml  web + worker + proxy (+ optional Postgres/Redis)
├── Dockerfile               multi-stage: --target web | --target worker
├── prisma.config.ts  vitest.config.ts  next.config.ts  tsconfig.json  eslint.config.mjs
├── .env.example  .gitignore  package.json
```

## Technology stack

| Layer | Choice |
|---|---|
| Frontend / backend | Next.js 15 (App Router, route handlers), React 19, TypeScript, Tailwind CSS 4 |
| Database | PostgreSQL + Prisma 6 |
| Background jobs | Redis + BullMQ (retries with exponential backoff, concurrency, rate limiting, repeatable Drive polling) |
| Storage | S3-compatible object storage (AWS S3, R2, MinIO…) or local disk for development |
| Text extraction | pdf.js (`unpdf`), mammoth (DOCX), word-extractor (DOC) |
| OCR | Tesseract (`tesseract.js`, local WASM) behind an `OCRProvider` interface; PDF pages rendered with `@napi-rs/canvas` |
| LLM | Provider-agnostic: any OpenAI-compatible chat endpoint or Anthropic Messages API, JSON-schema enforced output |
| Google | Google Drive API v3 (read-only + Changes API + push notifications), Google Sheets API v4, OAuth 2.0 (`googleapis`) |
| Auth / security | bcrypt, signed HttpOnly cookies (jose), CSRF origin check, Zod validation, magic-byte file checks, rate limiting, AES-256-GCM token encryption, CSP |
| Tests | Vitest |

## Installation

Prerequisites: Node.js 20+, PostgreSQL 14+ and Redis 6.2+ (or Docker for both).

```bash
git clone <this repo> cv-parser && cd cv-parser
npm install                      # also runs prisma generate
cp .env.example .env             # then edit (see below)
docker compose up -d             # local Postgres + Redis (skip if you have your own)
npx prisma migrate deploy        # create tables
npm run db:seed                  # create the admin user from ADMIN_EMAIL / ADMIN_PASSWORD
```

## Environment variables

All variables are documented in [`.env.example`](.env.example). Required to start:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (`rediss://` for TLS) |
| `AUTH_SECRET` | ≥32 random bytes; signs sessions and derives the token-encryption key |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | initial admin (used by `npm run db:seed`) |
| `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` | LLM extraction (see [LLM setup](#llm-setup)) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google Drive + Sheets |
| `STORAGE_DRIVER` + `STORAGE_*` | `local` (dev) or `s3` (production) |
| `APP_URL` | public URL; HTTPS enables secure cookies and Drive push notifications |

Optional tuning: `WORKER_CONCURRENCY`, `LLM_RATE_LIMIT_PER_MINUTE`, `MAX_RETRIES`, `RETRY_BACKOFF_MS`,
`CONFIDENCE_THRESHOLD`, `MAX_FILE_SIZE_MB`, `MAX_FILES_PER_REQUEST`, `OCR_*`, `GOOGLE_DRIVE_SYNC_INTERVAL_MINUTES`,
`GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_SHEETS_SPREADSHEET_ID`. Most of these can also be changed at runtime on the
**Settings** page (admin only); secrets are environment-only and never shown in the UI.

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

## Database setup

* Schema: `database/schema/schema.prisma`; migrations: `database/migrations/` (configured in `prisma.config.ts`).
* Apply: `npx prisma migrate deploy` (production) or `npm run db:migrate:dev` (creates a new migration after schema edits).
* Inspect: `npm run db:studio`.
* Indexes exist on candidate name, phone, job role, source type, source file id, file hash, status, timestamps and batch id.

## Google Cloud / OAuth / Drive / Sheets setup

Step-by-step (project, enabling Drive + Sheets APIs, consent screen, scopes, credentials, redirect URI, test users,
production verification): [docs/GOOGLE_CLOUD_SETUP.md](docs/GOOGLE_CLOUD_SETUP.md).

Scopes used (minimum): `drive.readonly`, `spreadsheets`, `userinfo.email`. Drive files are never modified.

In the app: **Google Drive → Connect Google Drive → Select Folder**. New files in that folder are detected by the
worker's Changes-API poll (every `GOOGLE_DRIVE_SYNC_INTERVAL_MINUTES`) and, on HTTPS deployments, by push
notifications within seconds. **Sync Now** forces a full folder scan.

## LLM setup

Any OpenAI-compatible endpoint or Anthropic:

```env
# OpenAI
LLM_PROVIDER=openai
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# Anthropic
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-5

# Groq / OpenRouter / Together / Azure / local Ollama (OpenAI-compatible)
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.groq.com/openai/v1      # or http://localhost:11434/v1 for Ollama
LLM_MODEL=llama-3.3-70b-versatile
```

The extraction prompt is versioned in `services/llm/prompts/` (`LLM_PROMPT_VERSION=v1`). Output is schema-enforced
(`response_format: json_schema` / Anthropic tool input) and validated again server-side.

## OCR setup

No credentials required. Tesseract language data (~4 MB for `eng`) is downloaded once into `OCR_CACHE_PATH`
(`./.tesseract-cache` by default; mount a volume in production). Add languages with `OCR_LANGUAGES=eng+hin`.
OCR runs automatically for images and for PDFs whose text layer is empty, too short (`OCR_MIN_TEXT_CHARS`) or
mostly symbols. To plug in another engine, implement `OCRProvider` in `services/ocr/` and register it in
`services/ocr/index.ts`.

## Local development

Run the web app **and** the worker together (recommended — CVs stay `Pending` forever without a worker):

```bash
npm run dev:all
```

Or in two terminals:

```bash
npm run dev
```

```bash
npm run worker
```

Both must run from the project root so they resolve the same `LOCAL_STORAGE_PATH`. If anything looks stuck, ask the app:

```bash
npm run diagnose
```

It prints the job/queue state, whether a worker is actually consuming the queue, and the LLM/storage configuration (secrets masked).

Open <http://localhost:3000>, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then **Upload CVs**.

Generate sample CVs covering all layout variations (PDF, two-column, tables, image, scanned, DOCX, missing fields,
multiple phones, references): `npm run fixtures` → `tests/fixtures/generated/`.

## Background worker

`workers/index.ts` consumes two queues:

* `cv-processing` – one job per CV. Concurrency `WORKER_CONCURRENCY`, LLM calls capped at
  `LLM_RATE_LIMIT_PER_MINUTE`, transient failures retried with exponential backoff up to `MAX_RETRIES`,
  permanent failures marked `FAILED` immediately.
* `drive-sync` – repeatable job (interval from settings) plus on-demand jobs from **Sync Now**, folder changes and
  Drive webhooks.

Run several worker processes to scale. Concurrency/interval changes on the Settings page apply on worker restart.

## API

All routes require the session cookie except `POST /api/auth/login`, `GET /api/health` and the Drive webhook.
Mutating requests must be same-origin (CSRF). Every request body / query is validated with Zod.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/login` · `/api/auth/logout` · GET `/api/auth/me` | session |
| POST | `/api/uploads` | multipart `files[]` (+ `batchId`); per-file result: queued / duplicate / rejected |
| GET | `/api/candidates?q=&source=&status=&role=&from=&to=&page=&pageSize=&sort=&order=` | DB-backed search + pagination |
| GET / PATCH | `/api/candidates/:id` | detail / manual correction (`is_manually_corrected`) |
| POST | `/api/candidates/:id/reprocess` | re-run pipeline (manual corrections preserved) |
| GET | `/api/candidates/roles` | job roles for filters |
| GET | `/api/cv-files/:id/download` | original CV (attachment, nosniff) |
| GET | `/api/jobs` · `/api/jobs/stream` (SSE) | job list / live progress |
| POST | `/api/jobs/retry-failed` · `/api/jobs/:id/retry` | retry failed CVs |
| GET | `/api/stats` | dashboard counters |
| POST | `/api/google-drive/connect` → GET `/api/google-drive/callback` | OAuth |
| GET | `/api/google-drive/status` · `/api/google-drive/folders?parent=\|q=` | connection + folder picker |
| PUT | `/api/google-drive/folder` | select folder (queues full sync) |
| POST | `/api/google-drive/sync` · `/disconnect` · `/webhook` | sync now / disconnect / push notifications |
| POST | `/api/google-sheets/export` | export (filters optional) → spreadsheet URL |
| GET / PATCH | `/api/settings` | runtime settings (PATCH admin only) |
| GET | `/api/health` | db + redis health |

## Testing

```bash
npm test                 # everything
npm run test:unit        # pure logic (no services needed)
npm run test:integration # real pdf.js / mammoth / Tesseract / pipeline; DB + Redis + LLM tests skip if unavailable
npm run test:e2e         # upload → queue → worker → DB (needs Postgres + Redis)
npm run typecheck && npm run lint && npm run build
```

Coverage: PDF / DOCX / image / scanned-PDF processing; name, phone, role, missing fields, multiple phone numbers,
references, ambiguous roles; bulk processing, duplicate detection, retry/backoff, failed CV isolation, queue
processing; Drive file filtering + Sheets row mapping (unit) and live provider tests that run when credentials are
present; persistence, updates and manual corrections. Pipeline tests use a deterministic test LLM so they are
reproducible offline; the real providers are tested with mocked HTTP for error handling and live when
`LLM_API_KEY` is set.

## Production deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (Docker Compose, PaaS, Kubernetes; HTTPS, managed Postgres/Redis,
S3 storage, worker scaling, migrations, security checklist).

```bash
npm run build && npm start          # web
npm run worker                      # worker
# or
docker build --target web -t cv-parser-web . && docker build --target worker -t cv-parser-worker .
```

## Troubleshooting

First step for anything unexpected: `npm run diagnose`. The UI also tells you directly — a red banner when no worker is consuming the queue, an amber one when the worker runs but the LLM is unusable.

| Problem | Fix |
|---|---|
| CVs stay **Pending** | No worker is consuming the queue. Run `npm run worker` (or `npm run dev:all`) from the project root; queued CVs are picked up automatically within seconds. If it is running, check `REDIS_URL` and `/api/health`. |
| CVs **Pending** and the worker *is* running | The worker cannot reach Redis, or it was started from a different folder than the web server so `LOCAL_STORAGE_PATH` resolves elsewhere. The worker logs its resolved storage path at startup. |
| Every CV **Failed** with `LLM_QUOTA` | The LLM account has no credit left (OpenAI returns HTTP 429 `insufficient_quota`). Add credits, or point `LLM_BASE_URL`/`LLM_MODEL` at another provider. This is not retried, by design — retrying a billing problem never helps. |
| Every CV **Failed** with `LLM_NOT_CONFIGURED` / `LLM_AUTH` | Set `LLM_API_KEY` (and `LLM_PROVIDER`/`LLM_MODEL`), restart the worker, click **Retry all failed**. The worker preflights the credentials at startup and prints the reason. |
| Every CV **Failed** with `LLM_MODEL_NOT_FOUND` | `LLM_MODEL` does not exist on the configured endpoint. |
| Want to run with no LLM spend | Point at a local OpenAI-compatible server, e.g. Ollama: `LLM_PROVIDER=openai`, `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=llama3.1`, `LLM_API_KEY=ollama`. |
| `NO_TEXT` failures | The file is blank/corrupt or an unreadable scan. Try a higher-resolution scan; check `OCR_LANGUAGES`. |
| First OCR is slow | Tesseract downloads language data once into `OCR_CACHE_PATH`. |
| Google `redirect_uri_mismatch` / `access_denied` | See [docs/GOOGLE_CLOUD_SETUP.md](docs/GOOGLE_CLOUD_SETUP.md) §6 and §8. |
| Drive files not detected | Only direct children of the selected folder are watched; supported types only; wait for the poll interval or click **Sync Now**. |
| Export says "Connect Google Drive first" | Sheets uses the same Google account – connect on the Google Drive page. |
| 403 `CSRF` on API calls | Requests must come from the app origin (browser) with the session cookie; send an `Origin` header matching `APP_URL` when scripting. |
| `Cannot apply unknown utility class` / CSP eval errors in dev | Restart `npm run dev` after editing `next.config.ts` or `globals.css`. |
| Uploaded files disappear after redeploy | Use `STORAGE_DRIVER=s3` in production. |
