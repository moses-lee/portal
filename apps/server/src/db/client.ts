/**
 * One Postgres connection pool per process, wrapped in Drizzle. The pool is created lazily by the
 * caller (server entry or a test) so modules that only need the schema never open a connection.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  sql: Sql;
  db: Db;
  /** Closes every connection in the pool; pending queries get up to `timeoutSeconds` to finish. */
  close(timeoutSeconds?: number): Promise<void>;
}

export function connect(url: string, { max = 10 }: { max?: number } = {}): DbHandle {
  const sql = postgres(url, { max, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return {
    sql,
    db,
    close: (timeoutSeconds = 5) => sql.end({ timeout: timeoutSeconds }),
  };
}
