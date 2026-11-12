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
 * Gmail の履歴（history.list）から読み取った変更。ラベルの変更はメッセージごとに最後の状態だけを残す
 * （履歴は古い順に並ぶので、1ページの中でアーカイブ→受信トレイに戻す、などがあっても後の操作が勝つ）。
 * messageIds と readIds 以外は省略できる（省略は空と同じ）。
 */
export interface HistoryChanges {
  /** 追加されたメッセージ（下書きは除く） */
  messageIds: string[];
  /** Gmail 側（スマホの Gmail など）で既読にされたメッセージ */
  readIds: string[];
  /** Gmail 側で未読に戻されたメッセージ */
  unreadIds?: string[];
  /** 迷惑メール・ゴミ箱・プロモーションから戻されたメッセージ（届いたときは処理を飛ばしている） */
  restoredIds?: string[];
  /** 受信トレイから外された（アーカイブされた）メッセージ。受信トレイに無かったメールは含まない */
  archivedIds?: string[];
  /** 受信トレイに戻されたメッセージ */
  inboxIds?: string[];
  /** ゴミ箱・迷惑メールへ移されたメッセージ */
  trashedIds?: string[];
  /** 完全に削除されたメッセージ */
  deletedIds?: string[];
  historyId: string;
}

/** 届いたときに処理を飛ばすラベル（pipeline の SKIP_LABELS）。外されたら改めて処理する */
const RESTORE_LABELS = ["SPAM", "TRASH", "CATEGORY_PROMOTIONS"];
/** 変化を追うラベル */
const TRACKED_LABELS = new Set(["INBOX", "UNREAD", ...RESTORE_LABELS]);

/** history.list の結果（複数ページ分を古い順に並べたもの）を HistoryChanges にまとめる */
export function summarizeHistory(history: gmail_v1.Schema$History[], historyId: string): HistoryChanges {
  const added = new Set<string>();
  const deleted = new Set<string>();
  // メッセージ ID → ラベル → 最後の操作（true = 付いた、false = 外れた）
  const last = new Map<string, Map<string, boolean>>();
  const mark = (id: string | null | undefined, labelIds: string[] | null | undefined, on: boolean) => {
    if (!id) return;
    for (const l of labelIds ?? []) {
      if (!TRACKED_LABELS.has(l)) continue;
      if (!last.has(id)) last.set(id, new Map());
      last.get(id)!.set(l, on);
    }
  };
  for (const h of history) {
    for (const a of h.messagesAdded ?? []) {
      // アプリや人が下書きを保存するたびに届く通知は処理しない
      if (a.message?.id && !a.message.labelIds?.includes("DRAFT")) added.add(a.message.id);
    }
    for (const a of h.labelsAdded ?? []) mark(a.message?.id, a.labelIds, true);
    for (const r of h.labelsRemoved ?? []) mark(r.message?.id, r.labelIds, false);
    for (const d of h.messagesDeleted ?? []) if (d.message?.id) deleted.add(d.message.id);
  }
  const out = {
    readIds: [] as string[],
    unreadIds: [] as string[],
    restoredIds: [] as string[],
    archivedIds: [] as string[],
    inboxIds: [] as string[],
    trashedIds: [] as string[],
  };
  for (const [id, labels] of last) {
    // 完全に削除されたメールは他の変更を見ない
    if (deleted.has(id)) continue;
    const trashed = labels.get("SPAM") === true || labels.get("TRASH") === true;
    if (labels.get("UNREAD") === false) out.readIds.push(id);
    if (labels.get("UNREAD") === true) out.unreadIds.push(id);
    if (trashed) {
      out.trashedIds.push(id);
      continue;
    }
    if (RESTORE_LABELS.some((l) => labels.get(l) === false)) out.restoredIds.push(id);
    if (labels.get("INBOX") === false) out.archivedIds.push(id);
    if (labels.get("INBOX") === true) out.inboxIds.push(id);
  }
  return { messageIds: [...added].filter((id) => !deleted.has(id)), ...out, deletedIds: [...deleted], historyId };
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
  /** startHistoryId 以降の変更（HistoryChanges）。古すぎれば HistoryExpiredError */
  listHistory(startHistoryId: string): Promise<HistoryChanges>;
  listMessageIds(query: string, max: number): Promise<string[]>;
  listLabels(): Promise<Array<{ id: string; name: string }>>;
  createLabel(name: string): Promise<{ id: string; name: string }>;
  modifyMessage(id: string, add: string[], remove: string[]): Promise<void>;
  modifyThread(threadId: string, add: string[], remove: string[]): Promise<void>;
  trashMessage(id: string): Promise<void>;
  createDraft(raw: string, threadId: string | null): Promise<DraftRef>;
  updateDraft(draftId: string, raw: string, threadId: string | null): Promise<DraftRef>;
  /** 無ければ（送信済み・削除済み）null */
  /** Gmail にある下書きの一覧（新しい順、最大 max 件） */
  listDrafts(max: number): Promise<Array<{ draftId: string; messageId: string; threadId: string }>>;
  getDraft(draftId: string): Promise<{ draftId: string; message: GmailMessage } | null>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  sendAsAddresses(): Promise<Address[]>;
  watch(topicName: string): Promise<{ historyId: string; expiration: Date }>;
}
