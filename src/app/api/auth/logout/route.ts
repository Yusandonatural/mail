import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { destroySession } from "@/lib/session";

export async function POST() {
  await destroySession();
  return NextResponse.redirect(new URL("/login", config().APP_BASE_URL), 303);
}
