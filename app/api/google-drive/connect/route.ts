import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { createOAuthState, generateAuthUrl } from "@/services/google-drive/oauth";

export const dynamic = "force-dynamic";

/** POST /api/google-drive/connect – returns the Google OAuth consent URL to redirect to. */
export const POST = handler(async () => {
  const user = await requireUser();
  const state = await createOAuthState(user.id);
  return ok({ url: generateAuthUrl(state) });
});
