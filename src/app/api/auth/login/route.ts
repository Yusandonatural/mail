import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { authUrl } from "@/lib/google/oauth";
import { setOAuthState } from "@/lib/session";

export async function GET() {
  const state = randomBytes(24).toString("base64url");
  await setOAuthState(state);
  return NextResponse.redirect(authUrl(state));
}
