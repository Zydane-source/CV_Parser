import { NextResponse } from "next/server";
import { z } from "zod";
import { handler, parseJson } from "@/lib/api";
import { authenticate, createSessionToken, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth";
import { AuthError, RateLimitError } from "@/lib/errors";
import { rateLimit, clientIp } from "@/lib/rate-limit";

/**
 * The identifier is whatever the administrator set when seeding the account. It
 * is usually an email but a bare username such as "admin" is equally valid, so
 * this validates shape and length rather than email syntax. Accounts are only
 * ever created by an administrator; there is no public sign-up.
 */
const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter your email or username")
    .max(200)
    .regex(/^[^\s]+$/, "Must not contain spaces"),
  password: z.string().min(1).max(200),
});

export const POST = handler(async (req: Request) => {
  const rl = await rateLimit(`login:${clientIp(req)}`, 10, 60);
  if (!rl.allowed) throw new RateLimitError("Too many login attempts. Try again in a minute.");

  const { email, password } = await parseJson(req, schema);
  const user = await authenticate(email, password);
  if (!user) throw new AuthError("Invalid credentials");

  const token = await createSessionToken(user);
  const res = NextResponse.json({ user });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
});
