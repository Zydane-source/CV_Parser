import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { SignJWT, jwtVerify } from "jose";
import { env } from "@/lib/config";
import { prisma } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Google OAuth 2.0 for Drive + Sheets.
 * Minimum scopes:
 *   drive.readonly      – list/download CVs from the selected folder (never modifies Drive)
 *   spreadsheets        – create/write the export spreadsheet
 *   userinfo.email      – show which Google account is connected
 * Tokens are encrypted at rest (AES-256-GCM) and refreshed automatically.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function isGoogleConfigured(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
}

export function redirectUri(): string {
  const e = env();
  return e.GOOGLE_REDIRECT_URI || `${e.APP_URL.replace(/\/+$/, "")}/api/google-drive/callback`;
}

export function createOAuthClient(): OAuth2Client {
  const e = env();
  if (!isGoogleConfigured()) {
    throw new AppError("Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.", {
      status: 503,
      code: "GOOGLE_NOT_CONFIGURED",
    });
  }
  return new google.auth.OAuth2(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET, redirectUri());
}

function stateKey(): Uint8Array {
  return new TextEncoder().encode(env().AUTH_SECRET);
}

/** Signed, short-lived OAuth state bound to the initiating user (CSRF protection). */
export async function createOAuthState(userId: string): Promise<string> {
  return new SignJWT({ purpose: "google-oauth" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(stateKey());
}

export async function verifyOAuthState(state: string, userId: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(state, stateKey());
    return payload.sub === userId && payload.purpose === "google-oauth";
  } catch {
    return false;
  }
}

export function generateAuthUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // ensures a refresh token is issued
    scope: GOOGLE_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

/** Exchange the authorization code and persist an (encrypted) connection for the user. */
export async function completeOAuth(code: string, userId: string) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new AppError("Google did not return an access token", { status: 502, code: "GOOGLE_TOKEN" });
  client.setCredentials(tokens);

  let email: string | null = null;
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const me = await oauth2.userinfo.get();
    email = me.data.email ?? null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Could not fetch Google account email");
  }

  const e = env();

  // The connection belongs to the client, not only to the person who linked it:
  // a CV imported through it is that client's, whoever pressed Connect.
  const linker = await prisma.user.findUnique({ where: { id: userId }, select: { workspaceId: true } });
  if (!linker?.workspaceId) {
    throw new AppError("Connect Google Drive from a client workspace account", { status: 400, code: "NO_WORKSPACE" });
  }

  // One active connection per client, not per person. Keyed on the user, a
  // colleague pressing Connect would have made a second connection to the same
  // folder, and both would then sync it.
  const existing = await prisma.googleDriveConnection.findFirst({
    where: { workspaceId: linker.workspaceId, isActive: true },
  });

  const data = {
    workspaceId: linker.workspaceId,
    // Who most recently authorised it — the tokens in use are theirs.
    userId,
    googleAccountEmail: email,
    accessTokenEnc: encryptSecret(tokens.access_token),
    refreshTokenEnc: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : existing?.refreshTokenEnc ?? null,
    tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    scope: tokens.scope ?? GOOGLE_SCOPES.join(" "),
    isActive: true,
    lastSyncError: null,
  };
  if (existing) {
    return prisma.googleDriveConnection.update({ where: { id: existing.id }, data });
  }
  return prisma.googleDriveConnection.create({
    data: { ...data, folderId: e.GOOGLE_DRIVE_FOLDER_ID || null },
  });
}

/**
 * Build an authorised client for a stored connection. Refreshed tokens are
 * persisted automatically via the 'tokens' event.
 */
export async function getAuthorizedClient(connectionId: string): Promise<OAuth2Client> {
  const conn = await prisma.googleDriveConnection.findUnique({ where: { id: connectionId } });
  if (!conn || !conn.isActive) throw new AppError("Google Drive is not connected", { status: 400, code: "GOOGLE_NOT_CONNECTED" });
  const client = createOAuthClient();
  client.setCredentials({
    access_token: decryptSecret(conn.accessTokenEnc),
    refresh_token: conn.refreshTokenEnc ? decryptSecret(conn.refreshTokenEnc) : undefined,
    expiry_date: conn.tokenExpiry ? conn.tokenExpiry.getTime() : undefined,
  });
  client.on("tokens", (tokens) => {
    const data: Record<string, unknown> = {};
    if (tokens.access_token) data.accessTokenEnc = encryptSecret(tokens.access_token);
    if (tokens.refresh_token) data.refreshTokenEnc = encryptSecret(tokens.refresh_token);
    if (tokens.expiry_date) data.tokenExpiry = new Date(tokens.expiry_date);
    if (Object.keys(data).length) {
      prisma.googleDriveConnection.update({ where: { id: connectionId }, data }).catch((err) => {
        logger.error({ err: (err as Error).message }, "Failed to persist refreshed Google tokens");
      });
    }
  });
  return client;
}

/**
 * The active Drive connection for a client (or null).
 *
 * Resolved by workspace rather than by the person signed in, because the folder
 * is the client's. Keyed on the user, a recruiter whose administrator had
 * already connected Drive would be told "Not connected" and, pressing Connect,
 * would create a second connection syncing the same folder twice.
 *
 * Null workspace — the platform owner — has no Drive of its own, and gets null.
 */
export async function getWorkspaceConnection(workspaceId: string | null) {
  if (!workspaceId) return null;
  return prisma.googleDriveConnection.findFirst({
    where: { workspaceId, isActive: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * A fallback connection for downloading a Drive file whose own connection is gone
 * (the row is set null when a connection is deleted).
 *
 * Restricted to the file's client. Platform-wide, this would reach for whichever
 * connection happened to be newest and use *that* client's Google credentials to
 * fetch this file — a request made under the wrong identity. It would usually
 * just 404, and would quietly succeed in the one case that matters: two clients
 * connected to the same shared folder.
 */
export async function getAnyActiveConnection(workspaceId: string) {
  return prisma.googleDriveConnection.findFirst({
    where: { workspaceId, isActive: true },
    orderBy: { createdAt: "desc" },
  });
}

/** Disconnect: revoke the token at Google (best effort) and deactivate. */
export async function disconnect(connectionId: string) {
  const conn = await prisma.googleDriveConnection.findUnique({ where: { id: connectionId } });
  if (!conn) return;
  try {
    const client = createOAuthClient();
    const token = conn.refreshTokenEnc ? decryptSecret(conn.refreshTokenEnc) : decryptSecret(conn.accessTokenEnc);
    await client.revokeToken(token);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Token revocation failed (continuing)");
  }
  await prisma.googleDriveConnection.update({
    where: { id: connectionId },
    data: { isActive: false, watchChannelId: null, watchResourceId: null, watchExpiry: null, watchToken: null },
  });
}
