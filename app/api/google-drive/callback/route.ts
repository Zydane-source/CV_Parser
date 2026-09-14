import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { env } from "@/lib/config";
import { logger } from "@/lib/logger";
import { errorMessage } from "@/lib/errors";
import { completeOAuth, verifyOAuthState } from "@/services/google-drive/oauth";
import { getSettings } from "@/lib/settings";
import { prisma } from "@/lib/db";
import { getFolderPath } from "@/services/google-drive/files";

export const dynamic = "force-dynamic";

/** GET /api/google-drive/callback?code=&state= – OAuth redirect target. */
/**
 * Turn Google's terse OAuth error code into something actionable.
 *
 * `access_denied` is the one worth spelling out: it means either that the
 * person pressed Cancel, or — far more often during setup — that the OAuth
 * consent screen is still in Testing and the Google account is not on its test
 * user list. Those need opposite responses, and "Google returned: access_denied"
 * points at neither.
 */
function describeOAuthError(code: string): string {
  switch (code) {
    case "access_denied":
      return (
        "Google refused the connection. Either permission was declined, or the OAuth consent screen is still in " +
        "Testing and this Google account is not listed under Test users. Add the account in Google Cloud " +
        "(Google Auth Platform → Audience → Test users), or publish the app, then try again."
      );
    case "admin_policy_enforced":
      return "A Google Workspace policy blocks this app. A Workspace administrator has to allow it before Drive can be connected.";
    case "org_internal":
      return "This OAuth client only accepts accounts inside its own organisation. Sign in with an account from that organisation, or set the consent screen audience to External.";
    default:
      return `Google refused the connection (${code}). Check the OAuth client and consent screen in Google Cloud, then try again.`;
  }
}

export async function GET(req: Request) {
  const appUrl = env().APP_URL.replace(/\/+$/, "");
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const back = (params: Record<string, string>) => {
    const u = new URL(`${appUrl}/google-drive`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return NextResponse.redirect(u);
  };

  if (error) return back({ error: describeOAuthError(error) });
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${appUrl}/login?next=/google-drive`);
  if (!code || !state || !(await verifyOAuthState(state, session.id))) return back({ error: "Invalid OAuth state. Please try connecting again." });

  try {
    const conn = await completeOAuth(code, session.id);
    // Pre-select the default folder from settings/env if none is chosen yet.
    const settings = await getSettings();
    if (!conn.folderId && settings.driveFolderId) {
      try {
        const info = await getFolderPath(conn.id, settings.driveFolderId);
        await prisma.googleDriveConnection.update({
          where: { id: conn.id },
          data: { folderId: settings.driveFolderId, folderName: info.name, folderPath: info.path, startPageToken: null },
        });
      } catch (err) {
        logger.warn({ err: errorMessage(err) }, "Default Drive folder could not be resolved");
      }
    }
    return back({ connected: "1" });
  } catch (err) {
    logger.error({ err: errorMessage(err) }, "Google OAuth callback failed");
    return back({ error: `Could not complete Google sign-in: ${errorMessage(err)}` });
  }
}
