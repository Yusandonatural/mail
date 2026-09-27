import type { Address, GmailMessage } from "@/lib/mail/parse";
import type { DraftRef, GmailThread, MailApi } from "@/lib/google/mail-api";
import { toBase64Url } from "@/lib/mail/mime";

export interface FixtureInput {
  id: string;
  threadId?: string;
  from: string;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  html?: string;
  labelIds?: string[];
  date?: Date;
  listId?: string;
  messageId?: string;
  attachments?: Array<{ filename: string; mimeType: string; attachmentId: string }>;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export function gmailMessage(f: FixtureInput): GmailMessage {
  const headers = [
    { name: "From", value: f.from },
    { name: "To", value: f.to ?? "info@yusando.com" },
    { name: "Subject", value: f.subject ?? "件名" },
    { name: "Message-ID", value: f.messageId ?? `<${f.id}@example.com>` },
  ];
  if (f.cc) headers.push({ name: "Cc", value: f.cc });
  if (f.listId) headers.push({ name: "List-Id", value: f.listId });
  const textPart = { mimeType: "text/plain", body: { data: b64(f.text ?? "本文") } };
  const parts: NonNullable<GmailMessage["payload"]>[] = [];
  if (f.html) parts.push({ mimeType: "text/html", body: { data: b64(f.html) } });
  else parts.push(textPart);
  (f.attachments ?? []).forEach((a, i) => {
    parts.push({ partId: String(i + 1), mimeType: a.mimeType, filename: a.filename, body: { attachmentId: a.attachmentId, size: 10 } });
  });
  return {
    id: f.id,
    threadId: f.threadId ?? `t-${f.id}`,
    labelIds: f.labelIds ?? ["INBOX", "UNREAD"],
    internalDate: String((f.date ?? new Date("2026-09-27T01:00:00Z")).getTime()),
    payload: { mimeType: "multipart/mixed", headers, parts },
  };
}

export class FakeMail implements MailApi {
  messages = new Map<string, GmailMessage>();
  labels = new Map<string, string>(); // name -> id
  modifications: Array<{ id: string; add: string[]; remove: string[]; thread?: boolean }> = [];
  drafts = new Map<string, { raw: string; threadId: string | null; messageId: string }>();
  sendAs: Address[] = [];
  private seq = 0;

  add(...msgs: GmailMessage[]) {
    for (const m of msgs) this.messages.set(m.id ?? "", m);
  }

  labelName(id: string): string | undefined {
    return [...this.labels.entries()].find(([, v]) => v === id)?.[0];
  }

  /** メッセージに付けられたラベル名の一覧 */
  labelsAddedTo(id: string): string[] {
    return this.modifications
      .filter((m) => m.id === id && !m.thread)
      .flatMap((m) => m.add.map((l) => this.labelName(l) ?? l));
  }

  async getProfile() {
    return { emailAddress: "isozaki@yusando.com", historyId: "100" };
  }
  async getMessage(id: string) {
    const m = this.messages.get(id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
  }
  async getThread(threadId: string): Promise<GmailThread> {
    return { id: threadId, messages: [...this.messages.values()].filter((m) => m.threadId === threadId) };
  }
  async listHistory() {
    return { messageIds: [...this.messages.keys()], historyId: "200" };
  }
  async listMessageIds() {
    return [...this.messages.keys()];
  }
  async listLabels() {
    return [...this.labels.entries()].map(([name, id]) => ({ id, name }));
  }
  async createLabel(name: string) {
    const id = `L${++this.seq}`;
    this.labels.set(name, id);
    return { id, name };
  }
  async modifyMessage(id: string, add: string[], remove: string[]) {
    this.modifications.push({ id, add, remove });
  }
  async modifyThread(threadId: string, add: string[], remove: string[]) {
    this.modifications.push({ id: threadId, add, remove, thread: true });
  }
  async trashMessage() {}
  private rawToMessage(raw: string, threadId: string | null, id: string): GmailMessage {
    // テストでは生成した MIME の本文だけ読めればよい
    const [head, ...rest] = raw.split("\r\n\r\n");
    const body = Buffer.from(rest.join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8");
    const headers = head.split("\r\n").map((line) => {
      const i = line.indexOf(":");
      return { name: line.slice(0, i), value: line.slice(i + 1).trim() };
    });
    return {
      id,
      threadId,
      labelIds: ["DRAFT"],
      payload: { mimeType: "text/plain", headers, body: { data: b64(body) } },
    };
  }
  async createDraft(raw: string, threadId: string | null): Promise<DraftRef> {
    const draftId = `d${++this.seq}`;
    const messageId = `dm${this.seq}`;
    this.drafts.set(draftId, { raw, threadId, messageId });
    return { draftId, messageId, threadId };
  }
  async updateDraft(draftId: string, raw: string, threadId: string | null): Promise<DraftRef> {
    const existing = this.drafts.get(draftId);
    if (!existing) throw new Error("no draft");
    this.drafts.set(draftId, { raw, threadId, messageId: existing.messageId });
    return { draftId, messageId: existing.messageId, threadId };
  }
  async getDraft(draftId: string) {
    const d = this.drafts.get(draftId);
    if (!d) return null;
    return { draftId, message: this.rawToMessage(d.raw, d.threadId, d.messageId) };
  }
  /** 人が Gmail 上で下書きを直したことにする */
  editDraftBody(draftId: string, text: string) {
    const d = this.drafts.get(draftId)!;
    const [head] = d.raw.split("\r\n\r\n");
    d.raw = `${head}\r\n\r\n${Buffer.from(text, "utf8").toString("base64")}`;
  }
  async getAttachment() {
    return Buffer.from("file");
  }
  async sendAsAddresses() {
    return this.sendAs;
  }
  async watch() {
    return { historyId: "150", expiration: new Date(Date.now() + 7 * 864e5) };
  }
}

export { toBase64Url };
