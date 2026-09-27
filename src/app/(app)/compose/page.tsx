import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { canSeeMessage } from "@/lib/access";
import { mailFor } from "@/lib/services";
import { getSetting } from "@/lib/settings";
import { forwardSubject } from "@/lib/mail/mime";
import { parseMessage } from "@/lib/mail/parse";
import { formatJst } from "@/lib/time";
import { ComposeForm, type ComposeDefaults } from "@/components/compose-form";

export default async function ComposePage({ searchParams }: { searchParams: Promise<{ forward?: string }> }) {
  const { forward } = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  let mail: ReturnType<typeof mailFor> | null = null;
  let error: string | null = null;
  try {
    mail = mailFor(user);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const sendAs = (await mail?.sendAsAddresses().catch(() => null)) ?? [{ email: user.email, name: user.name }];
  const sigs = await getSetting(db, "signatures");
  const defaults: ComposeDefaults = {
    from: user.email,
    to: "",
    cc: "",
    subject: "",
    text: `\n\n${sigs.ja}`,
    forwardRowId: null,
    attachmentNames: [],
  };

  if (forward && mail) {
    const row = (
      await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, Number(forward)), eq(messages.userId, user.id)))
        .limit(1)
    )[0];
    if (row && canSeeMessage(user, row)) {
      const m = parseMessage(await mail.getMessage(row.gmailMessageId));
      defaults.subject = forwardSubject(m.subject);
      defaults.forwardRowId = row.id;
      defaults.attachmentNames = m.attachments.map((a) => a.filename);
      defaults.text = [
        "",
        "",
        sigs.ja,
        "",
        "---------- 転送メッセージ ----------",
        `From: ${m.from?.name ? `${m.from.name} <${m.from.email}>` : m.from?.email}`,
        `Date: ${formatJst(m.date)}`,
        `Subject: ${m.subject}`,
        `To: ${m.to.map((a) => a.email).join(", ")}`,
        "",
        m.text,
      ].join("\n");
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>{defaults.forwardRowId ? "転送" : "新規作成"}</h1>
      </div>
      {error ? <div className="banner error">{error}。一度ログアウトして、ログインし直してください。</div> : null}
      <ComposeForm defaults={defaults} fromOptions={sendAs} clientId={process.env.GOOGLE_CLIENT_ID ?? ""} />
    </>
  );
}
