import { z } from "zod";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { getStorage } from "@/services/storage";
import { downloadDriveFile } from "@/services/google-drive/files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/cv-files/:id/download – stream the original CV (authenticated).
 * Served as an attachment with nosniff so uploaded content is never executed/rendered as HTML.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  await requireUser();
  const { id } = await ctx.params;
  const cv = await prisma.cVFile.findUnique({ where: { id: z.string().min(1).max(64).parse(id) } });
  if (!cv) throw new NotFoundError("CV not found");

  const inline = new URL(req.url).searchParams.get("inline") === "1";
  const buffer = cv.sourceType === "MANUAL" && cv.storagePath ? await getStorage().get(cv.storagePath) : await downloadDriveFile(cv.driveConnectionId, cv.sourceFileId!);
  const safeName = cv.fileName.replace(/["\r\n]/g, "_");
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": cv.mimeType,
      "Content-Length": String(buffer.length),
      "Content-Disposition": `${inline && (cv.mimeType === "application/pdf" || cv.mimeType.startsWith("image/")) ? "inline" : "attachment"}; filename="${safeName}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});
