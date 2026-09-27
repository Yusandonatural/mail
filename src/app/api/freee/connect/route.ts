import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { freeeAuthUrl, freeeConfigured } from "@/lib/freee";
import { requireAdmin, setOAuthState } from "@/lib/session";

export async function GET() {
  await requireAdmin();
  if (!freeeConfigured()) return new NextResponse("FREEE_CLIENT_ID と FREEE_CLIENT_SECRET を設定してください", { status: 400 });
  const state = randomBytes(24).toString("base64url");
  await setOAuthState(state, "/api/freee");
  return NextResponse.redirect(freeeAuthUrl(state));
}
