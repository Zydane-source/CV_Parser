import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import net from "node:net";
import { resetEnvCache } from "@/lib/config";

/**
 * Regression: a request path must never hang because Redis is unreachable.
 *
 * This is not a hypothetical. The deployed app sat on "Signing in…" forever
 * because `rateLimit` — the first thing `/api/auth/login` does — awaited a
 * command on the shared BullMQ connection. BullMQ requires
 * `maxRetriesPerRequest: null`, which tells ioredis never to fail a command for
 * retry exhaustion; combined with infinite reconnection, the command parks in
 * the offline queue and the promise **never settles**. A `try`/`catch` around it
 * cannot help, because nothing is ever thrown.
 *
 * The dangerous case is not a refused connection — that errors quickly. It is a
 * socket that *accepts* and then says nothing, which is what a wrong host, a
 * dropped VPN or a firewalled port looks like. The black-hole server below is
 * exactly that.
 */
const BLACK_HOLE_PORT = 63799;
let blackHole: net.Server;
const sockets = new Set<net.Socket>();

beforeAll(async () => {
  // Accepts the TCP connection, then never responds to a single command.
  blackHole = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => blackHole.listen(BLACK_HOLE_PORT, "127.0.0.1", resolve));
});

afterAll(async () => {
  // The clients under test are still attached, and `close()` waits for open
  // connections — so drop them explicitly rather than hanging the suite.
  disconnectClients();
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((resolve) => blackHole.close(() => resolve()));
});

type RedisGlobals = { redis?: { disconnect(): void }; serverRedis?: { disconnect(): void } | null };

function disconnectClients() {
  const g = globalThis as unknown as RedisGlobals;
  g.redis?.disconnect();
  g.serverRedis?.disconnect();
  delete g.redis;
  delete g.serverRedis;
}

beforeEach(() => {
  // Each case sets its own REDIS_URL, so the memoised clients must go too.
  disconnectClients();
  resetEnvCache();
});

describe("rate limiting when Redis does not answer", () => {
  it("falls back to the in-memory window instead of hanging", async () => {
    process.env.REDIS_URL = `redis://127.0.0.1:${BLACK_HOLE_PORT}`;
    process.env.PROCESSING_MODE = "queue";
    resetEnvCache();
    const { rateLimit } = await import("@/lib/rate-limit");

    const started = Date.now();
    const r = await rateLimit(`test-hang-${Date.now()}`, 5, 60);
    const elapsed = Date.now() - started;

    expect(r.allowed).toBe(true);
    // The bounded path is 1.5s; anything near a platform timeout is the bug back.
    expect(elapsed).toBeLessThan(5000);
  }, 20000);

  it("still enforces the limit while Redis is unavailable", async () => {
    process.env.REDIS_URL = `redis://127.0.0.1:${BLACK_HOLE_PORT}`;
    process.env.PROCESSING_MODE = "queue";
    resetEnvCache();
    const { rateLimit } = await import("@/lib/rate-limit");

    const key = `test-limit-${Date.now()}`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit(key, 2, 60));

    // Degrading to a per-instance counter must not become an open door.
    expect(results.map((r) => r.allowed)).toEqual([true, true, false, false]);
  }, 30000);
});

describe("worker health when Redis does not answer", () => {
  it("reports no workers promptly rather than blocking the jobs API", async () => {
    process.env.REDIS_URL = `redis://127.0.0.1:${BLACK_HOLE_PORT}`;
    process.env.PROCESSING_MODE = "queue";
    resetEnvCache();
    const { getWorkerHealth } = await import("@/lib/worker-health");

    const started = Date.now();
    const health = await getWorkerHealth();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(health.online).toBe(false);
    expect(health.count).toBe(0);
  }, 20000);
});

describe("isRedisConfigured", () => {
  it("declines a loopback URL on a serverless platform", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.PROCESSING_MODE = "queue";
    process.env.VERCEL = "1";
    resetEnvCache();
    const { isRedisConfigured } = await import("@/lib/redis");
    // Vercel pre-fills its env-var import form from .env.example, which carries
    // exactly this URL. Nothing listens on a function's own localhost.
    expect(isRedisConfigured()).toBe(false);
    delete process.env.VERCEL;
  });

  it("declines inline mode with no explicit REDIS_URL", async () => {
    delete process.env.REDIS_URL;
    process.env.PROCESSING_MODE = "inline";
    resetEnvCache();
    const { isRedisConfigured } = await import("@/lib/redis");
    expect(isRedisConfigured()).toBe(false);
  });

  it("accepts a real host in queue mode", async () => {
    process.env.REDIS_URL = "redis://redis.internal:6379";
    process.env.PROCESSING_MODE = "queue";
    delete process.env.VERCEL;
    resetEnvCache();
    const { isRedisConfigured } = await import("@/lib/redis");
    expect(isRedisConfigured()).toBe(true);
  });
});
