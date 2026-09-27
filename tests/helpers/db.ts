import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { schema, type Db } from "@/lib/db";
import { seedDefaults } from "@/lib/db/seed";
import { users, type User } from "@/lib/db/schema";

export async function testDb(): Promise<Db> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedDefaults(db as unknown as Db, "yusando.com");
  return db as unknown as Db;
}

export async function makeUser(db: Db, overrides: Partial<typeof users.$inferInsert> = {}): Promise<User> {
  const [u] = await db
    .insert(users)
    .values({ email: "isozaki@yusando.com", role: "admin", refreshTokenEnc: "x", ...overrides })
    .returning();
  return u;
}
