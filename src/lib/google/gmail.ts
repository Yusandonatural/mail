import { gmail, type gmail_v1 } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import { decodeBase64Url, type Address } from "../mail/parse";
import { toBase64Url } from "../mail/mime";
import { HistoryExpiredError, type DraftRef, type MailApi } from "./mail-api";

function status(err: unknown): number | undefined {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const code = typeof e.code === "number" ? e.code : Number(e.code);
  return e.status ?? e.response?.status ?? (Number.isFinite(code) ? code : undefined);
}

export class GoogleMailApi implements MailApi {
  private api: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.api = gmail({ version: "v1", auth });
  }

  async getProfile() {
    const res = await this.api.users.getProfile({ userId: "me" });
    return { emailAddress: res.data.emailAddress ?? "", historyId: res.data.historyId ?? "" };
  }

  async getMessage(id: string) {
    const res = await this.api.users.messages.get({ userId: "me", id, format: "full" });
    return res.data;
  }

  async getThread(threadId: string) {
    const res = await this.api.users.threads.get({ userId: "me", id: threadId, format: "full" });
    return res.data;
  }

  async listHistory(startHistoryId: string) {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let historyId = startHistoryId;
    try {
      do {
        const res = await this.api.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded"],
          pageToken,
          maxResults: 500,
        });
        for (const h of res.data.history ?? []) {
          for (const added of h.messagesAdded ?? []) if (added.message?.id) ids.add(added.message.id);
        }
        historyId = res.data.historyId ?? historyId;
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (err) {
      if (status(err) === 404) throw new HistoryExpiredError();
      throw err;
    }
    return { messageIds: [...ids], historyId };
  }

  async listMessageIds(query: string, max: number) {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.api.users.messages.list({
        userId: "me",
        q: query,
        pageToken,
        maxResults: Math.min(500, max - ids.length),
      });
      for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && ids.length < max);
    return ids;
  }

  async listLabels() {
    const res = await this.api.users.labels.list({ userId: "me" });
    return (res.data.labels ?? []).map((l) => ({ id: l.id ?? "", name: l.name ?? "" }));
  }

  async createLabel(name: string) {
    const res = await this.api.users.labels.create({
      userId: "me",
      requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    return { id: res.data.id ?? "", name: res.data.name ?? name };
  }

  async modifyMessage(id: string, add: string[], remove: string[]) {
    if (!add.length && !remove.length) return;
    await this.api.users.messages.modify({
      userId: "me",
      id,
      requestBody: { addLabelIds: add, removeLabelIds: remove },
    });
  }

  async modifyThread(threadId: string, add: string[], remove: string[]) {
    if (!add.length && !remove.length) return;
    await this.api.users.threads.modify({
      userId: "me",
      id: threadId,
      requestBody: { addLabelIds: add, removeLabelIds: remove },
    });
  }

  async trashMessage(id: string) {
    await this.api.users.messages.trash({ userId: "me", id });
  }

  private toRef(d: gmail_v1.Schema$Draft): DraftRef {
    return { draftId: d.id ?? "", messageId: d.message?.id ?? "", threadId: d.message?.threadId ?? null };
  }

  async createDraft(raw: string, threadId: string | null) {
    const res = await this.api.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: toBase64Url(raw), threadId: threadId ?? undefined } },
    });
    return this.toRef(res.data);
  }

  async updateDraft(draftId: string, raw: string, threadId: string | null) {
    const res = await this.api.users.drafts.update({
      userId: "me",
      id: draftId,
      requestBody: { id: draftId, message: { raw: toBase64Url(raw), threadId: threadId ?? undefined } },
    });
    return this.toRef(res.data);
  }

  async getDraft(draftId: string) {
    try {
      const res = await this.api.users.drafts.get({ userId: "me", id: draftId, format: "full" });
      if (!res.data.message) return null;
      return { draftId, message: res.data.message };
    } catch (err) {
      if (status(err) === 404) return null;
      throw err;
    }
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const res = await this.api.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
    return decodeBase64Url(res.data.data ?? "");
  }

  async sendAsAddresses(): Promise<Address[]> {
    const res = await this.api.users.settings.sendAs.list({ userId: "me" });
    return (res.data.sendAs ?? [])
      .filter((s) => s.sendAsEmail && (s.verificationStatus === "accepted" || s.isPrimary))
      .map((s) => ({ email: (s.sendAsEmail ?? "").toLowerCase(), name: s.displayName || null }));
  }

  async watch(topicName: string) {
    const res = await this.api.users.watch({ userId: "me", requestBody: { topicName } });
    return {
      historyId: res.data.historyId ?? "",
      expiration: new Date(Number(res.data.expiration ?? Date.now())),
    };
  }
}
