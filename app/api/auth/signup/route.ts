import { handler, ok, parseJson } from "@/lib/api";
import { RateLimitError } from "@/lib/errors";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { requestSignup, signupSchema } from "@/backend/signup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/signup { name, companyName, email, password }
 *
 * Emails a verification code to the approval address and returns the request
 * id the code must be entered against. Creates no account by itself.
 */
export const POST = handler(async (req: Request) => {
  // Every request sends an email, so this is throttled harder than login.
  const rl = await rateLimit(`signup:${clientIp(req)}`, 5, 600);
  if (!rl.allowed) throw new RateLimitError("Too many sign-up attempts. Try again in a few minutes.");
  const body = await parseJson(req, signupSchema);
  return ok(await requestSignup(body));
});
