import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getUserConnection, disconnect } from "@/services/google-drive/oauth";
import { stopWatch } from "@/services/google-drive/watch";

export const dynamic = "force-dynamic";

/** POST /api/google-drive/disconnect – revoke tokens and deactivate the connection. */
export const POST = handler(async () => {
  const user = await requireUser();
  const conn = await getUserConnection(user.id);
  if (conn) {
    await stopWatch(conn.id).catch(() => undefined);
    await disconnect(conn.id);
  }
  return ok({ disconnected: Boolean(conn) });
});
