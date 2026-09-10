# Deployment

CV Parser is two processes plus three backing services:

```text
                 ┌──────────────────────┐
  HTTPS ───────► │  web  (Next.js)      │──┐
  (proxy/TLS)    │  UI + API routes     │  │
                 └──────────────────────┘  │   ┌────────────┐
                                           ├──►│ PostgreSQL │  candidates, files, jobs, settings, tokens
                 ┌──────────────────────┐  │   └────────────┘
  Google Drive ► │  worker (BullMQ)     │──┤   ┌────────────┐
  webhooks/poll  │  parse + drive-sync  │  ├──►│ Redis      │  job queue, rate limits
                 └──────────────────────┘  │   └────────────┘
                                           │   ┌────────────┐
                                           └──►│ S3 bucket  │  manually uploaded CVs
                                               └────────────┘
                 External: LLM API (OpenAI-compatible or Anthropic), Google Drive/Sheets APIs
```

Both processes run the **same code** (`Dockerfile` targets `web` and `worker`), so the parsing pipeline is
identical everywhere. Scale the worker horizontally; each replica processes `WORKER_CONCURRENCY` CVs in parallel
and rate-limits LLM calls per process (`LLM_RATE_LIMIT_PER_MINUTE`).

## Requirements

| Concern | Production requirement |
|---|---|
| HTTPS | Terminate TLS at a proxy/load balancer (Caddy, nginx, ALB, Cloudflare). Set `APP_URL=https://...`; this turns on `Secure` cookies and Drive push notifications. |
| Database | Managed PostgreSQL 14+ (RDS, Cloud SQL, Neon, Supabase, Railway). Run `prisma migrate deploy` on each release. |
| Object storage | `STORAGE_DRIVER=s3` with any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Spaces). **Do not** use `local` on ephemeral hosts – uploaded CVs would vanish on redeploy. |
| Queue | Managed Redis 6.2+ (ElastiCache, Upstash *with TCP/`rediss://`*, Redis Cloud). `noeviction` policy. |
| Workers | At least one always-on worker process (`npm run worker` / `Dockerfile --target worker`). Serverless-only hosting is not sufficient for OCR/LLM jobs. |
| OCR | Tesseract runs in-process (WASM). Give the worker ≥1 GB RAM; language data caches in `OCR_CACHE_PATH` (mount a volume or accept a one-time download per cold start). |
| Secrets | Inject via the platform's secret store; never bake into images. `AUTH_SECRET` ≥ 32 random bytes; optional `TOKEN_ENCRYPTION_KEY` (32-byte base64) for Google tokens at rest. |

## Option A – Single host with Docker Compose

```bash
cp .env.example .env            # fill in secrets, DATABASE_URL/REDIS_URL can stay as the compose defaults
export POSTGRES_PASSWORD=...    # used by docker-compose.prod.yml
export DOMAIN=cv.example.com    # Caddy obtains a Let's Encrypt certificate automatically
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml run --rm web npx prisma migrate deploy
docker compose -f docker-compose.prod.yml run --rm worker npx tsx scripts/seed-admin.ts
```

Set `STORAGE_DRIVER=s3` + bucket credentials in `.env` (a local volume is mounted at `/data` only as a fallback).

## Option B – PaaS (Railway / Render / Fly.io / Northflank)

1. Create a PostgreSQL and a Redis instance; copy their URLs to `DATABASE_URL` / `REDIS_URL`.
2. Create **two services from the same repo**:
   * `web`: Docker target `web` (or `npm run build` + `npm start`), port 3000, health check `GET /api/health`.
   * `worker`: Docker target `worker` (or `npm run worker`), no port.
3. Add all variables from `.env.example` to both services (the worker needs the LLM, Google, storage and DB/Redis
   variables too).
4. Release command for `web`: `npx prisma migrate deploy`.
5. One-off: `npx tsx scripts/seed-admin.ts` to create the admin user.
6. Point `APP_URL` and `GOOGLE_REDIRECT_URI` at the public HTTPS domain and add that redirect URI in Google Cloud.

## Option C – Kubernetes

* Deployment `web` (2+ replicas, `readinessProbe: /api/health`), Deployment `worker` (N replicas), external
  Postgres/Redis, S3 bucket. A `Job` running `prisma migrate deploy` in the release pipeline.
* Requests/limits: web 512 MB, worker 1–2 GB (OCR of multi-page scans is memory-hungry).
* Use a `Secret` for `.env` values and mount `OCR_CACHE_PATH` on an `emptyDir` or a shared PVC.

## Environment variables

See `.env.example` for the complete list with comments. Minimum for production:

```env
NODE_ENV=production
APP_URL=https://cv.example.com
AUTH_SECRET=<32+ random bytes>
DATABASE_URL=postgresql://...
REDIS_URL=rediss://...
STORAGE_DRIVER=s3  STORAGE_BUCKET=  STORAGE_REGION=  STORAGE_ENDPOINT=  STORAGE_ACCESS_KEY=  STORAGE_SECRET_KEY=
LLM_PROVIDER=openai|anthropic  LLM_API_KEY=  LLM_MODEL=
GOOGLE_CLIENT_ID=  GOOGLE_CLIENT_SECRET=  GOOGLE_REDIRECT_URI=https://cv.example.com/api/google-drive/callback
```

## Operations

* **Migrations**: `npx prisma migrate deploy` (idempotent) before starting the new web/worker version.
* **Scaling**: add worker replicas; keep `WORKER_CONCURRENCY × replicas × LLM calls` under your LLM provider's
  rate limit, or lower `LLM_RATE_LIMIT_PER_MINUTE`.
* **Health**: `GET /api/health` returns `{ok, db, redis}`; 503 if either dependency is down.
* **Logs**: JSON (pino) on stdout. CV text, phone numbers and names are redacted; only ids/status/error codes
  are logged.
* **Backups**: PostgreSQL (candidates + settings + encrypted Google tokens) and the S3 bucket (original CVs).
  Redis holds only transient queue state and can be rebuilt (re-queue with *Retry all failed* / *Sync Now*).
* **Drive webhooks**: channels expire daily and are renewed during each sync. If `APP_URL` changes, click
  **Change Folder** or **Sync Now** once to re-register.
* **Data retention**: original CVs and extracted fields persist until deleted; raw CV text is never stored.
  Delete a `CVFile` row to cascade-delete its candidate and jobs (remove the object from the bucket too).

## Security checklist

- [ ] `APP_URL` is HTTPS, `AUTH_SECRET` rotated from the example.
- [ ] Database and Redis are not publicly reachable (private network / allow-list).
- [ ] S3 bucket is private; the app serves files through `/api/cv-files/:id/download` (authenticated, `nosniff`,
      attachment).
- [ ] Google OAuth client secret stored only in the secret manager; redirect URIs limited to your domains.
- [ ] LLM API key stored only in the secret manager; never exposed to the browser (Settings shows only "set / missing").
- [ ] Rate limits reviewed (`login` 10/min/IP, uploads 60/min/user, exports 10/10 min/user).
