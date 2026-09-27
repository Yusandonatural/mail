import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * 仕様書 10章のデータモデル。
 * メール本文は保存しない。Gmail の ID で参照し、表示のたびに Gmail から取得する。
 */

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  googleSub: text("google_sub").unique(),
  /** admin: 全フォルダ・設定。staff: visibleFolders のみ */
  role: text("role").notNull().default("staff"),
  /** 見られるフォルダ（Folder キーの配列）。admin は無視 */
  visibleFolders: jsonb("visible_folders").$type<string[]>().notNull().default([]),
  /** AES-256-GCM で暗号化した Google リフレッシュトークン */
  refreshTokenEnc: text("refresh_token_enc"),
  historyId: text("history_id"),
  watchExpiresAt: timestamp("watch_expires_at", { withTimezone: true }),
  watchRenewedAt: timestamp("watch_renewed_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    /** RFC の Message-ID。グループ宛てで複数人の受信箱に届いた同じメールの分類を使い回す */
    rfcMessageId: text("rfc_message_id"),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    subject: text("subject").notNull().default(""),
    toAddresses: jsonb("to_addresses").$type<string[]>().notNull().default([]),
    folder: text("folder").notNull(),
    secondaryFolders: jsonb("secondary_folders").$type<string[]>().notNull().default([]),
    category: text("category"),
    /** sender_rule | domain_rule | address | content | manual */
    source: text("source").notNull(),
    needsReply: boolean("needs_reply").notNull().default(false),
    urgency: text("urgency").notNull().default("normal"),
    language: text("language").notNull().default("ja"),
    summary: text("summary").notNull().default(""),
    amount: doublePrecision("amount"),
    currency: text("currency"),
    dueDate: text("due_date"),
    confidence: doublePrecision("confidence"),
    needsReview: boolean("needs_review").notNull().default(false),
    /** 相手が仮予定を承諾したと読めるとき true（確定の提案を出す） */
    suggestConfirm: boolean("suggest_confirm").notNull().default(false),
    status: text("status").notNull().default("new"),
    unread: boolean("unread").notNull().default(true),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_user_msg").on(t.userId, t.gmailMessageId),
    index("messages_user_folder").on(t.userId, t.folder, t.receivedAt),
    index("messages_thread").on(t.userId, t.gmailThreadId),
    index("messages_rfc").on(t.rfcMessageId),
  ],
);

export const rules = pgTable(
  "rules",
  {
    id: serial("id").primaryKey(),
    /** sender（完全一致のメールアドレス） | domain（@以降） */
    kind: text("kind").notNull(),
    pattern: text("pattern").notNull(),
    folder: text("folder").notNull(),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("rules_kind_pattern").on(t.kind, t.pattern)],
);

/** 用途別アドレスとフォルダの対応表（仕様書 7章） */
export const addressMap = pgTable("address_map", {
  address: text("address").primaryKey(),
  folder: text("folder").notNull(),
  /** 個人・総合窓口アドレス。内容分類でフォルダを決め直す */
  contentDecides: boolean("content_decides").notNull().default(false),
  note: text("note").notNull().default(""),
});

export const drafts = pgTable(
  "drafts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    gmailThreadId: text("gmail_thread_id").notNull(),
    replyToMessageId: text("reply_to_message_id").notNull(),
    gmailDraftId: text("gmail_draft_id").notNull(),
    version: integer("version").notNull().default(1),
    /** 生成直後の本文のハッシュ。Gmail 側の本文と違えば人が直したと判断する */
    bodyHash: text("body_hash").notNull(),
    /** Claude が付けた 2〜3 行のサマリー（カテゴリ・前提・埋めてほしい箇所） */
    notes: text("notes").notNull().default(""),
    instruction: text("instruction"),
    generatedBy: text("generated_by").notNull().default("auto"),
    /** ready | sent | discarded */
    status: text("status").notNull().default("ready"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("drafts_thread").on(t.userId, t.gmailThreadId)],
);

export const dateCandidates = pgTable(
  "date_candidates",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    /** ISO 8601。allDay のときは YYYY-MM-DD */
    start: text("start").notNull(),
    end: text("end"),
    allDay: boolean("all_day").notNull().default(false),
    note: text("note").notNull().default(""),
    calendarId: text("calendar_id"),
    calendarEventId: text("calendar_event_id"),
    /** candidate | tentative | confirmed | ignored */
    status: text("status").notNull().default("candidate"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("date_candidates_thread").on(t.userId, t.gmailThreadId)],
);

export const contacts = pgTable("contacts", {
  email: text("email").primaryKey(),
  name: text("name"),
  organization: text("organization"),
  relationship: text("relationship"),
  notes: text("notes").notNull().default(""),
  lastSummary: text("last_summary").notNull().default(""),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  summarizedAt: timestamp("summarized_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 下書きの書き方（カテゴリごと。言語は本文内で扱う） */
export const playbooks = pgTable("playbooks", {
  category: text("category").primaryKey(),
  guidance: text("guidance").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 署名・営業時間・カレンダー対応などの設定（key-value） */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id),
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_at").on(t.at)],
);

/** 非同期ジョブ（分類・下書き生成など）。Cloud Tasks の代わりに DB キューで持つ */
export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    /** pending | running | done | failed */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_dedupe").on(t.dedupeKey),
    index("jobs_pending").on(t.status, t.runAfter),
  ],
);

export type User = typeof users.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type Rule = typeof rules.$inferSelect;
export type AddressMapRow = typeof addressMap.$inferSelect;
export type DraftRow = typeof drafts.$inferSelect;
export type DateCandidate = typeof dateCandidates.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Job = typeof jobs.$inferSelect;
