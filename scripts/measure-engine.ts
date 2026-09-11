/**
 * Footprint of the local engine: cold start, steady-state throughput, memory.
 *
 * These are the numbers that decide whether the engine is viable inside a
 * serverless function, where the process may be cold on every request and the
 * memory ceiling is fixed.
 *
 *   npm run measure:engine
 */
import { performance } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";

const mb = (b: number) => (b / 1048576).toFixed(1);

async function main() {
  const rssStart = process.memoryUsage().rss;

  // Cold start: module load plus the first extraction, which is what pays for
  // parsing the role taxonomy. A warm function never pays this again.
  const t0 = performance.now();
  const { extractLocally, ENGINE_VERSION } = await import("@/services/cv-engine");
  const tImport = performance.now() - t0;

  const sample = [
    "Rahul Sharma",
    "Mobile: +91 70000 07919 | rahul.sharma@example.com",
    "Position Applied For: Java Developer",
    "",
    "OBJECTIVE",
    "To contribute to a growing engineering team.",
    "",
    "EXPERIENCE",
    "Software Engineer, Infosys, 2019-2023",
  ].join("\n");

  const t1 = performance.now();
  extractLocally(sample);
  const tFirst = performance.now() - t1;

  // Steady state.
  const N = 2000;
  const t2 = performance.now();
  for (let i = 0; i < N; i++) extractLocally(sample);
  const perCall = (performance.now() - t2) / N;

  // A real corpus CV, which is longer and messier than the sample above.
  let corpusMs = 0;
  const gt = path.resolve("tests/fixtures/benchmark/ground-truth.json");
  if (await fs.access(gt).then(() => true).catch(() => false)) {
    const { buildDocument } = await import("@/services/cv-engine");
    const long = sample.repeat(12);
    buildDocument(long);
    const t3 = performance.now();
    for (let i = 0; i < 200; i++) extractLocally(long);
    corpusMs = (performance.now() - t3) / 200;
  }

  const rssEnd = process.memoryUsage().rss;
  const heap = process.memoryUsage().heapUsed;

  console.log(`\nLocal engine v${ENGINE_VERSION} footprint\n`);
  console.log(`  module import                 ${tImport.toFixed(1)} ms`);
  console.log(`  first extraction (taxonomy)   ${tFirst.toFixed(1)} ms`);
  console.log(`  steady state, ${N} calls      ${perCall.toFixed(3)} ms/CV`);
  if (corpusMs) console.log(`  long CV (~12x), 200 calls     ${corpusMs.toFixed(3)} ms/CV`);
  console.log(`  RSS before / after            ${mb(rssStart)} MB / ${mb(rssEnd)} MB`);
  console.log(`  engine's share of RSS         ${mb(rssEnd - rssStart)} MB`);
  console.log(`  heap used                     ${mb(heap)} MB`);
  console.log(`  throughput                    ${Math.round(1000 / perCall).toLocaleString()} CVs/second/core\n`);
}

main();
