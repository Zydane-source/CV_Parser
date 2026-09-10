import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/config";
import { logger } from "@/lib/logger";
import { randomToken } from "@/lib/crypto";
import { driveClient, getStartPageToken } from "./files";

/**
 * Google Drive push notifications (changes.watch). Google only delivers to
 * public HTTPS endpoints, so this is active when APP_URL is https://. Polling
 * (repeatable drive-sync job) remains the baseline; webhooks make detection
 * near-instant. Channels expire (max ~1 day) and are renewed during sync.
 */
const CHANNEL_TTL_MS = 23 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 2 * 60 * 60 * 1000;

export function webhooksPossible(): boolean {
  return env().APP_URL.startsWith("https://");
}

export function webhookAddress(): string {
  return `${env().APP_URL.replace(/\/+$/, "")}/api/google-drive/webhook`;
}

export async function ensureWatch(connectionId: string): Promise<void> {
  if (!webhooksPossible()) return;
  const conn = await prisma.googleDriveConnection.findUnique({ where: { id: connectionId } });
  if (!conn || !conn.isActive || !conn.folderId) return;
  const stillValid = conn.watchChannelId && conn.watchExpiry && conn.watchExpiry.getTime() - Date.now() > RENEW_BEFORE_MS;
  if (stillValid) return;

  if (conn.watchChannelId && conn.watchResourceId) await stopWatch(connectionId).catch(() => undefined);

  const drive = await driveClient(connectionId);
  const pageToken = conn.startPageToken ?? (await getStartPageToken(connectionId));
  const channelId = randomUUID();
  const token = randomToken(24);
  const expiration = Date.now() + CHANNEL_TTL_MS;
  const res = await drive.changes.watch({
    pageToken,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: webhookAddress(),
      token,
      expiration: String(expiration),
    },
  });
  await prisma.googleDriveConnection.update({
    where: { id: connectionId },
    data: {
      watchChannelId: channelId,
      watchResourceId: res.data.resourceId ?? null,
      watchExpiry: res.data.expiration ? new Date(Number(res.data.expiration)) : new Date(expiration),
      watchToken: token,
      startPageToken: conn.startPageToken ?? pageToken,
    },
  });
  logger.info({ connectionId, channelId }, "Drive watch channel registered");
}

export async function stopWatch(connectionId: string): Promise<void> {
  const conn = await prisma.googleDriveConnection.findUnique({ where: { id: connectionId } });
  if (!conn?.watchChannelId || !conn.watchResourceId) return;
  try {
    const drive = await driveClient(connectionId);
    await drive.channels.stop({ requestBody: { id: conn.watchChannelId, resourceId: conn.watchResourceId } });
  } finally {
    await prisma.googleDriveConnection.update({
      where: { id: connectionId },
      data: { watchChannelId: null, watchResourceId: null, watchExpiry: null, watchToken: null },
    });
  }
}

/** Resolve the connection a webhook notification belongs to (validates the channel token). */
export async function resolveWebhookConnection(channelId: string | null, token: string | null) {
  if (!channelId || !token) return null;
  const conn = await prisma.googleDriveConnection.findFirst({ where: { watchChannelId: channelId, isActive: true } });
  if (!conn || !conn.watchToken || conn.watchToken !== token) return null;
  return conn;
}
