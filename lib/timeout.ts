/**
 * Bound a promise that might never settle.
 *
 * Redis commands are the reason this exists, for two independent reasons:
 *
 *   - ioredis with `maxRetriesPerRequest: null` — the setting BullMQ requires —
 *     parks commands in an offline queue indefinitely while disconnected;
 *   - ioredis has no per-command timeout at all, so a command written to a
 *     socket that was accepted but never answers waits forever regardless of
 *     how the client is configured.
 *
 * Either way the promise neither resolves nor rejects, so `try`/`catch` and
 * `.catch()` cannot rescue it. Only a race can.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message = `timed out after ${ms}ms`): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
