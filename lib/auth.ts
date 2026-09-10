import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import type { UserRole } from "@prisma/client";
import { env } from "./config";
import { prisma } from "./db";
import { AuthError, ForbiddenError } from "./errors";

export const SESSION_COOKIE = "cvp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

function secretKey(): Uint8Array {
  const s = env().AUTH_SECRET;
  if (!s || s.length < 16) throw new Error("AUTH_SECRET must be set (16+ chars)");
  return new TextEncoder().encode(s);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer("cv-parser")
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: "cv-parser" });
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      email: String(payload.email ?? ""),
      name: String(payload.name ?? ""),
      role: (payload.role as UserRole) ?? "RECRUITER",
    };
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env().APP_URL.startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/** Read the current session from cookies (server components / route handlers). */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/** Require an authenticated user; throws AuthError (401) otherwise. */
export async function requireUser(): Promise<SessionUser> {
  const s = await getSession();
  if (!s) throw new AuthError();
  return s;
}

/** Require the ADMIN role. */
export async function requireAdmin(): Promise<SessionUser> {
  const s = await requireUser();
  if (s.role !== "ADMIN") throw new ForbiddenError("Admin role required");
  return s;
}

export async function authenticate(email: string, password: string): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) {
    // Constant-time-ish: still run a hash compare to avoid user enumeration timing.
    await bcrypt.compare(password, "$2a$12$CwTycUXWue0Thq9StjUM0uJ8Z6xjEuqgWDjQ7iCq4x4ZgQ7cQ9KXe");
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
