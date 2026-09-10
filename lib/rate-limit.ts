import { getRedis } from "./redis";

/**
 * Fixed-window rate limiter backed by Redis (shared across instances), with an
 * in-memory fallback if Redis is unavailable so that an infra hiccup never
 * turns into an open door or a hard outage.
 */
const memory = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
}

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const redisKey = `ratelimit:${key}`;
  try {
    const r = getRedis();
    const count = await r.incr(redisKey);
    if (count === 1) await r.expire(redisKey, windowSeconds);
    const ttl = await r.ttl(redisKey);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetInSeconds: Math.max(ttl, 0) };
  } catch {
    const now = Date.now();
    const entry = memory.get(redisKey);
    if (!entry || entry.resetAt < now) {
      memory.set(redisKey, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: limit - 1, resetInSeconds: windowSeconds };
    }
    entry.count += 1;
    return {
      allowed: entry.count <= limit,
      remaining: Math.max(0, limit - entry.count),
      resetInSeconds: Math.ceil((entry.resetAt - now) / 1000),
    };
  }
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
