/**
 * One-off: move the base64 images that older `session_events` rows carry inline out to the blob
 * store, exactly as the runtime now does for new events (`lib/blobs.ts`). Idempotent: rows already
 * pointing at blobs have no inline data and are left alone. Safe to run against the live database
 * while the server is up (each row is one UPDATE; readers see either form and both render).
 *
 *   pnpm --filter @portal/server migrate:blobs [--dry-run] [--batch 100]
 *
 * Reads DATABASE_URL and PORTAL_HOME like the server (same defaults). Postgres does not give the
 * space back by itself: run `VACUUM FULL session_events;` afterwards (it takes an exclusive lock
 * for the duration, so stop the server first) or let autovacuum reuse it over time.
 */
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { createBlobStore, externalizeImages } from "../src/lib/blobs.ts";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    batch: { type: "string", default: "100" },
  },
});
const dryRun = values["dry-run"];
const batch = Math.max(1, Number(values.batch) || 100);
const url = process.env.DATABASE_URL ?? "postgres://portal:portal@127.0.0.1:5433/portal";
const home = process.env.PORTAL_HOME || path.join(os.homedir(), ".portal");
const blobs = createBlobStore(path.join(home, "blobs"));

const sql = postgres(url, { max: 2, onnotice: () => {} });
const mb = (n) => `${(n / 1_048_576).toFixed(1)} MB`;

let rows = 0;
let rewritten = 0;
let files = 0;
let before = 0;
let after = 0;
let cursor = null;
const started = Date.now();

try {
  for (;;) {
    // Rows whose tool content holds an image, walked in primary-key order so a crash can resume.
    const page = cursor === null
      ? await sql`select session_id, seq, body from session_events
          where body->'update'->'content' @> '[{"type":"content","content":{"type":"image"}}]'::jsonb
          order by session_id, seq limit ${batch}`
      : await sql`select session_id, seq, body from session_events
          where body->'update'->'content' @> '[{"type":"content","content":{"type":"image"}}]'::jsonb
            and (session_id, seq) > (${cursor.sessionId}, ${cursor.seq})
          order by session_id, seq limit ${batch}`;
    if (page.length === 0) break;
    for (const row of page) {
      rows++;
      cursor = { sessionId: row.session_id, seq: row.seq };
      const body = row.body;
      const { update, files: found } = externalizeImages(body.update);
      if (found.length === 0) continue;
      const next = { ...body, update };
      const oldJson = JSON.stringify(body);
      const newJson = JSON.stringify(next);
      before += oldJson.length;
      after += newJson.length;
      rewritten++;
      if (dryRun) continue;
      for (const file of found) {
        await blobs.put(file.bytes, file.mimeType);
        files++;
      }
      await sql`update session_events set body = ${newJson}::jsonb where session_id = ${row.session_id} and seq = ${row.seq}`;
    }
    process.stdout.write(`\r${rows} rows scanned, ${rewritten} rewritten, ${mb(before - after)} moved out`);
  }
  process.stdout.write("\n");
  console.log(`${dryRun ? "Would rewrite" : "Rewrote"} ${rewritten} of ${rows} image-carrying rows in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  console.log(`Inline image data: ${mb(before)} before, ${mb(after)} after${dryRun ? "" : `; ${files} blob writes into ${blobs.dir}`}.`);
  if (!dryRun && rewritten > 0) {
    console.log("Postgres keeps the freed space for reuse. To hand it back to the OS, stop the server and run:");
    console.log("  VACUUM FULL session_events;");
  }
} finally {
  await sql.end();
}
