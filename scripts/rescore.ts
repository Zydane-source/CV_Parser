/**
 * Re-scores saved benchmark results with the current scoring rules.
 *
 *   npx tsx scripts/rescore.ts
 *
 * Exists so a scoring change can be applied to both engines without re-running
 * the LLM, which costs money and would otherwise discourage fixing the scorer.
 * The stored rows carry each engine's raw answers, so re-scoring is exact.
 */
import fs from "node:fs";
import path from "node:path";
import { getTaxonomy } from "../services/cv-engine/taxonomy";

const DIR = path.resolve("tests/fixtures/benchmark");
const norm = (s: string) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const digits = (s: string) => String(s ?? "").replace(/\D/g, "");
const tax = getTaxonomy();

function rolesMatch(expected: string, actual: string): boolean {
  const a = norm(actual), e = norm(expected);
  if (a === e || a.endsWith(e) || a.includes(e)) return true;
  const ma = tax.match(actual), me = tax.match(expected);
  return Boolean(ma && me && norm(ma.canonical) === norm(me.canonical));
}

interface Row {
  file: string; traits: string[];
  want: { name: string | null; phone: string | null; role: string | null };
  got: { name: string; phone: string; role: string };
  totalMs: number; extractMs: number; needsReview: boolean;
}

type Outcome = "correct" | "wrong" | "missed" | "invented";

function judge(kind: "name" | "phone" | "role", want: string | null, got: string): Outcome {
  const isNotFound = norm(got) === "not found" || !got;
  if (want === null) return isNotFound ? "correct" : "invented";
  if (isNotFound) return "missed";
  if (kind === "phone") return digits(got).endsWith(digits(want).slice(-10)) ? "correct" : "wrong";
  if (kind === "role") return rolesMatch(want, got) ? "correct" : "wrong";
  return norm(got) === norm(want) ? "correct" : "wrong";
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function report(engine: string) {
  const file = path.join(DIR, `results-${engine}.json`);
  if (!fs.existsSync(file)) {
    console.log(`\n(no saved results for "${engine}")`);
    return null;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { rows: Row[] };
  const rows = data.rows;
  const fields = ["name", "phone", "role"] as const;
  const tally: Record<string, Record<Outcome, number>> = {};
  const perRow: boolean[][] = [];

  for (const f of fields) tally[f] = { correct: 0, wrong: 0, missed: 0, invented: 0 };
  for (const r of rows) {
    const oks: boolean[] = [];
    for (const f of fields) {
      const o = judge(f, r.want[f], r.got[f]);
      tally[f][o]++;
      oks.push(o === "correct");
    }
    perRow.push(oks);
  }

  console.log(`\n=== ${engine.toUpperCase()} ===`);
  console.log("  field   accuracy   correct  wrong  missed  invented");
  const acc: Record<string, number> = {};
  for (const f of fields) {
    const t = tally[f];
    const a = t.correct / rows.length;
    acc[f] = a;
    console.log(`  ${f.padEnd(6)}  ${pct(a).padStart(7)}   ${String(t.correct).padStart(7)}  ${String(t.wrong).padStart(5)}  ${String(t.missed).padStart(6)}  ${String(t.invented).padStart(8)}`);
  }
  const all = perRow.filter((o) => o.every(Boolean)).length;
  console.log(`  all three: ${all}/${rows.length} (${pct(all / rows.length)})`);

  // The current-designation-only slice is a labelling judgement call, so report
  // it separately rather than letting it silently move the headline number.
  const co = rows.map((r, i) => ({ r, ok: perRow[i] })).filter((x) => x.r.traits.includes("current_role_only"));
  const coOk = co.filter((x) => x.ok[2]).length;
  console.log(`  of which "current designation only" CVs: role correct ${coOk}/${co.length}`);

  const meanTotal = rows.reduce((a, b) => a + b.totalMs, 0) / rows.length;
  const meanEx = rows.reduce((a, b) => a + b.extractMs, 0) / rows.length;
  console.log(`  mean end-to-end ${meanTotal.toFixed(1)} ms | mean extraction ${meanEx.toFixed(1)} ms`);
  return { acc, all, count: rows.length, meanTotal, meanEx };
}

console.log("Re-scored with taxonomy-aware role matching (fair to both engines).");
const local = report("local");
const legacy = report("legacy");

if (local && legacy) {
  console.log("\n=== HEAD TO HEAD ===");
  console.log("  field       local    legacy(LLM)   delta");
  for (const f of ["name", "phone", "role"] as const) {
    const d = local.acc[f] - legacy.acc[f];
    console.log(`  ${f.padEnd(10)} ${pct(local.acc[f]).padStart(6)}   ${pct(legacy.acc[f]).padStart(9)}   ${(d >= 0 ? "+" : "") + (d * 100).toFixed(1)}pp`);
  }
  const dAll = local.all / local.count - legacy.all / legacy.count;
  console.log(`  all three  ${pct(local.all / local.count).padStart(6)}   ${pct(legacy.all / legacy.count).padStart(9)}   ${(dAll >= 0 ? "+" : "") + (dAll * 100).toFixed(1)}pp`);
  console.log(`  extraction ${local.meanEx.toFixed(1)}ms   ${legacy.meanEx.toFixed(0)}ms        ${(legacy.meanEx / Math.max(local.meanEx, 0.01)).toFixed(0)}x faster`);
}
