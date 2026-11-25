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
  /** メルマガ・一斉配信（List-Unsubscribe か Precedence: bulk/list がある） */
  bulk: boolean;
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
      // 古い形式「taro@example.jp (山田太郎)」は、括弧の中を名前として扱う（アドレスに混ぜない）
      const comment = part.match(/^(\S+@\S+?)\s*\((.*)\)\s*$/);
      const email = (comment ? comment[1] : part).replace(/^mailto:/i, "").toLowerCase();
      result.push({ name: comment?.[2].trim() || null, email });
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
      const n = code.startsWith("#x") ? parseInt(code.slice(2), 16) : code.startsWith("#") ? parseInt(code.slice(1), 10) : NaN;
      if (code.startsWith("#")) return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** パートの Content-Type から文字コードを読む（宣言が無ければ null） */
function partCharset(part: Part): string | null {
  const ct = part.headers?.find((h) => h.name?.toLowerCase() === "content-type")?.value ?? "";
  return ct.match(/charset\s*=\s*["']?([^"';\s]+)/i)?.[1] ?? null;
}

/** 文字コード名の別名（メーラーごとの書き方の違い）を TextDecoder が知っている名前にそろえる */
export function normalizeCharset(label: string | null | undefined): string | null {
  const l = (label ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (!l) return null;
  if (/^(cp932|ms932|ms_kanji|windows-31j|x-sjis|sjis|s-jis|shift[-_]?jis(-?\d+)?|x-ms-cp932|csshiftjis|csWindows31J)$/i.test(l)) return "shift_jis";
  // ISO-2022-JP の拡張（-2・-3・MS・CP50220 系）は、基本の ISO-2022-JP で読める範囲がほとんど
  if (/^(iso-?2022-?jp(-\d|-ms)?|csiso2022jp|cp5022[012]|x-iso-2022-jp)$/i.test(l)) return "iso-2022-jp";
  if (/^(euc-?jp(-ms)?|x-euc-jp|eucjp-?(ms|win|open)?|cseucpkdfmtjapanese)$/i.test(l)) return "euc-jp";
  if (/^(utf-?8|unicode-1-1-utf-8|x-unicode20utf8)$/i.test(l)) return "utf-8";
  if (/^(us-)?ascii$|^ansi_x3\.4-1968$/i.test(l)) return "us-ascii";
  return l;
}

/**
 * 日本語の文としての自然さ。ひらがな・カタカナ・漢字を数え、半角カナは引く
 * （EUC-JP を Shift_JIS として読むと半角カナの羅列になるため）。文字コードの推定の手がかりにする
 */
function japaneseScore(text: string): number {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  return count(/[\u3040-\u309f]/g) * 2 + count(/[\u30a0-\u30ff\u4e00-\u9fff\u3000-\u303f]/g) - count(/[\uff61-\uff9f]/g) * 2;
}

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 文字コードの宣言が無い・間違っているときに、中身から推定して読む。
 * ESC $ B などがあれば ISO-2022-JP、UTF-8 として正しければ UTF-8、
 * どちらでもなければ Shift_JIS と EUC-JP のうち日本語らしく読める方。読めなければ null。
 */
export function sniffDecode(bytes: Uint8Array): string | null {
  if (/\x1b[$(][@BJI]/.test(Buffer.from(bytes).toString("latin1"))) {
    const jis = tryDecode("iso-2022-jp", bytes);
    if (jis !== null) return jis;
  }
  const utf8 = tryDecode("utf-8", bytes);
  if (utf8 !== null) return utf8;
  const candidates = [tryDecode("shift_jis", bytes), tryDecode("euc-jp", bytes)].filter((t): t is string => t !== null);
  if (!candidates.length) return null;
  return candidates.reduce((best, t) => (japaneseScore(t) > japaneseScore(best) ? t : best));
}

function hasNonAscii(bytes: Uint8Array): boolean {
  return bytes.some((b) => b >= 0x80 || b === 0x1b);
}

/**
 * バイト列を文字列にする。宣言どおりに読めればそれを使い、宣言が無い・壊れている・
 * 実際と違う（UTF-8 なのに us-ascii や iso-8859-1 と書かれている等）ときは中身から推定する。
 */
export function decodeBytes(bytes: Uint8Array, charset: string | null | undefined): string {
  const label = normalizeCharset(charset);
  if (!hasNonAscii(bytes)) return Buffer.from(bytes).toString("latin1");
  // 宣言が無い・us-ascii（ISO-2022-JP を us-ascii と書くメーラーがある）・ラテン文字系
  // （どんなバイト列でも読めてしまうので宣言が正しいか分からない）は、まず中身から推定する
  const weak = !label || label === "us-ascii" || /^(iso-8859-1|latin1|windows-1252|cp1252)$/.test(label);
  if (weak) {
    const sniffed = sniffDecode(bytes);
    // ラテン文字系の宣言は、UTF-8・ISO-2022-JP として正しく読めた（＝宣言が誤り）とき以外は宣言を信じる
    if (sniffed !== null && (!label || label === "us-ascii" || tryDecode("utf-8", bytes) !== null || /\x1b[$(]/.test(Buffer.from(bytes).toString("latin1")))) {
      return sniffed;
    }
  }
  if (label && label !== "us-ascii") {
    const strict = tryDecode(label, bytes);
    if (strict !== null) return strict;
    // 宣言どおりに読めない（文字コードの宣言違い）。中身から推定できればそちらを使う
    const sniffed = sniffDecode(bytes);
    if (sniffed !== null) return sniffed;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // 知らない文字コード名
    }
  }
  return sniffDecode(bytes) ?? new TextDecoder("utf-8").decode(bytes);
}

/**
 * Gmail API はパートを元の文字コードのまま返す。日本の業務メールに多い ISO-2022-JP や Shift_JIS を
 * UTF-8 として読むと文字化けするので、宣言された文字コード（無ければ推定）で読む。
 */
export function decodeText(data: string, charset: string | null): string {
  return decodeBytes(decodeBase64Url(data), charset);
}

/** HTML の <meta charset> / <meta http-equiv="Content-Type" content="...; charset=..."> を読む */
export function htmlMetaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  return head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_.:-]+)/i)?.[1] ?? null;
}

/**
 * ヘッダーの RFC 2047 符号化（=?ISO-2022-JP?B?...?=）を戻す。Gmail API はふつう戻してくれるが、
 * 文字コード名が珍しい・途中で分割されているなどで、符号のまま残ることがある。
 * 隣り合う同じ文字コードの符号は、バイト列をつなげてから読む（ISO-2022-JP は途中で切られると読めない）。
 */
export function decodeMimeWords(value: string): string {
  if (!value.includes("=?")) return value;
  const word = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  const out: string[] = [];
  let pending: { charset: string; bytes: Buffer[] } | null = null;
  const flush = () => {
    if (pending) out.push(decodeBytes(Buffer.concat(pending.bytes), pending.charset));
    pending = null;
  };
  let last = 0;
  for (const m of value.matchAll(word)) {
    const between = value.slice(last, m.index);
    // 符号どうしの間の空白は捨てる（RFC 2047）。それ以外の文字があれば区切る
    if (between && !/^\s+$/.test(between)) {
      flush();
      out.push(between);
    } else if (between && !pending) {
      out.push(between);
    }
    const charset = m[1].replace(/\*.*$/, ""); // 言語指定（=?ISO-2022-JP*ja?）を落とす
    const bytes =
      m[2].toLowerCase() === "b"
        ? Buffer.from(m[3], "base64")
        : Buffer.from(
            m[3].replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
            "latin1",
          );
    const key = normalizeCharset(charset) ?? charset;
    if (pending && (normalizeCharset(pending.charset) ?? pending.charset) === key) pending.bytes.push(bytes);
    else {
      flush();
      pending = { charset, bytes: [bytes] };
    }
    last = (m.index ?? 0) + m[0].length;
  }
  flush();
  out.push(value.slice(last));
  return out.join("");
}

/**
 * 8 ビットのまま送られた日本語のヘッダーが、1 バイトずつ Latin-1 の文字として読まれて
 * 「ã\u0081\u0093ã‚“」のようになっていたら直す。UTF-8 として正しく読めるか、
 * Shift_JIS・EUC-JP でかなを含む日本語になるときだけ直す（フランス語などの本物のアクセント文字は触らない）。
 */
export function repairLatin1Mojibake(value: string): string {
  if (!/[\u0080-\u00ff]{2}/.test(value) || /[^\u0000-\u00ff]/.test(value)) return value;
  const bytes = Buffer.from(value, "latin1");
  const utf8 = tryDecode("utf-8", bytes);
  if (utf8 !== null && /[^\u0000-\u00ff]/.test(utf8)) return utf8;
  for (const label of ["shift_jis", "euc-jp"]) {
    const t = tryDecode(label, bytes);
    if (t !== null && /[\u3040-\u30ff]/.test(t)) return t;
  }
  return value;
}

/** ヘッダーの値（件名・差出人名・添付ファイル名）を読める文字にする */
export function decodeHeaderText(value: string): string {
  return repairLatin1Mojibake(decodeMimeWords(value));
}

function walk(part: Part | undefined, out: { plain: string[]; html: string[]; attachments: AttachmentInfo[] }) {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  const filename = part.filename ? decodeHeaderText(part.filename) : "";
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
  if (mime === "text/plain" && part.body?.data) out.plain.push(decodeText(part.body.data, partCharset(part)));
  else if (mime === "text/html" && part.body?.data) {
    const bytes = decodeBase64Url(part.body.data);
    // HTML は Content-Type に書かず <meta charset> だけで宣言していることがある
    out.html.push(decodeBytes(bytes, partCharset(part) ?? htmlMetaCharset(bytes)));
  }
  for (const child of part.parts ?? []) walk(child, out);
}

function decodeNames(list: Address[]): Address[] {
  return list.map((a) => (a.name ? { ...a, name: decodeHeaderText(a.name).replace(/^"(.*)"$/, "$1").trim() || null } : a));
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
    from: decodeNames(parseAddressList(header(msg, "From")))[0] ?? null,
    replyTo: decodeNames(parseAddressList(header(msg, "Reply-To")))[0] ?? null,
    to: decodeNames(parseAddressList(headerValues(msg, "To").join(","))),
    cc: decodeNames(parseAddressList(headerValues(msg, "Cc").join(","))),
    deliveredTo: headerValues(msg, "Delivered-To").map((v) => v.trim().toLowerCase()),
    listId: header(msg, "List-Id"),
    subject: decodeHeaderText(header(msg, "Subject") ?? ""),
    date,
    messageIdHeader: header(msg, "Message-ID") ?? header(msg, "Message-Id"),
    references: header(msg, "References"),
    bulk: Boolean(header(msg, "List-Unsubscribe")) || /^(bulk|list|junk)$/i.test((header(msg, "Precedence") ?? "").trim()),
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
