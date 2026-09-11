import { getRedis, withRedis } from "./redis";

/**
 * Worker liveness via Redis heartbeats.
 *
 * The web process cannot see the worker process, so a crashed/never-started
 * worker used to look exactly like "jobs are still queued". Each worker writes
 * a short-TTL key every HEARTBEAT_INTERVAL_MS; the UI reads them and warns when
 * no worker is alive instead of leaving CVs silently Pending.
 */
export const HEARTBEAT_PREFIX = "cvparser:worker:heartbeat:";
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TTL_SECONDS = 20;

export interface WorkerHeartbeat {
  id: string;
  pid: number;
  host: string;
  startedAt: string;
  concurrency: number;
  llm: { provider: string; model: string; keyConfigured: boolean; lastError: string | null };
  updatedAt: string;
}

export interface WorkerHealth {
  online: boolean;
  count: number;
  workers: WorkerHeartbeat[];
  /** Present when a worker reported an unrecoverable configuration problem. */
  configError: string | null;
}

/** Called by the worker process. */
export async function writeHeartbeat(payload: Omit<WorkerHeartbeat, "updatedAt">): Promise<void> {
  const redis = getRedis();
  const body: WorkerHeartbeat = { ...payload, updatedAt: new Date().toISOString() };
  await redis.set(`${HEARTBEAT_PREFIX}${payload.id}`, JSON.stringify(body), "EX", HEARTBEAT_TTL_SECONDS);
}

export async function clearHeartbeat(id: string): Promise<void> {
  try {
    await getRedis().del(`${HEARTBEAT_PREFIX}${id}`);
  } catch {
    /* shutting down anyway */
  }
}

const NO_WORKERS: WorkerHealth = { online: false, count: 0, workers: [], configError: null };

/**
 * Called by the web process (health endpoint, jobs API, SSE stream).
 *
 * Goes through `withRedis` rather than awaiting the BullMQ connection directly:
 * on a deployment with no Redis, the raw call parks forever and takes four API
 * routes down with it. "We cannot prove a worker is alive" is the right answer
 * and it must arrive promptly.
 */
export async function getWorkerHealth(): Promise<WorkerHealth> {
  const result = await withRedis(async (redis) => {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", `${HEARTBEAT_PREFIX}*`, "COUNT", 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");

    if (keys.length === 0) return NO_WORKERS;

    const values = await redis.mget(...keys);
    const workers: WorkerHeartbeat[] = [];
    for (const v of values) {
      if (!v) continue;
      try {
        workers.push(JSON.parse(v) as WorkerHeartbeat);
      } catch {
        /* ignore malformed entry */
      }
    }
    const configError = workers.find((w) => w.llm.lastError)?.llm.lastError ?? null;
    return { online: workers.length > 0, count: workers.length, workers, configError };
  });
  return result ?? NO_WORKERS;
}
