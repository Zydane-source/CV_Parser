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

  if (error) return back({ error: `Google returned: ${error}` });
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
