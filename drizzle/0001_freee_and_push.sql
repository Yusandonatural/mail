CREATE TABLE "freee_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"user_id" integer NOT NULL,
	"gmail_message_id" text NOT NULL,
	"rfc_message_id" text,
	"filename" text NOT NULL,
	"receipt_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "freee_uploads" ADD CONSTRAINT "freee_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "freee_uploads_dedupe" ON "freee_uploads" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "freee_uploads_msg" ON "freee_uploads" USING btree ("gmail_message_id");--> statement-breakpoint
CREATE INDEX "freee_uploads_rfc" ON "freee_uploads" USING btree ("rfc_message_id");