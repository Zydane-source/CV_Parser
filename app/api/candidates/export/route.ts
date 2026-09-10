import { z } from "zod";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { RateLimitError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { candidateFiltersSchema, iterateCandidates } from "@/backend/candidates";
import { UTF8_BOM, csvRow, csvFileName } from "@/services/export/csv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/candidates/export?<same filters as /api/candidates>[&columns=all]
 *
 * Streams the current candidate selection as CSV. Default columns are the three
 * extracted fields; `columns=all` adds the provenance columns that the Google
 * Sheets export carries. Rows are streamed page by page so a large export never
 * materialises in memory.
 */
const CORE_HEADERS = ["Candidate Name", "Phone Number", "Job Role Applied For"];
const ALL_HEADERS = [...CORE_HEADERS, "CV File Name", "CV Link", "Source", "Status", "Confidence", "Processed At"];

const querySchema = candidateFiltersSchema
  .omit({ page: true, pageSize: true })
  .extend({ columns: z.enum(["core", "all"]).default("core") });

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const rl = await rateLimit(`csv-export:${user.id}`, 30, 600);
  if (!rl.allowed) throw new RateLimitError("Too many exports. Please wait a few minutes.");

  const url = new URL(req.url);
  const raw: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (raw[k] = v));
  const { columns, ...filters } = querySchema.parse(raw);
  const appUrl = `${url.protocol}//${url.host}`;

  const headers = columns === "all" ? ALL_HEADERS : CORE_HEADERS;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(UTF8_BOM + csvRow(headers)));
        for await (const row of iterateCandidates(filters)) {
          const c = row.candidate;
          const core = [c?.candidateName ?? "Not Found", c?.phoneNumber ?? "Not Found", c?.jobRoleAppliedFor ?? "Not Found"];
          if (columns === "core") {
            controller.enqueue(encoder.encode(csvRow(core)));
            continue;
          }
          const link = row.sourceType === "GOOGLE_DRIVE" && row.driveUrl ? row.driveUrl : `${appUrl}/api/cv-files/${row.id}/download`;
          controller.enqueue(
            encoder.encode(
              csvRow([
                ...core,
                row.fileName,
                link,
                row.sourceType === "GOOGLE_DRIVE" ? "Google Drive" : "Manual Upload",
                row.status.replace("_", " "),
                c ? String(Math.round(c.overallConfidence * 100) / 100) : "",
                c?.processedAt ? c.processedAt.toISOString() : "",
              ]),
            ),
          );
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFileName()}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
