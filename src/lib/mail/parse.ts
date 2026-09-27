import type { gmail_v1 } from "@googleapis/gmail";

export type GmailMessage = gmail_v1.Schema$Message;
type Part = gmail_v1.Schema$MessagePart;

export interface Address {
  name: string | null;
  email: string;
}

export interface AttachmentInfo {
  /** Gmail の attachmentId は取得のたびに変わりうるので、ダウンロードには partId を使う */
  partId: string;
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from: Address | null;
  replyTo: Address | null;
  to: Address[];
  cc: Address[];
  deliveredTo: string[];
  listId: string | null;
  subject: string;
  date: Date;
  messageIdHeader: string | null;
  references: string | null;
  text: string;
  html: string | null;
  attachments: AttachmentInfo[];
}

export function headerValues(msg: GmailMessage, name: string): string[] {
  const lower = name.toLowerCase();
  return (msg.payload?.headers ?? [])
    .filter((h) => h.name?.toLowerCase() === lower && typeof h.value === "string")
    .map((h) => h.value as string);
}

export function header(msg: GmailMessage, name: string): string | null {
  return headerValues(msg, name)[0] ?? null;
}

/** "山田 <a@b.jp>, "Doe, Jane" <c@d.com>, e@f.com" を分解する */
export function parseAddressList(value: string | null | undefined): Address[] {
  if (!value) return [];
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of value) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  const result: Address[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const angle = part.match(/^(.*)<([^>]+)>\s*$/);
    if (angle) {
      const name = angle[1].trim().replace(/^"(.*)"$/, "$1").trim();
      const email = angle[2].trim().toLowerCase();
      if (email.includes("@")) result.push({ name: name || null, email });
    } else if (part.includes("@")) {
      result.push({ name: null, email: part.replace(/^mailto:/i, "").toLowerCase() });
    }
  }
  return result;
}

/** Google グループの List-Id（<keiri.yusando.com>）を keiri@yusando.com に直す */
export function listIdToAddress(listId: string | null): string | null {
  if (!listId) return null;
  const inner = listId.match(/<([^>]+)>/)?.[1] ?? listId.trim();
  const dot = inner.indexOf(".");
  if (dot <= 0) return null;
  return `${inner.slice(0, dot)}@${inner.slice(dot + 1)}`.toLowerCase();
}

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "・")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code.startsWith("#x")) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walk(part: Part | undefined, out: { plain: string[]; html: string[]; attachments: AttachmentInfo[] }) {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  const filename = part.filename ?? "";
  if (filename && part.body?.attachmentId) {
    out.attachments.push({
      partId: part.partId ?? "",
      filename,
      mimeType: mime || "application/octet-stream",
      attachmentId: part.body.attachmentId,
      size: part.body.size ?? 0,
    });
    return;
  }
  if (mime === "text/plain" && part.body?.data) out.plain.push(decodeBase64Url(part.body.data).toString("utf8"));
  else if (mime === "text/html" && part.body?.data) out.html.push(decodeBase64Url(part.body.data).toString("utf8"));
  for (const child of part.parts ?? []) walk(child, out);
}

export function parseMessage(msg: GmailMessage): ParsedMessage {
  const out = { plain: [] as string[], html: [] as string[], attachments: [] as AttachmentInfo[] };
  walk(msg.payload ?? undefined, out);
  const html = out.html.length ? out.html.join("\n") : null;
  const text = out.plain.length ? out.plain.join("\n").trim() : html ? htmlToText(html) : (msg.snippet ?? "");
  const dateHeader = header(msg, "Date");
  const internal = msg.internalDate ? new Date(Number(msg.internalDate)) : null;
  const parsedDate = dateHeader ? new Date(dateHeader) : null;
  const date = internal ?? (parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date());
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    labelIds: msg.labelIds ?? [],
    from: parseAddressList(header(msg, "From"))[0] ?? null,
    replyTo: parseAddressList(header(msg, "Reply-To"))[0] ?? null,
    to: parseAddressList(headerValues(msg, "To").join(",")),
    cc: parseAddressList(headerValues(msg, "Cc").join(",")),
    deliveredTo: headerValues(msg, "Delivered-To").map((v) => v.trim().toLowerCase()),
    listId: header(msg, "List-Id"),
    subject: header(msg, "Subject") ?? "",
    date,
    messageIdHeader: header(msg, "Message-ID") ?? header(msg, "Message-Id"),
    references: header(msg, "References"),
    text,
    html,
    attachments: out.attachments,
  };
}

/** 引用部分（> で始まる行・「On ... wrote:」以降）を落として、そのメールで新しく書かれた部分だけにする */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line)) break;
    if (/^\d{4}年\d{1,2}月\d{1,2}日.*(書きました|wrote|>:)\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (line.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}
