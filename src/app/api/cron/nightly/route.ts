import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { cronAuthorized } from "@/lib/cron-auth";
import { startNightlySummaries } from "@/lib/contacts";
import { mailFor } from "@/lib/services";

export const maxDuration = 300;

/** 毎晩：連絡先ごとのやりとりの要約を Message Batches で作る */
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const db = await getDb();
  const batchId = await startNightlySummaries(db, mailFor);
  return NextResponse.json({ batchId });
}
