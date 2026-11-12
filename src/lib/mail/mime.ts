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

/** ヘッダーの値から改行・制御文字を取り除く（相手のヘッダーやフォームの値で別のヘッダーを差し込ませない） */
export function headerValue(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

/** quoted-string。\ も " もエスケープする（\ を残すと引用が閉じて、宛先を足せてしまう） */
function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export function formatAddress(a: Address): string {
  // アドレス部分に空白・改行・区切り文字は入らない。入っていたら取り除く
  const email = a.email.replace(/[\s<>,;"\x00-\x1f\x7f]/g, "");
  if (!a.name) return email;
  const plain = headerValue(a.name);
  const name = ASCII_PRINTABLE.test(plain) ? quoted(plain) : encodeHeaderWord(plain);
  return `${name} <${email}>`;
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
  // In-Reply-To・References は相手のメールのヘッダーから来る
  const inReplyTo = input.inReplyTo ? headerValue(input.inReplyTo) : "";
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (input.references || inReplyTo) {
    const refs = headerValue([input.references, inReplyTo].filter(Boolean).join(" "));
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
    // 転送する添付の名前と形式は相手のメールから来るので、引用を閉じたり改行を入れたりできないようにする
    const filename = headerValue(a.filename);
    const name = ASCII_PRINTABLE.test(filename) ? quoted(filename) : `"${encodeHeaderWord(filename)}"`;
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType) ? a.mimeType : "application/octet-stream";
    parts.push(
      [
        `Content-Type: ${mimeType}; name=${name}`,
        `Content-Disposition: attachment; filename=${name}`,
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
