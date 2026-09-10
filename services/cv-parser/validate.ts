import { normalizePhone, findPhoneCandidates } from "./phone";
import type { LLMExtraction } from "@/services/llm/types";

/**
 * Validation layer applied after LLM extraction.
 * Rejects obviously wrong values (company names as candidate, "Resume" as name,
 * generic job roles), normalises phone numbers and adjusts confidences.
 * Any rejection or sub-threshold confidence marks the record NEEDS_REVIEW.
 */
export const NOT_FOUND = "Not Found";

export interface ValidatedExtraction {
  candidateName: string;
  phoneNumber: string;
  jobRoleAppliedFor: string;
  nameConfidence: number;
  phoneConfidence: number;
  roleConfidence: number;
  overallConfidence: number;
  needsReview: boolean;
  reviewReasons: string[];
}

const NAME_BLACKLIST = [
  /^(resume|cv|curriculum\s*vitae|bio[\s-]*data|biodata|profile|candidate|applicant|name)$/i,
  /\b(pvt|private|ltd|limited|llp|inc|corp|corporation|company|co\.|technologies|technology|solutions|systems|services|consulting|consultancy|group|enterprises|industries|infotech|software|labs|bank|university|college|institute|school|academy|hospital|foundation|trust|association)\b/i,
  /\b(hr|human resources|recruiter|hiring manager|talent acquisition|reference|referee)\b/i,
  /[@#$%^&*_=+<>{}[\]\\|/]/,
  /\d{3,}/,
  /\bhttps?:|www\./i,
];

const GENERIC_ROLES = [
  /^(job\s*seeker|candidate|professional|employee|worker|fresher|student|graduate|intern(ship)?|any|any\s*(suitable\s*)?(role|position|job)|open\s*to\s*(any|all)|looking\s*for\s*(a\s*)?job|seeking\s*(a\s*)?(job|employment|opportunity)|n\/?a|none|unknown|not\s*(specified|mentioned|found))$/i,
  /^(a\s+)?(suitable|challenging|good|rewarding|growth[- ]oriented)\s+(position|role|job|career|opportunity)/i,
  /^(position|role|job|career|opportunity|employment)$/i,
];

export function clamp01(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(1, v));
}

export function isNotFound(v: string | null | undefined): boolean {
  if (!v) return true;
  const t = v.trim();
  return !t || /^not\s*found$/i.test(t) || /^(n\/?a|null|undefined|none|-)$/i.test(t);
}

export function validateName(raw: string | null | undefined): { value: string; ok: boolean; reason?: string } {
  if (isNotFound(raw)) return { value: NOT_FOUND, ok: false, reason: "Candidate name not found" };
  let name = (raw as string).replace(/\s+/g, " ").trim();
  // Strip common honorifics/prefixes.
  name = name.replace(/^(mr|mrs|ms|miss|dr|er|prof|shri|smt|sri)\.?\s+/i, "").trim();
  if (name.length < 2 || name.length > 80) return { value: NOT_FOUND, ok: false, reason: "Candidate name has implausible length" };
  for (const re of NAME_BLACKLIST) {
    if (re.test(name)) return { value: NOT_FOUND, ok: false, reason: `Candidate name rejected (looks like an organisation, label or non-candidate): "${name}"` };
  }
  const words = name.split(" ");
  if (words.length > 6) return { value: NOT_FOUND, ok: false, reason: "Candidate name has too many words" };
  if (!/^[\p{L}][\p{L}'.\- ]*$/u.test(name)) return { value: NOT_FOUND, ok: false, reason: "Candidate name contains invalid characters" };
  // Title-case names that arrive fully upper- or lower-cased.
  if (name === name.toUpperCase() || name === name.toLowerCase()) {
    name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  }
  return { value: name, ok: true };
}

export function validateRole(raw: string | null | undefined): { value: string; ok: boolean; reason?: string } {
  if (isNotFound(raw)) return { value: NOT_FOUND, ok: false, reason: "Job role not found" };
  const role = (raw as string).replace(/\s+/g, " ").trim().replace(/[.:;,]+$/, "");
  if (role.length < 2 || role.length > 100) return { value: NOT_FOUND, ok: false, reason: "Job role has implausible length" };
  for (const re of GENERIC_ROLES) {
    if (re.test(role)) return { value: NOT_FOUND, ok: false, reason: `Job role rejected as generic: "${role}"` };
  }
  if (/[@#$%^&*_=+<>{}[\]\\|]/.test(role)) return { value: NOT_FOUND, ok: false, reason: "Job role contains invalid characters" };
  return { value: role, ok: true };
}

export function validatePhone(raw: string | null | undefined, cvText?: string): { value: string; ok: boolean; reason?: string; inText: boolean } {
  if (isNotFound(raw)) return { value: NOT_FOUND, ok: false, reason: "Phone number not found", inText: false };
  const n = normalizePhone(raw);
  if (!n.valid) return { value: NOT_FOUND, ok: false, reason: `Phone number invalid: "${raw}"`, inText: false };
  // Anti-hallucination: the digits must actually appear in the CV text.
  let inText = true;
  if (cvText) {
    const last8 = n.normalized.replace(/\D/g, "").slice(-8);
    inText = cvText.replace(/[\s\-().]/g, "").includes(last8);
  }
  return { value: n.normalized, ok: true, inText };
}

export interface ValidateOptions {
  threshold: number;
  cvText?: string;
}

export function validateExtraction(llm: LLMExtraction, opts: ValidateOptions): ValidatedExtraction {
  const reasons: string[] = [];

  const name = validateName(llm.candidate_name);
  let nameConf = clamp01(llm.confidence?.candidate_name);
  if (!name.ok) {
    nameConf = 0;
    reasons.push(name.reason ?? "Candidate name invalid");
  }

  const phone = validatePhone(llm.phone_number, opts.cvText);
  let phoneConf = clamp01(llm.confidence?.phone_number);
  if (!phone.ok) {
    phoneConf = 0;
    reasons.push(phone.reason ?? "Phone number invalid");
  } else if (!phone.inText) {
    phoneConf = Math.min(phoneConf, 0.4);
    reasons.push("Phone number could not be verified against CV text");
  } else if (opts.cvText) {
    const candidates = findPhoneCandidates(opts.cvText);
    if (candidates.length > 1) phoneConf = Math.min(phoneConf, 0.9);
  }

  const role = validateRole(llm.job_role_applied_for);
  let roleConf = clamp01(llm.confidence?.job_role_applied_for);
  if (!role.ok) {
    roleConf = 0;
    reasons.push(role.reason ?? "Job role invalid");
  }

  // Overall: weighted mean, name and phone matter most for recruiters.
  const overall = Number((nameConf * 0.4 + phoneConf * 0.35 + roleConf * 0.25).toFixed(3));

  const below: string[] = [];
  if (name.ok && nameConf < opts.threshold) below.push(`name confidence ${nameConf.toFixed(2)}`);
  if (phone.ok && phoneConf < opts.threshold) below.push(`phone confidence ${phoneConf.toFixed(2)}`);
  if (role.ok && roleConf < opts.threshold) below.push(`job role confidence ${roleConf.toFixed(2)}`);
  if (below.length) reasons.push(`Below confidence threshold ${opts.threshold}: ${below.join(", ")}`);

  return {
    candidateName: name.value,
    phoneNumber: phone.value,
    jobRoleAppliedFor: role.value,
    nameConfidence: Number(nameConf.toFixed(3)),
    phoneConfidence: Number(phoneConf.toFixed(3)),
    roleConfidence: Number(roleConf.toFixed(3)),
    overallConfidence: overall,
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
  };
}
