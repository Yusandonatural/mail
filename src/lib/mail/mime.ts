import type { Address } from "./parse";

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface MimeInput {
  from?: Address | null;
  to: Address[];
  cc?: Address[];
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: MimeAttachment[];
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** RFC 2047 のエンコード。UTF-8 の文字境界で区切る */
export function encodeHeaderWord(value: string): string {
  if (ASCII_PRINTABLE.test(value)) return value;
  const chunks: string[] = [];
  let current = "";
  for (const ch of value) {
    if (Buffer.byteLength(current + ch, "utf8") > 45) {
      chunks.push(current);
      current = "";
    }
    current += ch;
  }
  if (current) chunks.push(current);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`).join("\r\n ");
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  const name = ASCII_PRINTABLE.test(a.name) ? `"${a.name.replace(/"/g, '\\"')}"` : encodeHeaderWord(a.name);
  return `${name} <${a.email}>`;
}

export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^(re|ｒｅ)\s*[:：]/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(subject: string): string {
  const s = subject.trim();
  return /^(fwd?|転送)\s*[:：]/i.test(s) ? s : `Fwd: ${s}`;
}

function base64Lines(data: Buffer): string {
  return (data.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/** Gmail API の raw に入れる RFC 5322 メッセージを作る */
export function buildMime(input: MimeInput): string {
  const headers: string[] = ["MIME-Version: 1.0"];
  if (input.from) headers.push(`From: ${formatAddress(input.from)}`);
  if (input.to.length) headers.push(`To: ${input.to.map(formatAddress).join(", ")}`);
  if (input.cc?.length) headers.push(`Cc: ${input.cc.map(formatAddress).join(", ")}`);
  headers.push(`Subject: ${encodeHeaderWord(input.subject)}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references || input.inReplyTo) {
    const refs = [input.references, input.inReplyTo].filter(Boolean).join(" ").trim();
    headers.push(`References: ${refs}`);
  }
  const textPart = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(input.text.replace(/\r?\n/g, "\r\n"), "utf8")),
  ].join("\r\n");

  if (!input.attachments?.length) {
    return `${headers.join("\r\n")}\r\n${textPart}\r\n`;
  }
  const boundary = `yusando_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [textPart];
  for (const a of input.attachments) {
    const name = encodeHeaderWord(a.filename);
    parts.push(
      [
        `Content-Type: ${a.mimeType}; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(a.data),
      ].join("\r\n"),
    );
  }
  const body = parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") + `\r\n--${boundary}--\r\n`;
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
