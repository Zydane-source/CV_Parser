# Google Cloud setup (Drive + Sheets + OAuth 2.0)

The Google Drive integration and the Google Sheets export both use **one OAuth 2.0 client** and the signed-in
recruiter's Google account. Nothing here requires a service account. Estimated time: 10 minutes.

## 1. Create or select a Google Cloud project

1. Open <https://console.cloud.google.com/>.
2. Project picker (top bar) → **New project** → name it e.g. `cv-parser` → **Create**.
   Or select an existing project you own.

## 2. Enable the Google Drive API

1. **APIs & Services → Library**.
2. Search **Google Drive API** → **Enable**.

## 3. Enable the Google Sheets API

1. **APIs & Services → Library**.
2. Search **Google Sheets API** → **Enable**.

## 4. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen** (in newer consoles: **Google Auth Platform → Branding**).
2. User type: **External** (or **Internal** if your organisation uses Google Workspace and only staff will connect).
3. App name: `CV Parser`. User support email + developer contact: your email. **Save**.
4. **Scopes → Add or remove scopes** and add exactly these (minimum needed):

   | Scope | Why |
   |---|---|
   | `https://www.googleapis.com/auth/drive.readonly` | List and download CVs from the selected folder. Read-only: the app never modifies or deletes Drive files. |
   | `https://www.googleapis.com/auth/spreadsheets` | Create / write the export spreadsheet. |
   | `https://www.googleapis.com/auth/userinfo.email` | Show which Google account is connected. |

   `drive.readonly` is a *sensitive* scope. While the app is in **Testing** it works for listed test users
   without review. Publishing to all users requires Google's verification (see §9).

## 5. Create OAuth credentials

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**. Name: `CV Parser Web`.
3. **Authorised JavaScript origins**: `http://localhost:3000` (dev) and your production origin, e.g. `https://cv.example.com`.
4. **Authorised redirect URIs** – see §6.
5. **Create** → copy the **Client ID** and **Client secret** into `.env`:

   ```env
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

## 6. Configure the redirect URI

The app's callback route is `/api/google-drive/callback`. Add **every** environment you use:

```text
http://localhost:3000/api/google-drive/callback
https://cv.example.com/api/google-drive/callback
```

and set the same value in `.env`:

```env
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google-drive/callback   # dev
GOOGLE_REDIRECT_URI=https://cv.example.com/api/google-drive/callback  # prod
```

If `GOOGLE_REDIRECT_URI` is blank the app derives it from `APP_URL`. A mismatch produces Google's
`redirect_uri_mismatch` error – the URI must match character-for-character.

## 7. Scopes in the app

The scopes requested at sign-in are defined in `services/google-drive/oauth.ts` (`GOOGLE_SCOPES`) and must be a
subset of what you added in §4. The app requests `access_type=offline` + `prompt=consent` so a **refresh token**
is issued; tokens are stored encrypted (AES-256-GCM) and refreshed automatically.

## 8. Add test users (Testing mode)

While the consent screen is in **Testing**:

1. **OAuth consent screen → Test users → Add users**.
2. Add the Google accounts of every recruiter who will click **Connect Google Drive** (max 100).
3. Accounts not on this list get `Error 403: access_denied`.

Refresh tokens issued in Testing mode expire after **7 days**; users must reconnect. Publish the app (§9) to remove
that limit.

## 9. Production OAuth

1. **OAuth consent screen → Publish app**.
2. Because `drive.readonly` is a sensitive scope, submit the app for **verification** (privacy policy URL, homepage,
   a short video of the consent flow). Until verified, users see an "unverified app" warning but can proceed via
   *Advanced → Go to CV Parser (unsafe)*; Google Workspace admins can also mark the app trusted for their domain.
3. Use an HTTPS `APP_URL`. This also enables **Drive push notifications** (`changes.watch`) so new CVs are detected
   within seconds instead of at the next poll. Google only delivers webhooks to public HTTPS endpoints; the domain
   does not need to be verified in Search Console for `changes.watch` when using the default settings.
4. Rotate the client secret if it was ever committed or shared; update `.env` and restart web + worker.

## 10. Connect and select a folder

1. Start the app, sign in, open **Google Drive → Connect Google Drive**.
2. Approve the consent screen. You are returned to the app with **Connected**.
3. **Select Folder** → browse *My Drive* (or search) → **Select**. A full sync is queued immediately.
4. From then on the worker polls every `GOOGLE_DRIVE_SYNC_INTERVAL_MINUTES` (default 5) using the Drive
   **Changes API** and, on HTTPS deployments, also receives push notifications. Files added later
   (e.g. `Candidate_C.pdf`) are picked up automatically.

Optional defaults: `GOOGLE_DRIVE_FOLDER_ID` pre-selects a folder after connecting; `GOOGLE_SHEETS_SPREADSHEET_ID`
makes every export add a new tab to that spreadsheet instead of creating a new file.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `redirect_uri_mismatch` | Redirect URI in the console ≠ `GOOGLE_REDIRECT_URI` / `APP_URL`. Copy it exactly (scheme, host, port, path). |
| `access_denied` (403) during consent | Account is not a test user (§8) or the app is not published. |
| `invalid_grant` when syncing | Refresh token expired (Testing mode 7-day limit) or revoked → click **Disconnect**, then **Connect** again. |
| Connected but folder list empty | The account has no folders at that level; use **Search folders** or check Shared Drives access. |
| Files not detected | File type must be PDF/DOC/DOCX/JPG/PNG/WEBP or a Google Doc; files in sub-folders are not included (select the sub-folder). |
| Export fails with 403 | The Sheets API is not enabled (§3) or the `spreadsheets` scope was not granted – disconnect and reconnect. |
