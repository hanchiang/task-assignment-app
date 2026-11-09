// Gives each test file a fresh schema on one PostgreSQL server, loaded from the same db/init files Docker runs.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const INIT_DIR = fileURLToPath(new URL("../../db/init/", import.meta.url));
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55433/postgres";

export type TestDb = { pool: pg.Pool; schema: string; newClient: () => Promise<pg.Client>; cleanup: () => Promise<void> };

export async function createTestDb(): Promise<TestDb> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  // application_name lets the lock test find this file's backends in pg_stat_activity.
  const connection = { connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}`, application_name: schema };
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);

  const pool = new pg.Pool(connection);
  for (const file of ["001_schema.sql", "002_seed.sql"]) {
    await pool.query(await readFile(INIT_DIR + file, "utf8"));
  }
  return {
    pool,
    schema,
    newClient: async () => {
      const c = new pg.Client(connection);
      await c.connect();
      return c;
    },
    cleanup: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

// Fixed ids from db/init/002_seed.sql.
export const SKILL = {
  Frontend: "01a1bd9a-c800-7000-8000-000000000001",
  Backend: "01a1bd9a-c800-7000-8000-000000000002",
} as const;
export const DEV = {
  Alice: "01a1bd9a-c800-7000-8000-000000000101",
  Bob: "01a1bd9a-c800-7000-8000-000000000102",
  Carol: "01a1bd9a-c800-7000-8000-000000000103",
  Dave: "01a1bd9a-c800-7000-8000-000000000104",
} as const;
