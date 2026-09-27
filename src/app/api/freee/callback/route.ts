import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { config } from "@/lib/config";
import { audit } from "@/lib/audit";
import { exchangeFreeeCode, FreeeHttpApi, saveFreeeConnection } from "@/lib/freee";
import { requireAdmin, takeOAuthState } from "@/lib/session";

function back(message: string) {
  const url = new URL("/settings", config().APP_BASE_URL);
  url.searchParams.set("freee", message);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = await takeOAuthState("/api/freee");
  if (!code || !state || state !== expected) return back("連携をやり直してください");
  try {
    const token = await exchangeFreeeCode(code);
    const companies = await new FreeeHttpApi(async () => token.access_token).companies();
    const db = await getDb();
    await saveFreeeConnection(db, token.refresh_token, companies, admin.email);
    await audit(db, admin.id, "settings_changed", "freee", { connected: true, companies: companies.length });
    return back("連携しました");
  } catch (err) {
    return back(err instanceof Error ? err.message : "連携に失敗しました");
  }
}
