import nodemailer from "nodemailer";
import { env } from "./config";
import { AppError } from "./errors";
import { logger } from "./logger";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export function isMailConfigured(): boolean {
  const e = env();
  return Boolean(e.SMTP_USER && e.SMTP_PASS);
}

/**
 * Send an email.
 *
 * Unconfigured behaviour differs by environment on purpose. In development the
 * message is written to the server log, so sign-up can be exercised without a
 * mailbox. Anywhere else it throws: a production sign-up that silently "sent" a
 * code nobody received would look like it worked while locking the person out.
 */
export async function sendMail(mail: Mail): Promise<void> {
  const e = env();
  if (!isMailConfigured()) {
    if (e.NODE_ENV !== "production" && !process.env.VERCEL) {
      logger.warn({ to: mail.to, subject: mail.subject, text: mail.text }, "SMTP not configured — email written to log instead of sent");
      return;
    }
    throw new AppError("Email is not configured on this server, so the verification code could not be sent. Set SMTP_USER and SMTP_PASS.", {
      status: 503,
      code: "MAIL_NOT_CONFIGURED",
    });
  }

  const transport = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_PORT === 465,
    auth: { user: e.SMTP_USER, pass: e.SMTP_PASS },
    // Bounded: a hung SMTP handshake would otherwise hold the request until the
    // platform's function timeout and surface as an unexplained 504.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  try {
    await transport.sendMail({ from: e.MAIL_FROM || `CV Parser <${e.SMTP_USER}>`, ...mail });
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ to: mail.to, err: message }, "Email send failed");
    // Gmail's rejection of a normal account password is the common first-run
    // failure, and its raw text ("535-5.7.8 Username and Password not accepted")
    // does not say what to do about it.
    const hint = /535|Username and Password not accepted|BadCredentials/i.test(message)
      ? " Gmail rejected the login — SMTP_PASS must be a Google App Password, not the account password."
      : "";
    throw new AppError(`The verification email could not be sent.${hint}`, { status: 502, code: "MAIL_SEND_FAILED" });
  }
}
