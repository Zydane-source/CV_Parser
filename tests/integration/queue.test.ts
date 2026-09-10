import { describe, it, expect, afterAll } from "vitest";
import { Queue, Worker, UnrecoverableError, type Job } from "bullmq";
import { createRedisConnection, redisHealthy } from "@/lib/redis";
import { cvJobOptions } from "@/services/processing/queue";

/**
 * Real Redis + BullMQ behaviour: bulk processing, retry with backoff, and
 * one failed job never blocking the others. Skipped when Redis is unreachable.
 */
const redisUp = await redisHealthy(2000).catch(() => false);
const d = redisUp ? describe : describe.skip;

const QUEUE = `cvp-test-${Date.now()}`;
const connections: Array<ReturnType<typeof createRedisConnection>> = [];
const conn = () => {
  const c = createRedisConnection();
  connections.push(c);
  return c;
};

afterAll(async () => {
  await Promise.all(connections.map((c) => c.quit().catch(() => undefined)));
});

d("BullMQ queue processing", () => {
  it("processes a bulk batch in parallel; one failing job does not stop the rest", async () => {
    const queue = new Queue(QUEUE, { connection: conn() });
    const done: string[] = [];
    const failed: string[] = [];
    const worker = new Worker(
      QUEUE,
      async (job: Job) => {
        if (job.data.fail) throw new UnrecoverableError(`permanent failure for ${job.data.name}`);
        await new Promise((r) => setTimeout(r, 20));
        return job.data.name;
      },
      { connection: conn(), concurrency: 4 },
    );
    worker.on("completed", (job) => done.push(job.data.name));
    worker.on("failed", (job) => failed.push(job?.data.name));

    const names = Array.from({ length: 30 }, (_, i) => `cv-${i}.pdf`);
    await queue.addBulk(names.map((name, i) => ({ name: "parse", data: { name, fail: i % 10 === 5 }, opts: cvJobOptions(3, 100) })));

    const deadline = Date.now() + 30_000;
    while (done.length + failed.length < 30 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

    expect(done.length).toBe(27);
    expect(failed.sort()).toEqual(["cv-15.pdf", "cv-25.pdf", "cv-5.pdf"]);
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it("retries transient failures with exponential backoff up to the configured max", async () => {
    const q2 = `${QUEUE}-retry`;
    const queue = new Queue(q2, { connection: conn() });
    const attemptsSeen: number[] = [];
    let succeededAt = 0;
    const worker = new Worker(
      q2,
      async (job: Job) => {
        attemptsSeen.push(job.attemptsMade + 1);
        if (job.attemptsMade < 2) throw new Error("temporary network error");
        succeededAt = job.attemptsMade + 1;
      },
      { connection: conn(), concurrency: 1 },
    );
    const opts = cvJobOptions(3, 50);
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: "exponential", delay: 50 });
    await queue.add("parse", { name: "flaky.pdf" }, opts);

    const deadline = Date.now() + 20_000;
    while (!succeededAt && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(attemptsSeen).toEqual([1, 2, 3]);
    expect(succeededAt).toBe(3);

    // Permanent failure: give up after max attempts, never endless retry.
    let failures = 0;
    worker.on("failed", () => failures++);
    await queue.add("parse", { name: "broken.pdf", alwaysFail: true }, cvJobOptions(2, 20));
    const w2deadline = Date.now() + 10_000;
    const failedJobs = async () => (await queue.getJobCounts("failed")).failed;
    while ((await failedJobs()) < 1 && Date.now() < w2deadline) await new Promise((r) => setTimeout(r, 50));
    const job = (await queue.getFailed())[0];
    expect(job?.attemptsMade).toBe(2);

    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });
});
