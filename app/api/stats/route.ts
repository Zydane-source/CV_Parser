import { handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDashboardStats } from "@/backend/stats";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  await requireUser();
  return ok(await getDashboardStats());
});
