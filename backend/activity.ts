import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";

/**
 * Per-client CV activity for the platform owner: how many CVs each client has
 * fetched, broken down by day, and exactly when each one arrived.
 *
 * "Fetched" means a CV that entered the client's workspace — a manual upload or
 * a file imported from their Drive folder — dated by when it arrived here, not
 * by the file's own Drive timestamps. Counts are of CVs that still exist: a CV
 * the client deleted no longer appears.
 *
 * Days are the viewer's days. A CV uploaded at 00:30 in Kolkata belongs to that
 * date there, but to the previous day in UTC; grouping in UTC would put it on
 * the wrong row for the person reading the table. The browser sends its IANA
 * zone and the database does the grouping in it.
 */

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

function validZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export const activityQuerySchema = z.object({
  from: dateString,
  to: dateString,
  tz: z.string().max(64).optional(),
});

export const dayQuerySchema = z.object({
  date: dateString,
  tz: z.string().max(64).optional(),
});

export interface DayActivity {
  day: string; // YYYY-MM-DD in the requested zone
  total: number;
  manual: number;
  drive: number;
  first: string; // ISO instant of the first CV that day
  last: string;
}

export async function getWorkspaceActivity(workspaceId: string, q: z.infer<typeof activityQuerySchema>) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true, isActive: true, createdAt: true, _count: { select: { users: true, cvFiles: true } } },
  });
  if (!workspace) throw new NotFoundError("Client not found");
  const tz = validZone(q.tz);

  // Bounds are converted from local midnight to UTC on the right-hand side, so
  // the (workspaceId, createdAt) index still serves the range scan.
  const rows = await prisma.$queryRaw<Array<{ day: string; total: number; manual: number; drive: number; first: Date; last: Date }>>(Prisma.sql`
    SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
           count(*)::int                                              AS total,
           (count(*) FILTER (WHERE "sourceType" = 'MANUAL'))::int       AS manual,
           (count(*) FILTER (WHERE "sourceType" = 'GOOGLE_DRIVE'))::int AS drive,
           min("createdAt") AS first,
           max("createdAt") AS last
      FROM "CVFile"
     WHERE "workspaceId" = ${workspaceId}
       AND "createdAt" >= ((${q.from}::date)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'
       AND "createdAt" <  (((${q.to}::date + 1))::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'
     GROUP BY 1
     ORDER BY 1 DESC`);

  const now = Date.now();
  const [last7, last30, latest] = await Promise.all([
    prisma.cVFile.count({ where: { workspaceId, createdAt: { gte: new Date(now - 7 * 864e5) } } }),
    prisma.cVFile.count({ where: { workspaceId, createdAt: { gte: new Date(now - 30 * 864e5) } } }),
    prisma.cVFile.findFirst({ where: { workspaceId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);

  const days: DayActivity[] = rows.map((r) => ({
    day: r.day,
    total: r.total,
    manual: r.manual,
    drive: r.drive,
    first: new Date(r.first).toISOString(),
    last: new Date(r.last).toISOString(),
  }));

  return {
    workspace,
    tz,
    range: { from: q.from, to: q.to, total: days.reduce((a, d) => a + d.total, 0) },
    summary: { allTime: workspace._count.cvFiles, last7Days: last7, last30Days: last30, lastFetchedAt: latest?.createdAt ?? null },
    days,
  };
}

/** Every CV a client fetched on one day, with the time it arrived. */
export async function getWorkspaceDay(workspaceId: string, q: z.infer<typeof dayQuerySchema>) {
  const tz = validZone(q.tz);
  const bounds = await prisma.$queryRaw<Array<{ start: Date; end: Date }>>(Prisma.sql`
    SELECT ((${q.date}::date)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC' AS start,
           (((${q.date}::date + 1))::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC' AS "end"`);
  const { start, end } = bounds[0];

  const files = await prisma.cVFile.findMany({
    where: { workspaceId, createdAt: { gte: start, lt: end } },
    orderBy: { createdAt: "asc" },
    take: 1000,
    select: {
      id: true,
      fileName: true,
      sourceType: true,
      status: true,
      createdAt: true,
      uploadedBy: { select: { name: true } },
      candidate: { select: { candidateName: true } },
    },
  });
  return { date: q.date, tz, files };
}
