import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * Edge middleware:
 *  - Authentication gate for all pages and API routes (except the public allow-list).
 *  - CSRF protection: state-changing API requests must originate from our own origin
 *    (Sec-Fetch-Site / Origin check) in addition to the SameSite=Lax session cookie.
 *  - Security headers.
 */
const SESSION_COOKIE = "cvp_session";

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/health", "/api/google-drive/webhook"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return pathname.startsWith("/_next/") || pathname === "/favicon.ico" || pathname.startsWith("/public/");
}

async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(secret), { issuer: "cv-parser" });
    return true;
  } catch {
    return false;
  }
}

function sameOrigin(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return true;
}

function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return res;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);

  if (isApi && mutating && !sameOrigin(req)) {
    return NextResponse.json({ error: "Cross-site request rejected", code: "CSRF" }, { status: 403 });
  }

  if (isPublic(pathname)) return withSecurityHeaders(NextResponse.next());

  const authed = await hasValidSession(req);
  if (!authed) {
    if (isApi) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)"],
};
