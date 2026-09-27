import type { gmail_v1 } from "@googleapis/gmail";
import type { Address, GmailMessage } from "../mail/parse";

export type GmailThread = gmail_v1.Schema$Thread;

export class HistoryExpiredError extends Error {
  constructor() {
    super("Gmail の履歴 ID が古すぎます");
  }
}

/** メッセージが既に無い（下書きの差し替え・削除など） */
export class MessageNotFoundError extends Error {
  constructor(id: string) {
    super(`メッセージ ${id} は Gmail にありません`);
  }
}

export interface DraftRef {
  draftId: string;
  messageId: string;
  threadId: string | null;
}

/**
 * このアプリが Gmail に対して行う操作の全て。
 * 送信（messages.send / drafts.send）は意図的に含めていない。
 */
export interface MailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  /** 無ければ MessageNotFoundError */
  getMessage(id: string): Promise<GmailMessage>;
  getThread(threadId: string): Promise<GmailThread>;
  /** startHistoryId 以降に追加されたメッセージ ID（下書きは除く）。古すぎれば HistoryExpiredError */
  /** readIds は Gmail 側（スマホの Gmail など）で既読にされたメッセージ */
  listHistory(startHistoryId: string): Promise<{ messageIds: string[]; readIds: string[]; historyId: string }>;
  listMessageIds(query: string, max: number): Promise<string[]>;
  listLabels(): Promise<Array<{ id: string; name: string }>>;
  createLabel(name: string): Promise<{ id: string; name: string }>;
  modifyMessage(id: string, add: string[], remove: string[]): Promise<void>;
  modifyThread(threadId: string, add: string[], remove: string[]): Promise<void>;
  trashMessage(id: string): Promise<void>;
  createDraft(raw: string, threadId: string | null): Promise<DraftRef>;
  updateDraft(draftId: string, raw: string, threadId: string | null): Promise<DraftRef>;
  /** 無ければ（送信済み・削除済み）null */
  getDraft(draftId: string): Promise<{ draftId: string; message: GmailMessage } | null>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  sendAsAddresses(): Promise<Address[]>;
  watch(topicName: string): Promise<{ historyId: string; expiration: Date }>;
}
