import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { descendants, findSessionRoot, parseDuration, parsePs, readProcessTable } from "../src/lib/process-probe.ts";

test("ps durations parse in both the macOS and the Linux forms", () => {
  // etime, both platforms: [[dd-]hh:]mm:ss
  assert.equal(parseDuration("00:05"), 5_000);
  assert.equal(parseDuration("13:24:22"), (13 * 3600 + 24 * 60 + 22) * 1000);
  assert.equal(parseDuration("04-01:53:55"), (4 * 86400 + 3600 + 53 * 60 + 55) * 1000);
  // time on macOS: minutes past 59 and centiseconds.
  assert.equal(parseDuration("68:22.23"), 4_102_230);
  assert.equal(parseDuration("0:00.01"), 10);
  // time on Linux: [dd-]hh:mm:ss
  assert.equal(parseDuration("01:08:22"), (3600 + 8 * 60 + 22) * 1000);
  assert.equal(parseDuration("2-00:00:01"), (2 * 86400 + 1) * 1000);
  assert.ok(Number.isNaN(parseDuration("-")));
  assert.ok(Number.isNaN(parseDuration("")));
});

const table = parsePs([
  "    1     0     1 10-00:00:00  1:00.00  18480 /sbin/launchd",
  "  100     1   100    01:00:00  0:42.49  90112 node claude-agent-acp/dist/index.js",
  "  200   100   100    00:50:00 11:37.01 358400 claude --output-format stream-json --session-id=abc-123 --verbose",
  "  201   100   100    00:40:00  8:00.00 300000 claude --output-format stream-json --resume other-456",
  "  300   200   300       45:00  0:00.02   2048 /bin/zsh -c bazel test //...",
  "  301   300   300       44:59  0:03.10  40960 bazel test //...",
  "  400   201   100       01:00  0:00.00    512 sleep 60",
  "garbage line",
  "  500     1 01:00  0:00.00 a line in the old five-column form",
].join("\n"), 1_000_000);

test("the table links children to parents and skips lines it cannot read", () => {
  assert.equal(table.rows.size, 7);
  assert.deepEqual(table.children.get(100), [200, 201]);
  assert.equal(table.rows.get(301).command, "bazel test //...");
  assert.equal(table.rows.get(200).cpuMs, 697_010);
  assert.equal(table.rows.get(200).pgid, 100);
  assert.equal(table.rows.get(300).pgid, 300, "a shell leads its own group");
  assert.equal(table.rows.get(200).rssBytes, 358_400 * 1024, "rss is read in KiB");
  assert.deepEqual(descendants(table, 100).map((row) => row.pid), [200, 201, 300, 400, 301]);
  assert.deepEqual(descendants(table, 301), []);
});

test("a session's own process is the one whose command line names its agent session", () => {
  assert.equal(findSessionRoot(table, 100, "abc-123"), 200);
  assert.equal(findSessionRoot(table, 100, "other-456"), 201);
  assert.equal(findSessionRoot(table, 100, "missing"), null);
  assert.equal(findSessionRoot(table, 100, ""), null);
});

test("the real process table has this process and a child it just started", { skip: process.platform === "win32" }, async (t) => {
  const child = spawn("sleep", ["5"], { stdio: "ignore" });
  t.after(() => child.kill());
  await delay(100);
  const live = await readProcessTable();
  assert.ok(live, "ps answered");
  assert.equal(live.rows.get(process.pid)?.pid, process.pid);
  const found = descendants(live, process.pid).find((row) => row.pid === child.pid);
  assert.ok(found, "the child is below this process");
  assert.match(found.command, /^sleep 5/);
  assert.ok(found.elapsedMs < 5_000);
  assert.ok(found.rssBytes > 0);
});

test("reads made while one is running share it", { skip: process.platform === "win32" }, async () => {
  const [a, b] = await Promise.all([readProcessTable(), readProcessTable()]);
  assert.ok(a);
  assert.equal(a, b, "one ps read answered both");
  const c = await readProcessTable();
  assert.notEqual(c, a, "a later read runs ps again");
});
