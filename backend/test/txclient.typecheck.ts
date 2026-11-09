// Compile-time test, checked by `npm run typecheck` (tsc), never run by vitest: every write and every
// row lock must refuse a client that is not inside withTransaction. If a bare client ever compiles, the
// matching expect-error line below becomes unused and tsc fails.
import type pg from "pg";
import { lockDeveloper, withTransaction } from "../src/db.js";
import * as repo from "../src/tasks/repo.js";

export async function bareClientIsRejected(pool: pg.Pool, bare: pg.PoolClient) {
  // @ts-expect-error a bare pool client is not a TxClient
  await repo.setStatus(bare, ["id"], "DONE");
  // @ts-expect-error a bare pool client is not a TxClient
  await repo.setAssignee(bare, "id", null);
  // @ts-expect-error a bare pool client is not a TxClient
  await repo.replaceSkills(bare, "id", [], false);
  // @ts-expect-error a bare pool client is not a TxClient
  await repo.insertTree(bare, []);
  // @ts-expect-error a FOR SHARE lock outside a transaction is released at once
  await lockDeveloper(bare, "id");

  // Inside a transaction the same calls compile.
  await withTransaction(pool, async (tx) => {
    await repo.setStatus(tx, ["id"], "DONE");
    await repo.setAssignee(tx, "id", null);
    await repo.replaceSkills(tx, "id", [], false);
    await repo.insertTree(tx, []);
    await lockDeveloper(tx, "id");
  });
}
