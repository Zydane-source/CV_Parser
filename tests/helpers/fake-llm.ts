import type { LLMProvider, LLMRequestOptions, LLMResponse } from "@/services/llm/types";

/**
 * TEST-ONLY LLM provider. Production always uses a real provider; this exists so
 * the pipeline (extraction → OCR → normalisation → validation → persistence) can
 * be exercised deterministically without network access.
 *
 *  - ScriptedLLM: returns exactly what the test says (to test validation paths).
 *  - HeuristicLLM: a tiny rule-based "model" that reads the prompt's CV text and
 *    extracts fields the way a well-behaved model would, so layout/OCR tests can
 *    assert end-to-end results.
 */
export class ScriptedLLM implements LLMProvider {
  readonly name = "openai" as const;
  calls: LLMRequestOptions[] = [];
  constructor(private responses: Array<Partial<LLMResponse["extraction"]> | Error>) {}
  async extract(opts: LLMRequestOptions): Promise<LLMResponse> {
    this.calls.push(opts);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    const extraction = {
      candidate_name: "Not Found",
      phone_number: "Not Found",
      job_role_applied_for: "Not Found",
      confidence: { candidate_name: 0, phone_number: 0, job_role_applied_for: 0 },
      ...(next ?? {}),
    };
    return { extraction, model: "scripted-test-model", raw: JSON.stringify(extraction) };
  }
}

export class HeuristicLLM implements LLMProvider {
  readonly name = "openai" as const;
  calls = 0;
  async extract(opts: LLMRequestOptions): Promise<LLMResponse> {
    this.calls++;
    const text = opts.prompt.split("CV TEXT:").pop() ?? "";
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    // Name: first line that looks like a person name (2-3 capitalised words, no digits/@).
    let name = "Not Found";
    let nameConf = 0;
    const HEADINGS = /^(curriculum vitae|resume|cv|contact|skills|personal details|profile|summary|objective|career objective|experience|work history|education|bio ?data|references?|declaration)$/i;
    // Explicit "Name: ..." label wins (tables / bio-data layouts).
    for (const l of lines.slice(0, 20)) {
      const m = l.match(/^name\s*[:|-]?\s*([A-Za-z][A-Za-z .'-]+)$/i);
      if (m) {
        name = m[1].trim();
        nameConf = 0.95;
        break;
      }
    }
    if (name === "Not Found") {
      for (const l of lines.slice(0, 20)) {
        const clean = l.replace(/\|.*$/, "").trim();
        if (HEADINGS.test(clean)) continue;
        if (/^[A-Za-z][A-Za-z.'-]+(\s+[A-Za-z][A-Za-z.'-]+){1,2}$/.test(clean) && !/@|\d/.test(clean)) {
          name = clean;
          nameConf = 0.95;
          break;
        }
      }
    }

    // Phone: prefer a line mentioning mobile/phone/contact that is not in a references section.
    let phone = "Not Found";
    let phoneConf = 0;
    const refIdx = lines.findIndex((l) => /^references?$/i.test(l));
    const scope = refIdx > 0 ? lines.slice(0, refIdx) : lines;
    const phoneRe = /(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\b0?[6-9]\d{9}\b/;
    for (const l of scope) {
      if (/mobile|phone|contact|cell|\bph\b/i.test(l) && !/alternate|home|office|landline/i.test(l.split("|")[0])) {
        const m = l.split(/\|/)[0].match(phoneRe) ?? l.match(phoneRe);
        if (m) {
          phone = m[0];
          phoneConf = 0.95;
          break;
        }
      }
    }
    if (phone === "Not Found") {
      for (const l of scope) {
        const m = l.match(phoneRe);
        if (m) {
          phone = m[0];
          phoneConf = 0.8;
          break;
        }
      }
    }

    // Role: explicit "Applied For / Position / Job Role / Applying for / Headline" phrases.
    let role = "Not Found";
    let roleConf = 0;
    for (const l of lines) {
      const m = l.match(/(?:applied\s*for|position\s*applied(?:\s*for)?|job\s*role|applying\s*for|resume\s*headline)\s*[:|-]?\s*(.+)$/i);
      if (m) {
        role = m[1].replace(/\s+with\s+.*$/i, "").trim();
        roleConf = 0.95;
        break;
      }
    }
    if (role === "Not Found") {
      for (const l of lines) {
        const m = l.match(/(?:seeking\s+(?:a\s+)?(?:role|position)\s+as\s+(?:a\s+)?|to work as (?:a\s+)?)([A-Z][A-Za-z ]+?)(?:\s+(?:in|where|at|with)\b|[.,]|$)/i);
        if (m) {
          role = m[1].trim();
          roleConf = 0.8;
          break;
        }
      }
    }
    if (role === "Not Found" && lines[1] && /^[A-Z][A-Za-z ]{3,30}$/.test(lines[1]) && !/@|\d/.test(lines[1]) && lines[1] !== name) {
      role = lines[1];
      roleConf = 0.7; // headline-only inference → below threshold
    }

    const extraction = {
      candidate_name: name,
      phone_number: phone,
      job_role_applied_for: role,
      confidence: { candidate_name: nameConf, phone_number: phoneConf, job_role_applied_for: roleConf },
    };
    return { extraction, model: "heuristic-test-model", raw: JSON.stringify(extraction) };
  }
}
