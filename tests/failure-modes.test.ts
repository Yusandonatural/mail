import { beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { drafts, jobs, messages, users } from "@/lib/db/schema";
import { setDb, type Db } from "@/lib/db";
import { claimNext, enqueue, failJob, resumeUserJobs, runJobs } from "@/lib/jobs";
import { jobHandlers, markGoogleDisconnected } from "@/lib/services";
import { requeueUnclassified, syncUser } from "@/lib/sync";
import { processMessage } from "@/lib/pipeline";
import { draftText, generateDraft } from "@/lib/drafts";
import { parseMessage } from "@/lib/mail/parse";
import { getSetting } from "@/lib/settings";
import { buildMime } from "@/lib/mail/mime";
import { isGooglePermanent, isGoogleTransient, isInvalidGrant } from "@/lib/google/errors";
import type { ClassifierInput, ContentClassification } from "@/lib/classify/types";
import type { DraftRequest } from "@/lib/claude/drafter";
import type { CalendarApi } from "@/lib/google/calendar-api";
import { makeUser, testDb } from "./helpers/db";
import { FakeMail, gmailMessage } from "./helpers/fake-mail";

/**
 * 障害・再試行・同時実行のときの振る舞い（落ちた後のやり直しで二重にならない・取りこぼさない、
 * 連携が切れた人がほかの人を止めない など）
 */
const h = vi.hoisted(() => ({
  mails: new Map<string, unknown>(),
  classify: null as null | ((input: ClassifierInput) => Promise<ContentClassification>),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/google/oauth", async (orig) => ({
  ...(await orig<typeof import("@/lib/google/oauth")>()),
  clientForRefreshToken: (enc: string) => enc,
}));
vi.mock("@/lib/google/gmail", () => ({
  GoogleMailApi: class {
    constructor(enc: string) {
      const mail = h.mails.get(enc);
      if (!mail) throw new Error(`no fake mail for ${enc}`);
      return mail as object;
    }
  },
}));
vi.mock("@/lib/google/calendar", () => ({
  GoogleCalendarApi: class {
    listCalendars = async () => [];
    freeBusy = async () => [];
    listEvents = async () => [];
    insertEvent = async () => ({ id: "e1", htmlLink: null });
    patchEvent = async () => {};
  } satisfies new () => CalendarApi,
}));
vi.mock("@/lib/claude/classifier", () => ({
  ClaudeClassifier: class {
    classify(input: ClassifierInput) {
      if (!h.classify) throw new Error("classifier not set");
      return h.classify(input);
    }
  },
}));
vi.mock("@/lib/claude/drafter", async (orig) => ({
  ...(await orig<typeof import("@/lib/claude/drafter")>()),
  ClaudeDraftWriter: class {
    async write(req: DraftRequest) {
      return { notes: "返信", body: `${req.senderName ?? ""} 様\nありがとうございます。` };
    }
  },
}));

const classification = (over: Partial<ContentClassification> = {}): ContentClassification => ({
  category: "wholesale",
  needs_reply: true,
  urgency: "high",
  language: "ja",
  dates: [],
  amount: null,
  due_date: null,
  summary: "卸の問合せ",
  accepts_proposed_time: false,
  confidence: 0.95,
  ...over,
});

/** Claude の混雑（529 overloaded） */
const overloaded = () => new Anthropic.InternalServerError(529, { type: "overloaded_error" }, "Overloaded", new Headers());

/** gaxios が投げるエラーの形（status・response.data・errors[].reason） */
function googleError(status: number, opts: { reason?: string; data?: unknown; message?: string } = {}) {
  return Object.assign(new Error(opts.message ?? `Google API ${status}`), {
    status,
    response: { status, data: opts.data ?? { error: { errors: opts.reason ? [{ reason: opts.reason }] : [] } } },
    errors: opts.reason ? [{ reason: opts.reason }] : undefined,
  });
}
const invalidGrant = () =>
  googleError(400, { message: "invalid_grant", data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });

const customer = (id: string, threadId = `t-${id}`) =>
  gmailMessage({ id, threadId, from: "Ben <ben@cha.example>", to: "wholesale@yusando.com", subject: "抹茶 5kg", messageId: `<${id}@cha.example>` });

/** 待ち時間（run_after）を過ぎたことにする */
const fastForward = (db: Db) => db.execute(sql`update jobs set run_after = now() - interval '1 second' where status = 'pending'`);

const rowOf = async (db: Db, userId: number, gmailMessageId: string) =>
  (await db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.gmailMessageId, gmailMessageId))))[0];

async function setup() {
  const db = await testDb();
  const owner = await makeUser(db, { refreshTokenEnc: "owner", historyId: "100" });
  const mail = new FakeMail();
  h.mails.set("owner", mail);
  setDb(db);
  return { db, owner, mail };
}

beforeEach(() => {
  h.mails.clear();
  h.classify = async () => classification();
  return () => setDb(null);
});

describe("落ちた後のやり直し（冪等性）", () => {
  it("行を保存した後に下書きジョブを積めずに落ちても、行ごと取り消され、やり直しで下書き・通知を積む", async () => {
    const { db, owner, mail } = await setup();
    mail.add(customer("m1"));
    await db.execute(sql`insert into settings (key, value) values ('notify', '{"mode":"replies"}'::jsonb)
      on conflict (key) do update set value = excluded.value`);
    // 下書きジョブの insert だけ1回失敗させる（DB の一時的な障害・接続断のかわり）
    // （シーケンスはトランザクションを取り消しても戻らないので「1回だけ」を数えられる）
    await db.execute(sql`create sequence fail_once`);
    await db.execute(sql`create function fail_draft_job() returns trigger language plpgsql as $$
      begin
        if new.kind = 'generate_draft' and nextval('fail_once') = 1 then
          raise exception 'connection lost';
        end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger fail_draft_job before insert on jobs for each row execute function fail_draft_job()`);

    const deps = { db, mail, classifier: { classify: async () => classification() } };
    await expect(processMessage(deps, owner, "m1")).rejects.toThrow();
    // 行だけ残ると、やり直しは「処理済み」で終わって自動の下書きが失われる
    expect(await rowOf(db, owner.id, "m1")).toBeUndefined();

    const r = await processMessage(deps, owner, "m1");
    expect(r).toMatchObject({ kind: "classified", draftQueued: true });
    const queued = await db.select().from(jobs);
    expect(queued.map((j) => j.kind).sort()).toEqual(["generate_draft", "notify"]);
    // もう一度やり直しても二重にならない
    expect((await processMessage(deps, owner, "m1")).kind).toBe("skipped");
    expect(await db.select().from(jobs)).toHaveLength(2);
  });
});

describe("Claude の障害", () => {
  it("混雑が続いても数回で諦めて「要確認」で取り込み、直ったら「分類し直す」で分類できる", async () => {
    const { db, owner, mail } = await setup();
    mail.add(customer("m1"));
    h.classify = async () => {
      throw overloaded();
    };
    await syncUser(db, mail, owner);
    const handlers = jobHandlers(db);

    // 1・2回目はやり直し（一時的な混雑なら数分で通る）
    await runJobs(db, handlers, 10_000);
    expect(await rowOf(db, owner.id, "m1")).toBeUndefined();
    await fastForward(db);
    await runJobs(db, handlers, 10_000);
    expect(await rowOf(db, owner.id, "m1")).toBeUndefined();
    // 3回目：要確認で取り込む（ジョブを失敗で終わらせてメールを失わない）
    await fastForward(db);
    await runJobs(db, handlers, 10_000);
    expect(await rowOf(db, owner.id, "m1")).toMatchObject({ needsReview: true, confidence: null, status: "done" });
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "process_message"));
    expect(job.status).toBe("done");
    // 画面の上に Claude の障害を出す
    expect((await getSetting(db, "claudeHealth")).lastError).toContain("529");

    // 直った：分類し直すと要返信になる
    h.classify = async () => classification();
    expect(await requeueUnclassified(db, owner)).toBe(1);
    await runJobs(db, handlers, 10_000);
    expect(await rowOf(db, owner.id, "m1")).toMatchObject({ needsReview: false, needsReply: true, category: "wholesale" });
  });

  it("下書きの Claude が混雑しているときは、5回で諦めずに長めにやり直す", async () => {
    const db = await testDb();
    await enqueue(db, "generate_draft", { userId: 1, threadId: "t1" }, "d1");
    const job = (await claimNext(db))!;
    await failJob(db, { ...job, attempts: 5 }, overloaded());
    const [row] = await db.select().from(jobs);
    expect(row.status).toBe("pending");
    // 間隔は最大 1 時間
    expect(row.runAfter.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
    await failJob(db, { ...job, attempts: 10 }, overloaded());
    expect((await db.select().from(jobs))[0].status).toBe("failed");
  });
});

describe("Google のエラーの見分け", () => {
  it("404・権限不足はすぐ失敗、429・使いすぎの 403 はやり直し、invalid_grant は別扱い", async () => {
    expect(isGooglePermanent(googleError(404))).toBe(true);
    expect(isGooglePermanent(googleError(403, { reason: "insufficientPermissions" }))).toBe(true);
    expect(isGoogleTransient(googleError(429))).toBe(true);
    expect(isGoogleTransient(googleError(403, { reason: "userRateLimitExceeded" }))).toBe(true);
    expect(isGooglePermanent(googleError(403, { reason: "rateLimitExceeded" }))).toBe(false);
    expect(isGoogleTransient(googleError(503))).toBe(true);
    expect(isInvalidGrant(invalidGrant())).toBe(true);
    expect(isGooglePermanent(invalidGrant())).toBe(false);
    // Google 以外のエラー（コードを持つ DB のエラーなど）は Google の失敗と取り違えない
    expect(isGooglePermanent(Object.assign(new Error("db"), { code: 404 }))).toBe(false);

    const db = await testDb();
    await enqueue(db, "generate_draft", {}, "gone");
    const job = (await claimNext(db))!;
    await failJob(db, job, googleError(404));
    expect((await db.select().from(jobs))[0].status).toBe("failed");
  });
});

/** Google の連携が切れた（トークンが無効になった）人の Gmail */
class RevokedMail extends FakeMail {
  calls = 0;
  override async getMessage(): Promise<never> {
    this.calls++;
    throw invalidGrant();
  }
  override async listHistory(): Promise<never> {
    this.calls++;
    throw invalidGrant();
  }
}

describe("Google の連携が切れたとき", () => {
  it("ジョブを失敗させずに保留して連携を外し、ほかの人のジョブは進む。ログインし直すと続きから処理する", async () => {
    const { db, owner, mail } = await setup();
    const revoked = new RevokedMail();
    h.mails.set("staff", revoked);
    const staff = await makeUser(db, { email: "staff@yusando.com", role: "staff", refreshTokenEnc: "staff", historyId: "100" });
    mail.add(customer("m1"));
    await enqueue(db, "process_message", { userId: staff.id, messageId: "s1" }, `msg:${staff.id}:s1`);
    await enqueue(db, "process_message", { userId: owner.id, messageId: "m1" }, `msg:${owner.id}:m1`);

    await runJobs(db, jobHandlers(db), 10_000);
    expect(await rowOf(db, owner.id, "m1")).toBeDefined();
    const after = (await db.select().from(users).where(eq(users.id, staff.id)))[0];
    expect(after.refreshTokenEnc).toBeNull();
    const [held] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `msg:${staff.id}:s1`));
    expect(held).toMatchObject({ status: "pending", attempts: 0 });
    expect(held.runAfter.getTime()).toBeGreaterThan(Date.now() + 20 * 60 * 1000);

    // 何度回しても、保留中のジョブで Google を呼び続けない
    await runJobs(db, jobHandlers(db), 10_000);
    expect(revoked.calls).toBe(1);

    // ログインし直した：新しいトークンで続きから処理する
    const fresh = new FakeMail();
    fresh.add(gmailMessage({ id: "s1", from: "a@cha.example", to: "staff@yusando.com", subject: "質問" }));
    h.mails.set("staff2", fresh);
    await db.update(users).set({ refreshTokenEnc: "staff2" }).where(eq(users.id, staff.id));
    await resumeUserJobs(db, staff.id);
    await runJobs(db, jobHandlers(db), 10_000);
    expect(await rowOf(db, staff.id, "s1")).toBeDefined();
  });

  it("連携を外す前にログインし直していれば、新しいトークンは消さない", async () => {
    const { db, owner } = await setup();
    await db.update(users).set({ refreshTokenEnc: "new-token" }).where(eq(users.id, owner.id));
    await markGoogleDisconnected(db, owner); // owner は古いトークン（"owner"）を持ったまま
    const [row] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(row.refreshTokenEnc).toBe("new-token");
  });
});

describe("同時実行", () => {
  it("同じスレッドの下書きジョブは、実行中のものがあれば2つ目を取り出さない", async () => {
    const db = await testDb();
    await enqueue(db, "generate_draft", { userId: 1, threadId: "t1", messageId: "m1" }, "a");
    await enqueue(db, "generate_draft", { userId: 1, threadId: "t1", messageId: "m2" }, "b");
    await enqueue(db, "generate_draft", { userId: 1, threadId: "t2", messageId: "m3" }, "c");
    const first = await claimNext(db);
    expect(first?.payload.messageId).toBe("m1");
    const second = await claimNext(db);
    expect(second?.payload.threadId).toBe("t2");
    expect(await claimNext(db)).toBeNull();
  });

  it("push と cron が同時に同期しても、先に進んだ履歴を古い変更で上書き・巻き戻ししない", async () => {
    const { db, owner } = await setup();
    await db.insert(messages).values({
      userId: owner.id,
      gmailMessageId: "m1",
      gmailThreadId: "t1",
      fromEmail: "ben@cha.example",
      subject: "抹茶",
      folder: "wholesale",
      source: "content",
      needsReply: true,
      status: "new",
      receivedAt: new Date(),
    });
    const calls: string[] = [];
    class RacingMail extends FakeMail {
      override async listHistory(start?: string) {
        calls.push(start ?? "");
        if (start === "100") {
          // この同期が履歴を読んでいる間に、もう一方の同期が終わって履歴を 300 まで進めた
          await db.update(users).set({ historyId: "300" }).where(eq(users.id, owner.id));
          // ここで読んだのは古い範囲：m1 がアーカイブされた（後で受信トレイに戻されている）
          return { messageIds: [], readIds: [], restoredIds: [], archivedIds: ["m1"], historyId: "200" };
        }
        return { messageIds: [], readIds: [], restoredIds: [], historyId: "300" };
      }
    }
    await syncUser(db, new RacingMail(), owner);
    expect(calls).toEqual(["100", "300"]);
    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(u.historyId).toBe("300");
    expect((await rowOf(db, owner.id, "m1")).status).toBe("new");
  });
});

describe("Gmail で作られた下書き", () => {
  it("取り込んだ下書き（人や Claude のスキルが書いたもの）は、新しいメールが届いても上書きせず別案を作る", async () => {
    const { db, owner, mail } = await setup();
    mail.add(customer("m1", "t1"));
    await processMessage({ db, mail, classifier: { classify: async () => classification() } }, owner, "m1", { autoDraft: false });
    const humanText = "Ben 様\n人が Gmail で書いた返信です";
    const ref = await mail.createDraft(buildMime({ to: [{ name: "Ben", email: "ben@cha.example" }], subject: "Re: 抹茶 5kg", text: humanText }), "t1");
    mail.add(gmailMessage({ id: ref.messageId, threadId: "t1", from: owner.email, labelIds: ["DRAFT"] }));
    const deps = { db, mail, drafter: { write: async () => ({ notes: "", body: "Claude の下書き" }) }, calendar: null, shop: null };
    // 取り込む（自動の下書きは Gmail の下書きがあるので作らない）
    expect((await generateDraft(deps, owner, "t1", "m1", { generatedBy: "auto" })).kind).toBe("skipped");

    // お客様から次のメールが届いた
    mail.messages.delete(ref.messageId);
    mail.add(customer("m2", "t1"));
    const r = await generateDraft(deps, owner, "t1", "m2", { generatedBy: "auto" });
    expect(r).toMatchObject({ kind: "created", alternative: true });
    expect(draftText(parseMessage((await mail.getDraft(ref.draftId))!.message))).toBe(humanText);
    const ready = await db.select().from(drafts).where(eq(drafts.status, "ready"));
    expect(ready).toHaveLength(2);
  });
});
