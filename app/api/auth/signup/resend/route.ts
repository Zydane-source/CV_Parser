import { z } from "zod";
import { handler, ok, parseJson } from "@/lib/api";
import { RateLimitError } from "@/lib/errors";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { resendSignupCode } from "@/backend/signup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/auth/signup/resend { requestId } – send a fresh code (60s cooldown per request). */
export const POST = handler(async (req: Request) => {
  const rl = await rateLimit(`signup-resend:${clientIp(req)}`, 5, 600);
  if (!rl.allowed) throw new RateLimitError("Too many code requests. Try again in a few minutes.");
  const { requestId } = await parseJson(req, z.object({ requestId: z.string().min(1).max(64) }));
  return ok(await resendSignupCode(requestId));
});
