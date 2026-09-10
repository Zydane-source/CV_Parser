# Deploy to Vercel

This gets the app live on a shareable HTTPS URL. Follow it in order; it takes about 20 minutes.

## The one thing to understand first

The app normally parses CVs in a **separate always-on worker process**. Vercel has no always-on
processes, so that worker cannot run there. Instead the app supports a second mode:

| | `PROCESSING_MODE=queue` | `PROCESSING_MODE=inline` |
|---|---|---|
| Who parses the CVs | a dedicated `npm run worker` process | `/api/jobs/drain`, called by the browser while a batch runs and by a scheduled cron |
| Needs Redis | yes | no |
| Runs on Vercel | no | **yes** |
| Good for | continuous bulk intake, thousands of CVs | steady recruiter use, tens to low hundreds of CVs at a time |

**Use `inline` on Vercel.** Measured on the bundled fixtures, one drain call handles two CVs in
about 9 seconds including OCR, so a 100-CV batch finishes in roughly 8 minutes with the tab open.
If you later need heavier throughput, keep the Vercel front end and run the worker on Railway,
Render or Fly.io against the same database, then switch to `queue`.

## 1. Create the database (Neon)

1. Go to <https://neon.tech>, sign up, create a project in a region near you (`ap-south-1` for India).
2. Copy the **pooled** connection string. It looks like
   `postgresql://user:pass@ep-xxx-pooler.ap-south-1.aws.neon.tech/neondb?sslmode=require`.
   The pooled host matters: serverless functions open many short connections.
3. Keep it for step 4 as `DATABASE_URL`.

Supabase, Railway Postgres or any managed Postgres 14+ works equally well. The schema is created
automatically on first deploy by the build command in `vercel.json`.

## 2. Push the code to GitHub

```bash
git remote add origin https://github.com/<you>/cv-parser.git
git push -u origin main
```

`.env` is gitignored, so no secrets leave your machine.

## 3. Import into Vercel

1. <https://vercel.com/new> → import the repository.
2. Framework preset: **Next.js** (detected automatically).
3. Do not deploy yet — add the environment variables first.

## 4. Environment variables

In **Project → Settings → Environment Variables**, add these for Production (and Preview if you
want previews to work):

| Variable | Value |
|---|---|
| `PROCESSING_MODE` | `inline` |
| `DATABASE_URL` | the Neon pooled connection string |
| `APP_URL` | `https://<your-project>.vercel.app` (update after the first deploy if the domain changes) |
| `AUTH_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `CRON_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `ADMIN_EMAIL` | your login email |
| `ADMIN_PASSWORD` | a strong password, 8+ characters |
| `STORAGE_DRIVER` | `vercel-blob` |
| `OCR_CACHE_PATH` | `/tmp/tesseract` (the only writable path on Vercel) |
| `LLM_PROVIDER` | `openai` |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `LLM_API_KEY` | your OpenRouter key |
| `LLM_MODEL` | `meta-llama/llama-3.3-70b-instruct` |

Optional, for Google Drive and Sheets:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `https://<your-project>.vercel.app/api/google-drive/callback` |

Do **not** set `REDIS_URL` in inline mode. Leave it unset.

## 5. Attach a Blob store

**Project → Storage → Create Database → Blob**. Vercel injects `BLOB_READ_WRITE_TOKEN`
automatically, which is what `STORAGE_DRIVER=vercel-blob` reads. Uploaded CVs go there instead of
the filesystem, which on Vercel is wiped between invocations.

## 6. Deploy

Click **Deploy**. The build command in `vercel.json` runs `prisma generate && prisma migrate deploy
&& next build`, so the database schema is created as part of the first deploy.

## 7. Create your login

The admin user is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Run once from your machine,
pointing at the deployed database:

```bash
DATABASE_URL="<your Neon connection string>" ADMIN_EMAIL="you@example.com" ADMIN_PASSWORD="<strong password>" npm run db:seed
```

Then open `https://<your-project>.vercel.app` and sign in.

## 8. Confirm it works

```bash
curl https://<your-project>.vercel.app/api/health
```

Expect `{"ok":true,"db":true,"redis":true,"worker":{"online":true,...}}`. In inline mode `redis`
and `worker` report healthy by design, because neither is a dependency.

Then upload a CV through the UI. A blue "Processing… " bar appears and the row reaches
**Processed** within a few seconds.

## Sharing it with your team

Add each person with `SEED_USERS` and re-run the seed:

```bash
DATABASE_URL="<neon url>" SEED_USERS='[{"email":"hr@yourcompany.com","password":"<strong password>","name":"HR","role":"RECRUITER"}]' npm run db:seed
```

`ADMIN` can change settings; `RECRUITER` can do everything else. There is no public sign-up, which
is deliberate: the app holds candidates' personal data.

## Limits and costs on Vercel

| Concern | Hobby | Pro |
|---|---|---|
| Function duration | 60s (the drain endpoint requests 300s and is capped to the plan limit) | 300s |
| Cron frequency | once per day | as configured (`*/5 * * * *` in `vercel.json`) |
| Upload body size | 4.5 MB per request | 4.5 MB per request |

Two consequences worth planning for:

- **On Hobby the cron only runs daily.** Batches still finish while the tab is open, because the
  browser drives the drain; the cron is the safety net for anything left behind. On Pro it retries
  every 5 minutes.
- **The 4.5 MB request limit** applies to the whole upload request. The upload page already chunks
  large batches, but a single CV over about 4 MB will be rejected. Lower `MAX_FILE_SIZE_MB` to `4`
  to fail early with a clear message.

Running costs: Neon and Vercel Blob both have free tiers that comfortably cover a recruiting team.
The LLM is the only usage-based cost, at roughly $0.15 per 1,000 CVs on the configured model.

## Google Drive on Vercel

Drive sync runs from the cron in inline mode, so new files are picked up on the cron schedule
rather than every 5 minutes. Push notifications work because `APP_URL` is HTTPS. Set the redirect
URI in Google Cloud Console to your Vercel domain — see [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md).

## If you outgrow inline mode

Keep Vercel for the UI and run the worker anywhere that allows a long-lived process:

1. Create an Upstash Redis database, copy its `rediss://` URL.
2. Set `REDIS_URL` on both Vercel and the worker host, and flip `PROCESSING_MODE=queue` on both.
3. Deploy the worker from the same repository with start command `npm run worker`, giving it the
   same `DATABASE_URL`, `LLM_*`, and storage variables.

Nothing else changes: both modes run the identical parsing pipeline.
