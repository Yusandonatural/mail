CREATE TABLE "address_map" (
	"address" text PRIMARY KEY NOT NULL,
	"folder" text NOT NULL,
	"content_decides" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"action" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"email" text PRIMARY KEY NOT NULL,
	"name" text,
	"organization" text,
	"relationship" text,
	"notes" text DEFAULT '' NOT NULL,
	"last_summary" text DEFAULT '' NOT NULL,
	"last_message_at" timestamp with time zone,
	"summarized_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "date_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"start" text NOT NULL,
	"end" text,
	"all_day" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"calendar_id" text,
	"calendar_event_id" text,
	"status" text DEFAULT 'candidate' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"reply_to_message_id" text NOT NULL,
	"gmail_draft_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"body_hash" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"instruction" text,
	"generated_by" text DEFAULT 'auto' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"rfc_message_id" text,
	"from_email" text NOT NULL,
	"from_name" text,
	"subject" text DEFAULT '' NOT NULL,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"folder" text NOT NULL,
	"secondary_folders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category" text,
	"source" text NOT NULL,
	"needs_reply" boolean DEFAULT false NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"language" text DEFAULT 'ja' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"amount" double precision,
	"currency" text,
	"due_date" text,
	"confidence" double precision,
	"needs_review" boolean DEFAULT false NOT NULL,
	"suggest_confirm" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"unread" boolean DEFAULT true NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"category" text PRIMARY KEY NOT NULL,
	"guidance" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"pattern" text NOT NULL,
	"folder" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"google_sub" text,
	"role" text DEFAULT 'staff' NOT NULL,
	"visible_folders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refresh_token_enc" text,
	"history_id" text,
	"watch_expires_at" timestamp with time zone,
	"watch_renewed_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_candidates" ADD CONSTRAINT "date_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_at" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "date_candidates_thread" ON "date_candidates" USING btree ("user_id","gmail_thread_id");--> statement-breakpoint
CREATE INDEX "drafts_thread" ON "drafts" USING btree ("user_id","gmail_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_pending" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_user_msg" ON "messages" USING btree ("user_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "messages_user_folder" ON "messages" USING btree ("user_id","folder","received_at");--> statement-breakpoint
CREATE INDEX "messages_thread" ON "messages" USING btree ("user_id","gmail_thread_id");--> statement-breakpoint
CREATE INDEX "messages_rfc" ON "messages" USING btree ("rfc_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_kind_pattern" ON "rules" USING btree ("kind","pattern");