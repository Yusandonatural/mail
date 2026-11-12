-- 一覧（届いた順に新しい方からたどる）・件数・日程ありの絞り込み用の索引（メールが数万通になっても速く出すため）
CREATE INDEX IF NOT EXISTS "messages_user_received" ON "messages" USING btree ("user_id","received_at","id");
--> statement-breakpoint
-- 要返信・下書きありのメール（全体のごく一部）
CREATE INDEX IF NOT EXISTS "messages_open" ON "messages" USING btree ("user_id") WHERE "status" IN ('new', 'draft_ready');
--> statement-breakpoint
-- 要確認のメール（全体のごく一部）
CREATE INDEX IF NOT EXISTS "messages_review" ON "messages" USING btree ("user_id") WHERE "needs_review";
--> statement-breakpoint
-- 左の件数で数えるメール（要返信・未読・要確認）
CREATE INDEX IF NOT EXISTS "messages_counted" ON "messages" USING btree ("user_id") WHERE "status" NOT IN ('skipped', 'archived') AND ("unread" OR "needs_review" OR ("needs_reply" AND "status" IN ('new', 'draft_ready')));
--> statement-breakpoint
-- 一覧の「日程あり」はメールごとに引く
CREATE INDEX IF NOT EXISTS "date_candidates_msg" ON "date_candidates" USING btree ("user_id","gmail_message_id");
