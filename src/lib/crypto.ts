import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY は 32 バイトを base64 にした値にしてください");
  return buf;
}

/** AES-256-GCM。保存形式は iv.tag.ciphertext（それぞれ base64） */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(stored: string): string {
  const [iv, tag, enc] = stored.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 下書き本文の比較用ハッシュ（改行コード・前後の空白の違いは無視） */
export function bodyHash(text: string): string {
  return sha256(text.replace(/\r\n/g, "\n").trim());
}
