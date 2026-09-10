import { createCipheriv, createDecipheriv, createHash, randomBytes, createHmac } from "node:crypto";
import { env } from "./config";

/**
 * AES-256-GCM encryption for secrets at rest (Google OAuth tokens).
 * Key: TOKEN_ENCRYPTION_KEY (base64, 32 bytes) or HKDF-like derivation from AUTH_SECRET.
 */
function key(): Buffer {
  const e = env();
  if (e.TOKEN_ENCRYPTION_KEY) {
    const k = Buffer.from(e.TOKEN_ENCRYPTION_KEY, "base64");
    if (k.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)");
    return k;
  }
  if (!e.AUTH_SECRET) throw new Error("AUTH_SECRET is required");
  return createHmac("sha256", e.AUTH_SECRET).update("cv-parser:token-encryption").digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [v, ivB64, tagB64, dataB64] = payload.split(":");
  if (v !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
