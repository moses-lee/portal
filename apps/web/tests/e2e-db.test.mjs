import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./ui-support/e2e-db.mjs", import.meta.url));

// The admin URL points at a closed port, so if the guard ever failed the script could only report a
// connection error: it never reaches a real database.
const dropping = (name, adminDb = "admin_db") => run(process.execPath, [script], {
  env: { ...process.env, E2E_ADMIN_DATABASE_URL: `postgres://portal:portal@127.0.0.1:1/${adminDb}`, E2E_DATABASE_NAME: name },
});

test("the UI suite's database script refuses to drop the admin database or Portal's own", async () => {
  for (const [name, adminDb] of [["admin_db", "admin_db"], ["portal", "admin_db"], ["postgres", "admin_db"], ["template1", "portal"]]) {
    await assert.rejects(dropping(name, adminDb), (err) => err.code === 1 && /Refusing to drop/.test(err.stderr), name);
  }
  // A throwaway name gets past the guard and fails only on the unreachable server.
  await assert.rejects(dropping("portal_e2e"), (err) => /Cannot recreate portal_e2e/.test(err.stderr) && !/Refusing/.test(err.stderr));
});
