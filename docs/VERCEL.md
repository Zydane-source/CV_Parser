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

## 1. Database and repository — already done

- **Neon** project `neondb` in **us-east-2**: schema migrated (8 tables, 29 indexes) and the admin
  user seeded. `vercel.json` pins the deployment to `cle1` so the functions sit beside it.
- **GitHub**: <https://github.com/Zydane-source/CV_Parser>, branch `main`.

## 2. Import into Vercel

1. <https://vercel.com/new> → import the repository.
2. Framework preset: **Next.js** (detected automatically).
3. Do not deploy yet — add the environment variables first.

## 3. Environment variables

**Do not use the Environment Variables box on the import screen.** Vercel pre-fills that form with
all ~50 keys from this repo's `.env.example`, and anything you paste is *added* to them rather than
replacing them. Keys then exist twice with different values and Vercel reports
`Environment variable "PROCESSING_MODE" is invalid`. That screen has no bulk-clear.

Do this instead:

1. On the import screen leave Environment Variables **untouched** and click **Deploy**.
2. The first build fails at `prisma migrate deploy` because `DATABASE_URL` is missing. That is
   expected and harmless.
3. Open **Project → Settings → Environment Variables**. This screen does *not* pre-fill from
   `.env.example`.
4. Paste the whole environment file there; Vercel accepts a multi-line `KEY=value` paste.
5. Add one more variable now that you know the domain:
   `APP_URL` = `https://<your-project>.vercel.app`.
6. Go to **Deployments**, open the failed one, and choose **Redeploy**.

Two variables Vercel rejects if you add them by hand:

| Variable | Why |
|---|---|
| `NODE_ENV` | Reserved. Vercel always sets it to `production`. |
| `BLOB_READ_WRITE_TOKEN` | Injected automatically by the attached Blob store. |

For reference, the environment file sets:

| Variable | Value |
|---|---|
| `PROCESSING_MODE` | `inline` |
| `DATABASE_URL` | Neon **pooled** connection string |
| `DIRECT_URL` | Neon **direct** (non-pooled) string, used only for migrations |
| `AUTH_SECRET` | 48 random bytes, base64 |
| `CRON_SECRET` | 32 random bytes, base64url |
| `ADMIN_EMAIL` | your login email |
| `ADMIN_PASSWORD` | a strong password, 8+ characters |
| `MAX_FILE_SIZE_MB` | `4` — Vercel caps request bodies at 4.5 MB |
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

## 4. Blob store — already attached

The `CV_Parser` Blob store is attached, so Vercel injects `BLOB_READ_WRITE_TOKEN` for you — that is
what `STORAGE_DRIVER=vercel-blob` reads. Uploaded CVs go there instead of the filesystem, which on
Vercel is wiped between invocations. Confirm the store is linked to *this* project under
**Project → Storage**; a store attached to a different project will not inject its token here.

## 5. Deploy

Click **Deploy**. The build command in `vercel.json` runs `prisma generate && prisma migrate deploy
&& next build`, so the database schema is created as part of the first deploy.

## 6. Your login — already created

`hello@caller.digital` is already seeded on the Neon database with the password in the environment
file you were given. Open `https://<your-project>.vercel.app` and sign in.

To add or reset a user later, run from your machine against the same database:

```bash
DATABASE_URL="<neon pooled url>" ADMIN_EMAIL="you@example.com" ADMIN_PASSWORD="<strong password>" npm run db:seed
```

## 7. Confirm it works

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

`vercel.json` is committed **configured for Hobby**, because exceeding a plan limit is a hard
deployment failure, not a warning.

| Concern | Hobby (current config) | Pro |
|---|---|---|
| Function duration | 60s | up to 300s |
| Cron frequency | once per day (`0 3 * * *`) | any (`*/5 * * * *`) |
| Function region | default only, so `regions` is omitted | selectable |
| Memory per function | fixed | configurable |
| Upload body size | 4.5 MB per request | 4.5 MB per request |

Consequences worth planning for:

- **The cron only runs daily.** Batches still finish while the tab is open, because the browser
  drives the drain; the cron is only the safety net for anything left behind.
- **The 4.5 MB request limit** applies to the whole upload request, which is why
  `MAX_FILE_SIZE_MB=4` — a larger CV then fails immediately with a clear message instead of a
  confusing platform error.
- **Region.** The default region is `iad1` (Washington DC), one short hop from a Neon `us-east-2`
  project, so the omission costs little. Pairing a database with a distant region is expensive: the
  same 2-CV drain measured 25s across continents versus 9.5s co-located.

### Raising these on Pro

1. In `vercel.json`, set the four `maxDuration` values to `300`, change the cron to `*/5 * * * *`,
   and add `"regions": ["cle1"]` to match a `us-east-2` database.
2. Change `export const maxDuration` to `300` in the four route files under `app/api/`.
3. Raise `DRAIN_BATCH_SIZE` from `2` to about `8` so each invocation earns its cold start.

### `vercel.json` gotcha

That file is validated against a strict schema that rejects unknown properties, and JSON has no
comment syntax. A key like `_comment_regions` fails the deployment with
`Invalid request: should NOT have additional property`. Keep explanations in this document.

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
