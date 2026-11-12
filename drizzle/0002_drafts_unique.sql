-- 同じ Gmail の下書きを2回取り込まないよう、利用者ごとに一意にする（既にある重複は古い行を残す）
DELETE FROM "drafts" a USING "drafts" b WHERE a."id" > b."id" AND a."user_id" = b."user_id" AND a."gmail_draft_id" = b."gmail_draft_id";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drafts_user_gmail_draft" ON "drafts" USING btree ("user_id","gmail_draft_id");
