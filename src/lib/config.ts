import { z } from "zod";

const schema = z.object({
  APP_BASE_URL: z.string().url(),
  ALLOWED_DOMAIN: z.string().min(1),
  ADMIN_EMAILS: z.string().default(""),
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  CRON_SECRET: z.string().min(16),
  DATABASE_URL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GMAIL_PUBSUB_TOPIC: z.string().default(""),
  PUBSUB_PUSH_SERVICE_ACCOUNT: z.string().default(""),
  SHOPIFY_STORE_DOMAIN: z.string().default(""),
  SHOPIFY_ADMIN_TOKEN: z.string().default(""),
});

export type AppConfig = z.infer<typeof schema> & { adminEmails: string[] };

let cached: AppConfig | null = null;

/** 環境変数を検証して返す。必須値が欠けていれば起動時に分かるよう例外にする。 */
export function config(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`環境変数が不足しています: ${missing}（.env.example を参照）`);
  }
  cached = {
    ...parsed.data,
    adminEmails: parsed.data.ADMIN_EMAILS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
  return cached;
}

export function shopifyConfigured(): boolean {
  return Boolean(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN);
}
