import IORedis from "ioredis";
import { env } from "./config";

/**
 * Shared Redis connection factory.
 *
 * BullMQ requires `maxRetriesPerRequest: null`, which tells ioredis to never
 * fail a command because of retry exhaustion. Combined with ioredis's default
 * infinite reconnect, that means a command issued while Redis is unreachable
 * **neither resolves nor rejects** — it waits in the offline queue forever.
 *
 * That is correct for a worker, whose whole job is to wait for the queue. It is
 * catastrophic for the web server, where it turns a missing Redis into a request
 * that hangs until the platform kills it. `await` on such a command cannot be
 * rescued by try/catch, because nothing ever throws.
 *
 * So there are two connections with different contracts:
 *
 *   getRedis()        BullMQ semantics. Queues and the worker. Waits forever.
 *   withRedis(fn)     Web-server semantics. Bounded, never throws, returns null
 *                     when Redis is absent, unreachable or slow.
 *
 * Anything on a request path must use `withRedis` and have a working fallback.
 */
const globalForRedis = globalThis as unknown as { redis?: IORedis; serverRedis?: IORedis | null };

export function createRedisConnection(): IORedis {
  return new IORedis(env().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

export function getRedis(): IORedis {
  if (!globalForRedis.redis) {
    globalForRedis.redis = createRedisConnection();
    globalForRedis.redis.on("error", (err) => {
      // Avoid crashing the process on transient Redis hiccups; BullMQ reconnects.
      console.error("[redis] connection error:", err.message);
    });
  }
  return globalForRedis.redis;
}

/** A URL pointing at the machine the code is running on. */
const LOOPBACK = /^rediss?:\/\/(?:[^@/]*@)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::|\/|$)/i;

/**
 * Whether it is worth talking to Redis at all from the web server.
 *
 * Two cases deliberately answer "no":
 *
 *   - `PROCESSING_MODE=inline` with no explicit `REDIS_URL`. Inline mode exists
 *     precisely because the platform cannot run a long-lived queue consumer, so
 *     the config default (localhost) is not a real Redis — it is a placeholder.
 *
 *   - A loopback URL on a serverless platform. Nothing is listening on the
 *     function's own localhost. This is a likely misconfiguration rather than an
 *     exotic one: Vercel pre-fills its environment-variable import form from
 *     `.env.example`, which carries `REDIS_URL=redis://localhost:6379`.
 */
export function isRedisConfigured(): boolean {
  const url = env().REDIS_URL;
  if (!url) return false;
  if (env().PROCESSING_MODE === "inline" && !process.env.REDIS_URL) return false;
  if (LOOPBACK.test(url) && (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)) return false;
  return true;
}

/**
 * The web server's connection.
 *
 * `maxRetriesPerRequest: 2` makes a command fail while the client is
 * *disconnected*, instead of parking it in the offline queue. That covers a
 * refused connection, but not the nastier case: a socket that is accepted and
 * then never answers (wrong host, firewalled port, dropped tunnel). ioredis has
 * no per-command timeout, so a command written to a live-but-silent socket waits
 * for a reply indefinitely. **That is why every caller must go through
 * `withRedis`** — the race is what actually bounds the wait; these options only
 * shorten the easy cases.
 *
 * The reconnect strategy backs off but never gives up. Ending reconnection
 * would be tidier for a permanently dead Redis, but this client is memoised for
 * the life of the process, so a brief outage would disable Redis until the next
 * restart.
 */
function getServerRedis(): IORedis | null {
  if (globalForRedis.serverRedis !== undefined) return globalForRedis.serverRedis;
  if (!isRedisConfigured()) {
    globalForRedis.serverRedis = null;
    return null;
  }
  const client = new IORedis(env().REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    connectTimeout: 2000,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 10_000),
  });
  client.on("error", (err) => {
    console.error("[redis] server connection error:", err.message);
  });
  globalForRedis.serverRedis = client;
  return client;
}

/**
 * Run a Redis operation from a request path. Returns `null` — never throws and
 * never hangs — when Redis is unconfigured, unreachable, or slower than
 * `timeoutMs`. The caller must treat `null` as "Redis did not answer" and carry
 * on; every caller here has a local fallback.
 */
export async function withRedis<T>(fn: (redis: IORedis) => Promise<T>, timeoutMs = 1500): Promise<T | null> {
  const client = getServerRedis();
  if (!client) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(client),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`redis timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function redisHealthy(timeoutMs = 1500): Promise<boolean> {
  const pong = await withRedis((r) => r.ping(), timeoutMs);
  return pong === "PONG";
}
