/**
 * DB のマイグレーションと初期データの投入。何度実行してもよい（既存の設定は上書きしない）。
 * コンテナの起動時に自動で実行する（Dockerfile）。手元では:
 *   DATABASE_URL=... ALLOWED_DOMAIN=yusando.com npm run db:migrate
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { schema, type Db } from "../src/lib/db";
import { seedDefaults } from "../src/lib/db/seed";
import { repairStoredHeaders } from "../src/lib/db/repair";

/** 複数のインスタンスが同時に起動しても、マイグレーションは1つずつ行う */
const LOCK_ID = 7_301_2015;

async function main() {
  const url = process.env.DATABASE_URL;
  const domain = process.env.ALLOWED_DOMAIN;
  if (!url || !domain) throw new Error("DATABASE_URL と ALLOWED_DOMAIN を設定してください");
  const pool = new Pool({ connectionString: url, max: 2 });
  const lock = await pool.connect();
  try {
    await lock.query("select pg_advisory_lock($1)", [LOCK_ID]);
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: process.env.MIGRATIONS_DIR || "drizzle" });
    await seedDefaults(db as unknown as Db, domain);
    // 文字化けしたまま保存された件名・差出人名を直す（失敗しても起動は止めない）
    const repaired = await repairStoredHeaders(db as unknown as Db).catch((err) => {
      console.error("header repair failed", err);
      return 0;
    });
    if (repaired) console.log(`repaired ${repaired} garbled headers`);
    console.log("migrated and seeded");
  } finally {
    await lock.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    lock.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
