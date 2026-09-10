import { getSession } from "@/lib/auth";
import { jobFiltersSchema, listJobs, batchProgress } from "@/backend/jobs";
import { getDashboardStats } from "@/backend/stats";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/jobs/stream?batchId=...   (Server-Sent Events)
 * Pushes progress + recent job rows every 2 seconds while the client is
 * connected, so the Upload / Jobs pages update live without polling storms.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const parsed = jobFiltersSchema.safeParse(Object.fromEntries(url.searchParams));
  const filters = parsed.success ? parsed.data : jobFiltersSchema.parse({});

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = async () => {
        if (closed) return;
        try {
          const [jobs, progress, stats] = await Promise.all([listJobs({ ...filters, pageSize: Math.min(filters.pageSize, 100) }), batchProgress(filters.batchId), getDashboardStats()]);
          const payload = JSON.stringify({ at: Date.now(), progress, stats, jobs: jobs.items, total: jobs.total });
          controller.enqueue(encoder.encode(`event: update\ndata: ${payload}\n\n`));
        } catch (err) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`));
        }
      };
      controller.enqueue(encoder.encode(`retry: 3000\n\n`));
      await send();
      timer = setInterval(send, 2000);
      req.signal.addEventListener("abort", () => {
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
