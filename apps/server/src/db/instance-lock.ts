/**
 * One Portal server per database. A second process started against the same database (`pnpm dev`
 * in a Portal worktree while the launchd Portal runs) would otherwise load every session at boot
 * and close the turns the live server is still running, before it even fails to bind its port.
 * The guard is a session-level advisory lock held on one reserved pool connection for the life of
 * the app: Postgres drops it by itself if the process dies, so a crash never leaves it stuck.
 */
import type { Sql } from "postgres";

/** Advisory locks are per database, so two databases on one server never block each other. */
const LOCK = "portal.server";

export class InstanceLockedError extends Error {
  constructor(database: string) {
    super(`Another Portal server is already using the database "${database}". Stop it first, or point DATABASE_URL at another database.`);
    this.name = "InstanceLockedError";
  }
}

export type InstanceLock = { release(): Promise<void> };

/** Takes the lock or throws `InstanceLockedError` at once; never waits for the other server. */
export async function acquireInstanceLock(sql: Sql): Promise<InstanceLock> {
  const connection = await sql.reserve();
  let locked = false;
  try {
    const [row] = await connection<{ locked: boolean; database: string }[]>`select pg_try_advisory_lock(hashtext(${LOCK})) as locked, current_database() as database`;
    locked = row?.locked === true;
    if (!locked) throw new InstanceLockedError(row?.database ?? "?");
  } finally {
    if (!locked) connection.release();
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      // Unlock before the connection goes back to the pool, or whoever reuses it would hold the lock.
      try {
        await connection`select pg_advisory_unlock(hashtext(${LOCK}))`;
      } catch {
        // The connection is gone, and with it the lock.
      } finally {
        connection.release();
      }
    },
  };
}
