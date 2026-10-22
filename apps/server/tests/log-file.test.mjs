import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { createRotatingLog, teeProcessOutput } from "../src/lib/log-file.ts";

function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portal-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the log file appends, creates its folder, and rotates before passing the size, keeping a fixed number of files", (t) => {
  const file = path.join(scratch(t), "logs", "server.log");
  const log = createRotatingLog(file, { maxBytes: 10, keep: 3 });
  t.after(() => log.close());
  log.write("aaaa\n");
  log.write("bbbb\n");
  assert.equal(readFileSync(file, "utf8"), "aaaa\nbbbb\n");
  log.write("cccc\n");
  assert.equal(readFileSync(file, "utf8"), "cccc\n");
  assert.equal(readFileSync(`${file}.1`, "utf8"), "aaaa\nbbbb\n");
  for (const line of ["dddd\n", "eeee\n", "ffff\n", "gggg\n", "hhhh\n"]) log.write(line);
  // Three files in all: the current one and the two before it; older ones are gone.
  assert.equal(readFileSync(file, "utf8"), "gggg\nhhhh\n");
  assert.equal(readFileSync(`${file}.1`, "utf8"), "eeee\nffff\n");
  assert.equal(readFileSync(`${file}.2`, "utf8"), "cccc\ndddd\n");
  assert.equal(existsSync(`${file}.3`), false);
  // A write larger than the limit still lands, in a file of its own.
  log.write("x".repeat(25));
  assert.equal(readFileSync(file, "utf8"), "x".repeat(25));
});

test("a log file that cannot be written drops the writes instead of throwing", (t) => {
  const dir = scratch(t);
  // A folder where the file should be: every open fails.
  const log = createRotatingLog(dir);
  assert.doesNotThrow(() => log.write("lost\n"));
  log.close();
});

test("teeProcessOutput copies writes into the log, string and bytes alike, and puts the stream back", (t) => {
  const file = path.join(scratch(t), "server.log");
  const log = createRotatingLog(file);
  t.after(() => log.close());
  const seen = [];
  const stream = new Writable({ write(chunk, _encoding, done) { seen.push(chunk.toString()); done(); } });
  const restore = teeProcessOutput(log, [stream]);
  stream.write("one\n");
  stream.write(Buffer.from("two\n"));
  stream.write("74687265650a", "hex");
  restore();
  stream.write("after\n");
  assert.equal(readFileSync(file, "utf8"), "one\ntwo\nthree\n");
  assert.deepEqual(seen, ["one\n", "two\n", "three\n", "after\n"]);
});
