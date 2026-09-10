import IORedis from "ioredis";
import { env } from "./config";

/**
 * Shared Redis connection factory. BullMQ requires `maxRetriesPerRequest: null`.
 * The Next.js server keeps one lazily created connection for enqueueing + rate limiting;
 * the worker process creates its own.
 */
const globalForRedis = globalThis as unknown as { redis?: IORedis };

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

export async function redisHealthy(timeoutMs = 1500): Promise<boolean> {
  try {
    const r = getRedis();
    const pong = await Promise.race([r.ping(), new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    return pong === "PONG";
  } catch {
    return false;
  }
}
