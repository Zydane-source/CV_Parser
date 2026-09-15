import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { env } from "@/lib/config";
import { logger } from "@/lib/logger";
import { errorMessage } from "@/lib/errors";
import { effectiveProcessingMode } from "@/lib/processing-mode";
import { recoverStaleJobs } from "./drain";

/**
 * Background processing on a platform with no always-on worker.
 *
 * Before this, CVs were processed only while a signed-in browser tab kept
 * calling the drain endpoint, and the only server-side fallback was a cron the
 * Vercel Hobby plan runs once a day. Close the tab and a batch waited until 3am.
 *
 * A *chain* is a sequence of drain invocations, each started by the one before:
 * a link answers its request at once, processes CVs for most of its time limit
 * in the background, and — if work remains — starts the next link with a request
 * to itself. Nothing depends on a browser, and every link is a fresh invocation
 * well inside the 60s limit.
 *
 * Chains are capped (DRAIN_BACKGROUND_CHAINS). Each one ends by itself when the
 * queue is empty, and starts a single successor at most, so chains never
 * multiply; the cap bounds how many kicks can add. The count lives in a Setting
 * row as heartbeats. It is read-modify-write rather than atomic, so two kicks in
 * the same instant can overshoot the cap by one — harmless, because claiming a
 * CV is atomic and an extra chain just finds less to do.
 */

const CHAINS_KEY = "drain:chains";
/** A chain that has not reported in this long is gone. A link lasts ≤ 60s. */
const HEARTBEAT_TTL_MS = 90_000;

type Beats = Record<string, number>;

async function readBeats(): Promise<Beats> {
  const row = await prisma.setting.findUnique({ where: { key: CHAINS_KEY } });
  const raw = (row?.value ?? {}) as Beats;
  const now = Date.now();
  return Object.fromEntries(Object.entries(raw).filter(([, t]) => typeof t === "number" && now - t < HEARTBEAT_TTL_MS));
}

async function writeBeats(beats: Beats) {
  await prisma.setting.upsert({ where: { key: CHAINS_KEY }, create: { key: CHAINS_KEY, value: beats }, update: { value: beats } });
}

export async function beat(chainId: string) {
  const beats = await readBeats();
  beats[chainId] = Date.now();
  await writeBeats(beats);
}

export async function endChain(chainId: string) {
  const beats = await readBeats();
  delete beats[chainId];
  await writeBeats(beats);
}

export async function activeChains(): Promise<number> {
  return Object.keys(await readBeats()).length;
}

/** Background chains need a way to authorise calls to ourselves. */
export function backgroundAvailable(): boolean {
  return effectiveProcessingMode() === "inline" && Boolean(env().CRON_SECRET);
}

/**
 * Ask a new drain link to start. The target replies 202 straight away and does
 * its work after responding, so this returns in about a cold start.
 */
export async function startLink(origin: string, chainId: string, idle = 0): Promise<boolean> {
  const url = `${origin.replace(/\/+$/, "")}/api/jobs/drain?background=1&chain=${encodeURIComponent(chainId)}&idle=${idle}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${env().CRON_SECRET}`, origin },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 202) return true;
      logger.warn({ status: res.status, attempt }, "background: link refused");
    } catch (err) {
      logger.warn({ attempt, err: errorMessage(err) }, "background: could not start link");
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return false;
}

export interface KickResult {
  background: boolean;
  pending: number;
  active: number;
  started: number;
}

/**
 * Make sure pending CVs are being worked on: start chains up to the cap.
 *
 * Safe to call as often as you like — from every upload, every sync, and a
 * browser that checks in every few seconds — because it only adds chains while
 * there is both work waiting and room under the cap.
 */
export async function kickBackgroundDrain(origin: string, reason: string): Promise<KickResult> {
  if (!backgroundAvailable()) return { background: false, pending: 0, active: 0, started: 0 };
  // CVs stranded in PROCESSING by a killed invocation are not PENDING, so without
  // this a kick would see nothing to do and they would stay stuck.
  await recoverStaleJobs().catch(() => 0);
  const [pending, active] = await Promise.all([prisma.processingJob.count({ where: { status: "PENDING" } }), activeChains()]);
  const max = Math.max(1, env().DRAIN_BACKGROUND_CHAINS);
  // Roughly one chain per 10 waiting CVs, never beyond the cap.
  const wanted = pending === 0 ? 0 : Math.min(max - active, Math.ceil(pending / 10));
  let started = 0;
  for (let i = 0; i < wanted; i++) {
    const chainId = randomUUID();
    // Reserve the slot before the request, so a kick racing this one counts it.
    await beat(chainId);
    if (await startLink(origin, chainId)) started++;
    else await endChain(chainId);
  }
  if (started) logger.info({ reason, pending, active, started }, "background: chains started");
  return { background: true, pending, active: active + started, started };
}

/**
 * From a route handler: start background processing once the response is sent.
 * The caller's response is never delayed or failed by it.
 */
export function kickAfterResponse(req: Request, reason: string): void {
  if (!backgroundAvailable()) return;
  const origin = new URL(req.url).origin;
  after(() => kickBackgroundDrain(origin, reason).then(() => undefined, (err) => logger.warn({ reason, err: errorMessage(err) }, "background: kick failed")));
}
