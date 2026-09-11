import { promises as fs } from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/config";
import { randomToken } from "@/lib/crypto";

/**
 * Object storage abstraction for manually uploaded CVs.
 *  - LocalStorageProvider: uploads/ directory (development only; ephemeral in most PaaS).
 *  - S3StorageProvider: any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Spaces).
 * Objects are stored under opaque keys; the original filename is kept only in the DB.
 * Files are never served with an executable content type.
 */
export interface StorageProvider {
  readonly name: "local" | "s3" | "vercel-blob";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Optional: a short-lived direct URL (S3 only). */
  signedUrl?(key: string, expiresInSeconds?: number): Promise<string>;
}

export function buildObjectKey(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `cvs/${yyyy}/${mm}/${randomToken(18)}${ext}`;
}

class LocalStorageProvider implements StorageProvider {
  readonly name = "local" as const;
  private root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  private resolve(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep) && p !== this.root) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data, { mode: 0o600 });
  }
  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }
  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

class S3StorageProvider implements StorageProvider {
  readonly name = "s3" as const;
  private client: S3Client;
  private bucket: string;
  constructor() {
    const e = env();
    if (!e.STORAGE_BUCKET || !e.STORAGE_ACCESS_KEY || !e.STORAGE_SECRET_KEY) {
      throw new Error("STORAGE_DRIVER=s3 requires STORAGE_BUCKET, STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY");
    }
    this.bucket = e.STORAGE_BUCKET;
    this.client = new S3Client({
      region: e.STORAGE_REGION || "auto",
      endpoint: e.STORAGE_ENDPOINT || undefined,
      forcePathStyle: e.STORAGE_FORCE_PATH_STYLE,
      credentials: { accessKeyId: e.STORAGE_ACCESS_KEY, secretAccessKey: e.STORAGE_SECRET_KEY },
    });
  }
  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ContentDisposition: "attachment",
        ServerSideEncryption: "AES256",
      }),
    );
  }
  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error("Empty object body");
    return Buffer.from(bytes);
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  async signedUrl(key: string, expiresInSeconds = 300): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds });
  }
}

/**
 * Vercel Blob. Chosen for serverless deployments because the filesystem there is
 * ephemeral: an upload written to disk disappears with the function instance.
 */
class VercelBlobStorageProvider implements StorageProvider {
  readonly name = "vercel-blob" as const;
  private token: string;
  /** Blob keys map to absolute URLs; cache them so get/delete need no lookup. */
  private urlCache = new Map<string, string>();

  constructor(token: string) {
    if (!token) throw new Error('STORAGE_DRIVER=vercel-blob requires BLOB_READ_WRITE_TOKEN (Vercel sets it when you attach a Blob store)');
    this.token = token;
  }

  private async resolveUrl(key: string): Promise<string> {
    const cached = this.urlCache.get(key);
    if (cached) return cached;
    const { list } = await import("@vercel/blob");
    const res = await list({ prefix: key, limit: 1, token: this.token });
    const found = res.blobs.find((b) => b.pathname === key);
    if (!found) throw new Error(`Blob not found: ${key}`);
    this.urlCache.set(key, found.url);
    return found.url;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const { put } = await import("@vercel/blob");
    const options = {
      contentType,
      token: this.token,
      // Keep our own opaque key as the pathname so the DB stays the index.
      addRandomSuffix: false,
      // Never let a CDN or browser hold on to them.
      cacheControlMaxAge: 0,
    };
    try {
      // A CV is personal data. A "public" blob is readable by anyone who has the
      // URL, with no authentication — an unguessable key is obscurity, not
      // access control, and URLs leak through logs, proxies and referrers.
      const res = await put(key, data, { ...options, access: "private" });
      this.urlCache.set(key, res.url);
    } catch (err) {
      // Private blobs are not available on every plan or SDK version. Losing the
      // upload entirely would be worse than storing it the way this store has
      // stored every CV so far, so fall back — loudly, because it is a weaker
      // guarantee than the one above.
      console.warn(
        `[storage] private blob upload failed (${err instanceof Error ? err.message : String(err)}); ` +
          `falling back to public access. CVs will be readable by URL — check that your Blob store supports private access.`,
      );
      const res = await put(key, data, { ...options, access: "public" });
      this.urlCache.set(key, res.url);
    }
  }

  /**
   * Reads through the authenticated endpoint. Blobs written before this store
   * switched to private access are still public, so a failure there falls back
   * to the URL read — otherwise every CV uploaded before the change would
   * become undownloadable.
   */
  async get(key: string): Promise<Buffer> {
    const { get } = await import("@vercel/blob");
    try {
      const res = await get(key, { access: "private", token: this.token });
      if (res?.stream) return Buffer.from(await new Response(res.stream).arrayBuffer());
    } catch {
      // fall through to the legacy public read
    }
    const url = await this.resolveUrl(key);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Blob fetch failed for ${key}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const { del } = await import("@vercel/blob");
    const url = await this.resolveUrl(key).catch(() => null);
    if (!url) return;
    await del(url, { token: this.token });
    this.urlCache.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.resolveUrl(key);
      return true;
    } catch {
      return false;
    }
  }
}

let instance: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  if (instance) return instance;
  const e = env();
  if (e.STORAGE_DRIVER === "s3") instance = new S3StorageProvider();
  else if (e.STORAGE_DRIVER === "vercel-blob") instance = new VercelBlobStorageProvider(e.BLOB_READ_WRITE_TOKEN);
  else instance = new LocalStorageProvider(e.LOCAL_STORAGE_PATH);
  return instance;
}

/** For tests: inject a provider. */
export function setStorageProvider(p: StorageProvider | null) {
  instance = p;
}
