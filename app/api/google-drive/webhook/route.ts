import { NextResponse } from "next/server";
import { resolveWebhookConnection } from "@/services/google-drive/watch";
import { triggerDriveSync } from "@/services/google-drive/trigger";

export const dynamic = "force-dynamic";

/**
 * POST /api/google-drive/webhook – Google Drive push notification receiver.
 * Public endpoint (Google calls it); authenticated by the per-channel secret
 * token we generated when registering the watch. On a valid "change"
 * notification we queue an incremental sync (debounced per connection).
 */
export async function POST(req: Request) {
  const channelId = req.headers.get("x-goog-channel-id");
  const token = req.headers.get("x-goog-channel-token");
  const state = req.headers.get("x-goog-resource-state");

  const conn = await resolveWebhookConnection(channelId, token);
  if (!conn) return NextResponse.json({ error: "Unknown channel" }, { status: 404 });

  if (state === "sync") return new NextResponse(null, { status: 200 }); // initial handshake

  // Never fail the webhook on a sync problem: Google retries on a non-2xx, so a
  // broken folder would become a retry storm. triggerDriveSync records the
  // reason against the connection for the UI to show.
  await triggerDriveSync(conn.id, "webhook");
  return new NextResponse(null, { status: 200 });
}
