import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { canSeeMessage } from "@/lib/access";
import { currentUser } from "@/lib/session";
import { mailFor } from "@/lib/services";
import { parseMessage } from "@/lib/mail/parse";

/** ブラウザで開いてよい形式。それ以外は必ずダウンロードにする */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]);

export async function GET(req: NextRequest, ctx: { params: Promise<{ messageId: string; partId: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });
  const { messageId, partId } = await ctx.params;
  const db = await getDb();
  const row = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, user.id), eq(messages.gmailMessageId, messageId)))
      .limit(1)
  )[0];
  if (row && !canSeeMessage(user, row)) return new NextResponse("forbidden", { status: 403 });

  const mail = mailFor(user);
  const parsed = parseMessage(await mail.getMessage(messageId));
  const info = parsed.attachments.find((a) => a.partId === partId);
  if (!info) return new NextResponse("not found", { status: 404 });
  const data = await mail.getAttachment(messageId, info.attachmentId);

  const wantInline = req.nextUrl.searchParams.get("inline") === "1" && INLINE_TYPES.has(info.mimeType);
  const disposition = `${wantInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(info.filename)}`;
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": wantInline ? info.mimeType : "application/octet-stream",
      "Content-Disposition": disposition,
      "X-Content-Type-Options": "nosniff",
      // Chrome の PDF ビューアは sandbox の中では開けないので、PDF のプレビューだけ外す
      ...(wantInline && info.mimeType === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox" }),
      "Cache-Control": "private, no-store",
    },
  });
}
