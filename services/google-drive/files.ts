import { google, type drive_v3 } from "googleapis";
import { AppError } from "@/lib/errors";
import { SUPPORTED_MIME_TYPES } from "@/lib/config";
import { getAuthorizedClient, getAnyActiveConnection } from "./oauth";

/**
 * Google Drive file operations. Read-only: we never modify or delete Drive files.
 */
export interface DriveFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface DriveCvFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  md5Checksum: string | null;
  createdTime: string | null;
  modifiedTime: string | null;
  webViewLink: string | null;
  trashed: boolean;
  parents: string[];
}

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_SUPPORTED_MIMES = [...Object.keys(SUPPORTED_MIME_TYPES), GOOGLE_DOC_MIME];

const FILE_FIELDS = "id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,webViewLink,trashed,parents";

export function isSupportedDriveFile(file: Pick<drive_v3.Schema$File, "mimeType" | "name" | "trashed">): boolean {
  if (file.trashed) return false;
  if (!file.mimeType) return false;
  return DRIVE_SUPPORTED_MIMES.includes(file.mimeType);
}

export function toDriveCvFile(f: drive_v3.Schema$File): DriveCvFile {
  return {
    id: f.id!,
    name: f.name ?? "untitled",
    mimeType: f.mimeType ?? "application/octet-stream",
    size: Number(f.size ?? 0),
    md5Checksum: f.md5Checksum ?? null,
    createdTime: f.createdTime ?? null,
    modifiedTime: f.modifiedTime ?? null,
    webViewLink: f.webViewLink ?? (f.id ? `https://drive.google.com/file/d/${f.id}/view` : null),
    trashed: Boolean(f.trashed),
    parents: f.parents ?? [],
  };
}

export async function driveClient(connectionId: string): Promise<drive_v3.Drive> {
  const auth = await getAuthorizedClient(connectionId);
  return google.drive({ version: "v3", auth });
}

/** List sub-folders (for the folder picker). parentId = "root" for My Drive top level. */
export async function listFolders(connectionId: string, parentId = "root"): Promise<DriveFolder[]> {
  const drive = await driveClient(connectionId);
  const out: DriveFolder[] = [];
  let pageToken: string | undefined;
  do {
    const page: drive_v3.Schema$FileList = await listPage(drive, {
      q: `'${escapeQ(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "nextPageToken, files(id, name, parents)",
      pageSize: 200,
      orderBy: "name",
      pageToken,
    });
    for (const f of page.files ?? []) out.push({ id: f.id!, name: f.name ?? "", parentId: f.parents?.[0] ?? null });
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function listPage(drive: drive_v3.Drive, params: drive_v3.Params$Resource$Files$List): Promise<drive_v3.Schema$FileList> {
  const res = await drive.files.list({ ...params, supportsAllDrives: true, includeItemsFromAllDrives: true });
  return res.data;
}

/** Search folders by name anywhere in the drive. */
export async function searchFolders(connectionId: string, query: string): Promise<DriveFolder[]> {
  const drive = await driveClient(connectionId);
  const res = await drive.files.list({
    q: `name contains '${escapeQ(query)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id, name, parents)",
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files ?? []).map((f) => ({ id: f.id!, name: f.name ?? "", parentId: f.parents?.[0] ?? null }));
}

/** Resolve "My Drive / Recruitment / CVs" style path for display. */
export async function getFolderPath(connectionId: string, folderId: string): Promise<{ name: string; path: string }> {
  const drive = await driveClient(connectionId);
  const parts: string[] = [];
  let current: string | undefined = folderId;
  let name = "";
  for (let i = 0; i < 20 && current; i++) {
    const meta: drive_v3.Schema$File = await getFileMeta(drive, current, "id,name,parents");
    if (!name) name = meta.name ?? "";
    parts.unshift(meta.name ?? "");
    current = meta.parents?.[0];
    if (!current) break;
  }
  return { name, path: parts.join(" / ") };
}

async function getFileMeta(drive: drive_v3.Drive, fileId: string, fields: string): Promise<drive_v3.Schema$File> {
  const res = await drive.files.get({ fileId, fields, supportsAllDrives: true });
  return res.data;
}

/** List all supported CV files directly inside a folder. */
export async function listCvFilesInFolder(connectionId: string, folderId: string): Promise<DriveCvFile[]> {
  const drive = await driveClient(connectionId);
  const mimeQ = DRIVE_SUPPORTED_MIMES.map((m) => `mimeType = '${m}'`).join(" or ");
  const out: DriveCvFile[] = [];
  let pageToken: string | undefined;
  do {
    const page: drive_v3.Schema$FileList = await listPage(drive, {
      q: `'${escapeQ(folderId)}' in parents and trashed = false and (${mimeQ})`,
      fields: `nextPageToken, files(${FILE_FIELDS})`,
      pageSize: 1000,
      pageToken,
    });
    for (const f of page.files ?? []) if (isSupportedDriveFile(f)) out.push(toDriveCvFile(f));
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export async function getStartPageToken(connectionId: string): Promise<string> {
  const drive = await driveClient(connectionId);
  const res = await drive.changes.getStartPageToken({ supportsAllDrives: true });
  if (!res.data.startPageToken) throw new AppError("Drive did not return a start page token", { status: 502 });
  return res.data.startPageToken;
}

export interface DriveChangeSet {
  changed: DriveCvFile[];
  removedIds: string[];
  newStartPageToken: string;
}

/** Incremental changes since `pageToken` (Drive Changes API). */
export async function listChanges(connectionId: string, pageToken: string): Promise<DriveChangeSet> {
  const drive = await driveClient(connectionId);
  const changed: DriveCvFile[] = [];
  const removedIds: string[] = [];
  let token: string | undefined = pageToken;
  let newStart = pageToken;
  while (token) {
    const page = await fetchChangesPage(drive, token);
    for (const c of page.changes ?? []) {
      if (c.removed || !c.file || c.file.trashed) {
        if (c.fileId) removedIds.push(c.fileId);
        continue;
      }
      if (isSupportedDriveFile(c.file)) changed.push(toDriveCvFile(c.file));
    }
    if (page.newStartPageToken) newStart = page.newStartPageToken;
    token = page.nextPageToken ?? undefined;
  }
  return { changed, removedIds, newStartPageToken: newStart };
}

async function fetchChangesPage(drive: drive_v3.Drive, pageToken: string): Promise<drive_v3.Schema$ChangeList> {
  const res = await drive.changes.list({
    pageToken,
    pageSize: 500,
    includeRemoved: true,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: `nextPageToken, newStartPageToken, changes(fileId, removed, file(${FILE_FIELDS}))`,
  });
  return res.data;
}

/** Fetch metadata for a single file. */
export async function getDriveFile(connectionId: string, fileId: string): Promise<DriveCvFile> {
  const drive = await driveClient(connectionId);
  const res = await drive.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true });
  return toDriveCvFile(res.data);
}

/**
 * Download file bytes for processing. Google Docs are exported as PDF; other
 * types are downloaded as-is. The Drive file is never modified.
 */
export async function downloadDriveFile(connectionId: string | null, fileId: string): Promise<Buffer> {
  let connId = connectionId;
  if (!connId) {
    const any = await getAnyActiveConnection();
    if (!any) throw new AppError("No active Google Drive connection is available to download this file", { status: 400, code: "GOOGLE_NOT_CONNECTED" });
    connId = any.id;
  }
  const drive = await driveClient(connId);
  const meta = await drive.files.get({ fileId, fields: "id,mimeType", supportsAllDrives: true });
  if (meta.data.mimeType === GOOGLE_DOC_MIME) {
    const res = await drive.files.export({ fileId, mimeType: "application/pdf" }, { responseType: "arraybuffer" });
    return Buffer.from(res.data as ArrayBuffer);
  }
  const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
  return Buffer.from(res.data as ArrayBuffer);
}

/** Map Drive mime to the mime the pipeline should use (Google Docs are exported to PDF). */
export function effectiveMime(driveMime: string): string {
  return driveMime === GOOGLE_DOC_MIME ? "application/pdf" : driveMime;
}

function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
