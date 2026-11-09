// Database access: transactions, and withTreeLock, the only way to change an existing task.
// Lock order is fixed for every write (docs/design.md → Write paths): tree root, then target, then developer.
import type pg from "pg";
import { notFound } from "./errors.js";

export type Queryable = Pick<pg.Pool, "query"> | pg.PoolClient;

export type TaskRow = {
  id: string;
  title: string;
  status: string;
  skill_source: string;
  parent_id: string | null;
  root_id: string;
  position: number;
  assignee_id: string | null;
};

// A client inside an open transaction. Only withTransaction creates one, and the repo write functions
// require it, so a write called on a bare pool.connect() client fails to compile.
declare const inTransaction: unique symbol;
export type TxClient = pg.PoolClient & { readonly [inTransaction]: true };

export async function withTransaction<T>(pool: pg.Pool, fn: (client: TxClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client as TxClient);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// After the root lock, every other writer in this tree waits, so plain reads of the tree are consistent.
export async function withTreeLock<T>(
  pool: pg.Pool,
  taskId: string,
  fn: (client: TxClient, task: TaskRow) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    // 1st lock: the tree's root. root_id never changes, so the subquery needs no lock of its own.
    const root = await client.query(
      "SELECT id FROM task WHERE id = (SELECT root_id FROM task WHERE id = $1) FOR UPDATE",
      [taskId],
    );
    if (root.rowCount === 0) throw notFound("TASK_NOT_FOUND", `Task ${taskId} does not exist.`);
    // 2nd lock: the target.
    const target = await client.query<TaskRow>("SELECT * FROM task WHERE id = $1 FOR UPDATE", [taskId]);
    return fn(client, target.rows[0]!);
  });
}

// Locks the developer whose skills an assignment check reads, FOR SHARE. On the write paths this is the
// 3rd lock, after the root and the task; create takes it alone, before inserting the new tree.
// Returns the developer with their skill ids, or undefined when the id does not exist.
export async function lockDeveloper(
  client: TxClient,
  developerId: string,
): Promise<{ id: string; name: string; skillIds: Set<string> } | undefined> {
  const dev = await client.query<{ id: string; name: string }>(
    "SELECT id, name FROM developer WHERE id = $1 FOR SHARE",
    [developerId],
  );
  const row = dev.rows[0];
  if (!row) return undefined;
  // Skills are read in a second statement, which gets a fresh snapshot after the lock is granted. Read in
  // the locking statement, they would be the skills from before any wait, missing an edit that committed.
  const skills = await client.query<{ skill_id: string }>(
    "SELECT skill_id FROM developer_skill WHERE developer_id = $1",
    [developerId],
  );
  return { ...row, skillIds: new Set(skills.rows.map((r) => r.skill_id)) };
}
