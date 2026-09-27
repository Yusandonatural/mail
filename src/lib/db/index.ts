import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export { schema };

/** node-postgres（本番）と PGlite（テスト）の両方を受けられる DB 型 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let current: Db | null = null;

export async function getDb(): Promise<Db> {
  if (current) return current;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  current = drizzle(pool, { schema }) as unknown as Db;
  return current;
}

/** テストで PGlite の DB を差し込む */
export function setDb(db: Db | null): void {
  current = db;
}
