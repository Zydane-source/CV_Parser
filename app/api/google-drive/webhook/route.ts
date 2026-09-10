import { NextResponse } from "next/server";
import { resolveWebhookConnection } from "@/services/google-drive/watch";
import { getDriveSyncQueue } from "@/services/processing/queue";
import { logger } from "@/lib/logger";

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

  try {
    await getDriveSyncQueue().add(
      "webhook",
      { connectionId: conn.id, reason: "webhook" },
      { jobId: `webhook-${conn.id}-${Math.floor(Date.now() / 5000)}`, delay: 2000 },
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Failed to queue webhook sync");
    return new NextResponse(null, { status: 500 });
  }
  return new NextResponse(null, { status: 200 });
}
