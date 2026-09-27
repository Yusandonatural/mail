/**
 * DB のマイグレーションと初期データの投入。デプロイのたびに実行してよい（既存の設定は上書きしない）。
 *   DATABASE_URL=... ALLOWED_DOMAIN=yusando.com npm run db:migrate
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { schema, type Db } from "../src/lib/db";
import { seedDefaults } from "../src/lib/db/seed";

async function main() {
  const url = process.env.DATABASE_URL;
  const domain = process.env.ALLOWED_DOMAIN;
  if (!url || !domain) throw new Error("DATABASE_URL と ALLOWED_DOMAIN を設定してください");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedDefaults(db as unknown as Db, domain);
  await pool.end();
  console.log("migrated and seeded");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
