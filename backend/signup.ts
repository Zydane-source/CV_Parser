import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { env } from "@/lib/config";
import { hashPassword, type SessionUser } from "@/lib/auth";
import { ConflictError, RateLimitError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { sendMail } from "@/lib/mailer";
import { slugify } from "./workspaces";

/**
 * "Create account".
 *
 * Signing up creates a new client: a workspace, with the person signing up as
 * its administrator. It is gated by a six-digit code that is emailed to the
 * platform's approval address (SIGNUP_APPROVAL_EMAIL) rather than to the person
 * signing up — so the operator decides who gets a client account, and approves
 * one by passing the code on.
 *
 * Nothing exists in Workspace or User until the code is accepted. The code is
 * stored only as an HMAC, expires, and allows a handful of guesses.
 */

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  companyName: z.string().trim().min(2, "Enter your company name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(160),
  password: z.string().min(10, "Use at least 10 characters").max(200),
});

export const verifySchema = z.object({
  requestId: z.string().min(1).max(64),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "The code is 6 digits"),
});

function hashCode(requestId: string, code: string): string {
  // Bound to the request id, so a code is useless against any other sign-up.
  return createHmac("sha256", env().AUTH_SECRET).update(`${requestId}:${code}`).digest("hex");
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** "caller.digital26@gmail.com" → "ca•••••••••26@gmail.com" — enough to recognise, not to harvest. */
export function maskEmail(address: string): string {
  const [local, domain] = address.split("@");
  if (!domain || local.length <= 4) return address;
  return `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 4, 10))}${local.slice(-2)}@${domain}`;
}

async function emailCode(request: { name: string; email: string; companyName: string }, code: string) {
  const to = env().SIGNUP_APPROVAL_EMAIL;
  await sendMail({
    to,
    subject: `CV Parser account request: ${request.companyName} — code ${code}`,
    text: [
      `A new client account has been requested on CV Parser.`,
      ``,
      `  Company: ${request.companyName}`,
      `  Name:    ${request.name}`,
      `  Email:   ${request.email}`,
      ``,
      `Verification code: ${code}`,
      ``,
      `If you approve, share this code with them. It expires in 15 minutes.`,
      `If you do not recognise this request, ignore this email and no account is created.`,
    ].join("\n"),
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;color:#0f172a">
        <p style="margin:0 0 16px">A new client account has been requested on <strong>CV Parser</strong>.</p>
        <table style="border-collapse:collapse;font-size:14px;margin-bottom:20px">
          <tr><td style="padding:3px 16px 3px 0;color:#64748b">Company</td><td><strong>${escapeHtml(request.companyName)}</strong></td></tr>
          <tr><td style="padding:3px 16px 3px 0;color:#64748b">Name</td><td>${escapeHtml(request.name)}</td></tr>
          <tr><td style="padding:3px 16px 3px 0;color:#64748b">Email</td><td>${escapeHtml(request.email)}</td></tr>
        </table>
        <p style="margin:0 0 6px;color:#64748b;font-size:13px">Verification code</p>
        <p style="margin:0 0 20px;font-size:30px;letter-spacing:6px;font-weight:700;font-family:ui-monospace,monospace">${code}</p>
        <p style="margin:0;font-size:13px;color:#475569">If you approve, share this code with them. It expires in 15 minutes.
        If you do not recognise this request, ignore this email and no account is created.</p>
      </div>`,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function requestSignup(input: z.infer<typeof signupSchema>) {
  const taken = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (taken) throw new ConflictError("An account with this email already exists. Sign in instead.");

  // Starting again replaces any earlier unfinished request for the same address,
  // so only the newest code can ever work.
  await prisma.signupRequest.deleteMany({ where: { email: input.email, consumedAt: null } });

  const code = newCode();
  const request = await prisma.signupRequest.create({
    data: {
      name: input.name,
      email: input.email,
      companyName: input.companyName,
      passwordHash: await hashPassword(input.password),
      codeHash: "pending",
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  await prisma.signupRequest.update({ where: { id: request.id }, data: { codeHash: hashCode(request.id, code) } });

  try {
    await emailCode(request, code);
  } catch (err) {
    // A request whose code was never delivered can never be completed.
    await prisma.signupRequest.delete({ where: { id: request.id } }).catch(() => undefined);
    throw err;
  }

  logger.info({ requestId: request.id, company: input.companyName }, "Sign-up requested; code sent for approval");
  return { requestId: request.id, sentTo: maskEmail(env().SIGNUP_APPROVAL_EMAIL), expiresAt: request.expiresAt };
}

export async function resendSignupCode(requestId: string) {
  const request = await prisma.signupRequest.findUnique({ where: { id: requestId } });
  if (!request || request.consumedAt) throw new ValidationError("This sign-up is no longer open. Start again.");
  const wait = RESEND_COOLDOWN_MS - (Date.now() - request.sentAt.getTime());
  if (wait > 0) throw new RateLimitError(`Please wait ${Math.ceil(wait / 1000)} seconds before requesting another code.`);

  const code = newCode();
  const updated = await prisma.signupRequest.update({
    where: { id: requestId },
    data: { codeHash: hashCode(requestId, code), attempts: 0, sentAt: new Date(), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  await emailCode(updated, code);
  return { requestId, sentTo: maskEmail(env().SIGNUP_APPROVAL_EMAIL), expiresAt: updated.expiresAt };
}

/** A handle nobody else has: "apex-ventures", then "apex-ventures-2", … */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || "client";
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? base : `${base.slice(0, 44)}-${i}`;
    if (!(await prisma.workspace.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base.slice(0, 38)}-${Date.now().toString(36)}`;
}

/** Accept a code: create the client and its administrator, and return who to sign in. */
export async function verifySignup(input: z.infer<typeof verifySchema>): Promise<SessionUser> {
  const request = await prisma.signupRequest.findUnique({ where: { id: input.requestId } });
  if (!request || request.consumedAt || request.expiresAt.getTime() < Date.now()) {
    throw new ValidationError("This code has expired. Request a new one.");
  }
  if (request.attempts >= MAX_ATTEMPTS) {
    throw new ValidationError("Too many incorrect codes. Request a new one.");
  }

  const expected = Buffer.from(request.codeHash, "hex");
  const given = Buffer.from(hashCode(request.id, input.code), "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    const { attempts } = await prisma.signupRequest.update({
      where: { id: request.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    const left = MAX_ATTEMPTS - attempts;
    throw new ValidationError(left > 0 ? `That code is not correct. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many incorrect codes. Request a new one.");
  }

  const slug = await uniqueSlug(request.companyName);
  const user = await prisma.$transaction(async (tx) => {
    // Claimed inside the transaction: two simultaneous submissions of the right
    // code must not create two clients.
    const claimed = await tx.signupRequest.updateMany({
      where: { id: request.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) throw new ValidationError("This code has already been used.");

    if (await tx.user.findUnique({ where: { email: request.email }, select: { id: true } })) {
      throw new ConflictError("An account with this email already exists. Sign in instead.");
    }
    const ws = await tx.workspace.create({ data: { name: request.companyName, slug } });
    return tx.user.create({
      data: { workspaceId: ws.id, name: request.name, email: request.email, passwordHash: request.passwordHash, role: "ADMIN" },
      include: { workspace: { select: { name: true } } },
    });
  });

  logger.info({ userId: user.id, workspaceId: user.workspaceId }, "Sign-up verified; client created");
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    workspaceId: user.workspaceId,
    workspaceName: user.workspace?.name ?? null,
  };
}

