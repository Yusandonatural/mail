-- 同じ Gmail の下書きを2回取り込まないよう、利用者ごとに一意にする。
-- 既にある重複は1行だけ残す（送信済み・破棄の行があればそれを、無ければ古い行を残す。下書きは ready から始まり、後から状態が変わるため）
DELETE FROM "drafts" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "user_id", "gmail_draft_id" ORDER BY ("status" <> 'ready') DESC, "id") AS "rn" FROM "drafts"
  ) "d" WHERE "rn" > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drafts_user_gmail_draft" ON "drafts" USING btree ("user_id","gmail_draft_id");
