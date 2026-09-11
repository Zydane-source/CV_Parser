/**
 * Demonstrates the bug that made the deployed sign-in button hang forever, and
 * that the fix removes it. Run: `npx tsx scripts/demo-redis-hang.ts`
 *
 * The black-hole server accepts the TCP connection and then never answers —
 * what a wrong host, a firewalled port or a dropped tunnel actually looks like.
 * A refused connection would error quickly and was never the dangerous case.
 */
import net from "node:net";
import IORedis from "ioredis";

const PORT = 63898;
const OBSERVE_MS = 8000;

async function race(label: string, p: Promise<unknown>) {
  const started = Date.now();
  const outcome = await Promise.race([
    p.then(() => "resolved").catch((e) => `rejected: ${(e as Error).message}`),
    new Promise<string>((r) => setTimeout(() => r("STILL PENDING"), OBSERVE_MS)),
  ]);
  console.log(`  ${label.padEnd(34)} ${outcome.padEnd(34)} after ${Date.now() - started} ms`);
  return outcome;
}

async function main() {
  const server = net.createServer(() => {});
  const sockets = new Set<net.Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
  console.log(`\nRedis that accepts connections and never replies, on 127.0.0.1:${PORT}\n`);

  // The shared connection as BullMQ requires it.
  const bullmq = new IORedis(`redis://127.0.0.1:${PORT}`, { maxRetriesPerRequest: null, enableReadyCheck: false });
  bullmq.on("error", () => {});

  // The web server's connection: bounded retries, short connect timeout.
  const server_ = new IORedis(`redis://127.0.0.1:${PORT}`, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    connectTimeout: 2000,
    retryStrategy: (times) => Math.min(times * 200, 10_000),
  });
  server_.on("error", () => {});

  console.log(`Awaiting INCR, observing for ${OBSERVE_MS} ms:\n`);
  const a = await race("raw await, BullMQ options", bullmq.incr("demo"));
  const b = await race("raw await, web options", server_.incr("demo"));

  // The fix. Note this is a *race*, not a connection setting: once the socket is
  // accepted, ioredis has no per-command timeout and will wait for a reply that
  // never comes. Tuning retries does not help — only bounding the wait does.
  const c = await race(
    "withRedis (the fix)",
    (async () => {
      const started = Date.now();
      const out = await Promise.race([
        server_.incr("demo"),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`redis timeout after 1500ms`)), 1500)),
      ]).catch(() => null);
      if (out === null && Date.now() - started < 3000) return null;
      throw new Error("not bounded");
    })(),
  );

  console.log(
    `\n  Both raw awaits are still pending: a request awaiting either never returns,\n` +
      `  and the platform eventually kills the function. Connection options do not\n` +
      `  save you here — the socket was accepted, so ioredis is simply waiting for a\n` +
      `  reply. Only the bounded call returns, letting the rate limiter fall back to\n` +
      `  its in-memory window.\n`,
  );

  bullmq.disconnect();
  server_.disconnect();
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
  const correct = a === "STILL PENDING" && b === "STILL PENDING" && c === "resolved";
  process.exit(correct ? 0 : 1);
}

main();
