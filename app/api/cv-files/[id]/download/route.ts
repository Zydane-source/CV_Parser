import { z } from "zod";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { getStorage } from "@/services/storage";
import { downloadDriveFile } from "@/services/google-drive/files";
import { workspaceScope } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/cv-files/:id/download – stream the original CV (authenticated).
 * Served as an attachment with nosniff so uploaded content is never executed/rendered as HTML.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  // This route returns the CV bytes themselves, so it is the one place where an
  // unscoped lookup would hand over a whole document rather than a row of
  // metadata. Scoped by the same rule as every other id-addressed read.
  const cv = await prisma.cVFile.findFirst({
    where: { id: z.string().min(1).max(64).parse(id), ...workspaceScope(user) },
  });
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
