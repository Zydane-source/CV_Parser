import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redisHealthy } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  const redis = await redisHealthy();
  const status = db && redis ? 200 : 503;
  return NextResponse.json({ ok: status === 200, db, redis, time: new Date().toISOString() }, { status });
}
