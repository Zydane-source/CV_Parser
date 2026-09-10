import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { ValidationError } from "@/lib/errors";
import { SUPPORTED_MIME_TYPES, SUPPORTED_EXTENSIONS } from "@/lib/config";

/**
 * File validation. Uploaded files are data, never code: we verify the magic
 * bytes match a supported document/image type regardless of the client-provided
 * MIME type or extension, and enforce size limits.
 */
export interface ValidatedFile {
  fileName: string;
  mimeType: string;
  size: number;
}

const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(SUPPORTED_MIME_TYPES).flatMap(([mime, exts]) => exts.map((e) => [e, mime])),
);

// Control characters and characters illegal in file names on common filesystems.
const UNSAFE_FILENAME_CHARS = new RegExp("[\\x00-\\x1f<>:\"/\\\\|?*]", "g");

export function sanitizeFileName(name: string): string {
  const base = path.basename(name || "cv").replace(UNSAFE_FILENAME_CHARS, "_").trim();
  return base.slice(0, 200) || "cv";
}

export function mimeFromExtension(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

export function isSupportedFileName(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
}

/** Detect the real MIME type from magic bytes. */
export async function detectMimeType(buffer: Buffer, fileName: string): Promise<string | null> {
  const ft = await fileTypeFromBuffer(buffer);
  if (!ft) return null;
  const ext = path.extname(fileName).toLowerCase();
  // .docx is a zip; file-type identifies it as docx when the package structure is right,
  // otherwise as a plain zip.
  if (ft.mime === "application/zip" && ext === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  // Legacy .doc is an OLE compound file (file-type reports application/x-cfb).
  if (ft.mime === "application/x-cfb" && ext === ".doc") {
    return "application/msword";
  }
  return ft.mime;
}

export async function validateUploadedFile(buffer: Buffer, originalName: string, maxSizeBytes: number): Promise<ValidatedFile> {
  const fileName = sanitizeFileName(originalName);
  if (!isSupportedFileName(fileName)) {
    throw new ValidationError(`Unsupported file type: ${fileName}. Allowed: ${SUPPORTED_EXTENSIONS.join(", ")}`);
  }
  if (buffer.length === 0) throw new ValidationError(`File is empty: ${fileName}`);
  if (buffer.length > maxSizeBytes) {
    throw new ValidationError(
      `File too large: ${fileName} (${(buffer.length / 1024 / 1024).toFixed(1)} MB > ${(maxSizeBytes / 1024 / 1024).toFixed(0)} MB)`,
    );
  }
  const detected = await detectMimeType(buffer, fileName);
  const expected = mimeFromExtension(fileName);
  if (!detected || !(detected in SUPPORTED_MIME_TYPES)) {
    throw new ValidationError(`File content does not match a supported document type: ${fileName}`);
  }
  // Image extension mismatch (e.g. .png that is actually .jpg) is tolerated; document/image cross-over is not.
  const expectedIsImage = Boolean(expected?.startsWith("image/"));
  const detectedIsImage = detected.startsWith("image/");
  if (expectedIsImage !== detectedIsImage || (!detectedIsImage && expected !== detected)) {
    throw new ValidationError(`File content (${detected}) does not match its extension: ${fileName}`);
  }
  return { fileName, mimeType: detected, size: buffer.length };
}
