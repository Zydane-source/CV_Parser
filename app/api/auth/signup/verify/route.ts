import { NextResponse } from "next/server";
import { handler, parseJson } from "@/lib/api";
import { createSessionToken, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth";
import { RateLimitError } from "@/lib/errors";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { verifySchema, verifySignup } from "@/backend/signup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/signup/verify { requestId, code }
 *
 * On the right code the client and its administrator are created and signed in
 * straight away — making someone type the password they chose a minute ago
 * would add a step and prove nothing.
 */
export const POST = handler(async (req: Request) => {
  // Per-request attempts are capped in the database; this caps guessing across requests.
  const rl = await rateLimit(`signup-verify:${clientIp(req)}`, 20, 600);
  if (!rl.allowed) throw new RateLimitError("Too many attempts. Try again in a few minutes.");
  const body = await parseJson(req, verifySchema);
  const user = await verifySignup(body);
  const res = NextResponse.json({ user });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(user), sessionCookieOptions());
  return res;
});
