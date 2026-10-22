import assert from "node:assert/strict";
import test from "node:test";
import { parsePs } from "../src/lib/process-probe.ts";
import { CWD_FLOOR_BYTES, attribute, commandNames, cwdCandidates } from "../src/monitoring/attribution.ts";

const MB = 1024 * 1024;
const kb = (mb) => String(Math.round(mb * 1024));
const row = (pid, ppid, pgid, mb, command) => `${pid} ${ppid} ${pgid} 01:00 0:01.00 ${kb(mb)} ${command}`;

const WT = "/Users/me/.portal/worktrees/repo/feature";
const WT_SUB = `${WT}/services/api`;
const OTHER_WT = "/Users/me/.portal/worktrees/repo/feature-two";

const table = parsePs([
  row(1, 0, 1, 18, "/sbin/launchd"),
  row(500, 1, 500, 120, "node apps/server/src/index.ts"),               // the server
  row(510, 500, 510, 90, "node claude-agent-acp/dist/index.js"),         // an adapter
  row(520, 510, 520, 350, "claude --session-id=up-a --verbose"),         // session a's CLI
  row(521, 520, 521, 30, "/bin/zsh -c pnpm test"),                        // its shell
  row(522, 521, 521, 200, "node vitest"),                                 // below it
  row(530, 510, 530, 300, "claude --resume up-b"),                        // session b's CLI
  row(540, 510, 510, 40, "node some-mcp-server"),                         // the adapter's own child
  row(550, 500, 550, 10, "/bin/zsh -l"),                                  // a Portal terminal
  row(551, 550, 550, 400, "node next dev"),                               // started in it, cwd in a worktree
  row(552, 550, 550, 5, "sleep 100"),                                     // in it, small, no path
  row(600, 1, 600, 15, "node next start"),                                // the web server's parent
  row(601, 600, 600, 300, "next-server (v16)"),                           // the listener
  row(700, 1, 700, 2500, "/System/Library/Frameworks/Virtualization.framework/com.apple.Virtualization.VirtualMachine"),
  row(710, 1, 710, 8, "ssh: port forward 5433"),                          // the database listener
  row(800, 1, 800, 2600, `bazel(feature) --output_base=/Users/me/.cache/bazel/_bazel_me/abc --workspace_directory=${WT}`),
  row(801, 800, 800, 17, "postgres -D /tmp/test-db"),                     // below it, small: inherits the worktree
  row(802, 801, 800, 12, "postgres: writer"),                             // below that: inherits from 800 too
  row(810, 1, 810, 600, `java -jar server.jar --workspace_directory=${WT}-old`), // a sibling folder's prefix: no match
  row(820, 1, 820, 300, "node watcher"),                                  // cwd in the subfolder project
  row(830, 1, 830, 900, `cargo build --manifest-path=${OTHER_WT}/Cargo.toml`),
  row(840, 1, 840, 4000, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  row(841, 1, 841, 15, `vim ${WT}/README.md`),                            // small, found by its command line
  row(1530, 530, 1530, 50, "node child-of-b"),                            // session b's child
  row(900, 1, 900, 80, "claude-child-left-behind"),                       // reparented to launchd, cwd in WT
].join("\n"), 1_000_000);

const input = {
  table,
  memory: new Map([[520, 400 * MB]]),
  sessions: [
    { sessionId: "a", agentPid: 510, marker: "up-a" },
    { sessionId: "b", agentPid: 510, marker: "up-b" },
    { sessionId: "gone", agentPid: 510, marker: "up-missing" },
  ],
  adapterPids: [510],
  serverPid: 500,
  webPids: [601],
  databasePids: [710, 700],
  worktrees: [
    { projectId: "wt", path: WT },
    { projectId: "wt-sub", path: WT_SUB },
    { projectId: "wt2", path: OTHER_WT },
  ],
};

const cwds = new Map([[551, `${WT}/apps/web`], [820, `${WT_SUB}/src`], [900, WT], [840, "/"]]);

function owners(rows) {
  return Object.fromEntries(rows.map((entry) => [entry.pid, entry.owner]));
}

test("working folders are looked up only for unclaimed processes above the floor", () => {
  const candidates = cwdCandidates(input);
  assert.equal(CWD_FLOOR_BYTES, 20 * MB);
  assert.deepEqual(candidates.sort((a, b) => a - b), [551, 800, 810, 820, 830, 840, 900]);
  for (const claimed of [500, 510, 520, 522, 530, 540, 601, 700]) assert.ok(!candidates.includes(claimed), `${claimed} is claimed by rule 1 or 2`);
  for (const small of [1, 552, 801, 841, 600, 710]) assert.ok(!candidates.includes(small), `${small} is under the floor or claimed`);
});

test("each process goes to the first owner that matches", () => {
  const rows = attribute({ ...input, cwds });
  const by = owners(rows);
  // 1. Sessions: the CLI root and everything below it.
  for (const pid of [520, 521, 522]) assert.deepEqual(by[pid], { kind: "session", sessionId: "a" }, String(pid));
  for (const pid of [530, 1530]) assert.deepEqual(by[pid], { kind: "session", sessionId: "b" }, String(pid));
  // 2. Portal: the server, the adapter and its own children, the web server and its next parent, the database listener and VM.
  assert.deepEqual(by[500], { kind: "portal", role: "server" });
  assert.deepEqual(by[510], { kind: "portal", role: "adapter" });
  assert.deepEqual(by[540], { kind: "portal", role: "adapter" });
  assert.deepEqual(by[601], { kind: "portal", role: "web" });
  assert.deepEqual(by[600], { kind: "portal", role: "web" });
  assert.deepEqual(by[700], { kind: "portal", role: "database" });
  assert.deepEqual(by[710], { kind: "portal", role: "database" });
  // 3. Worktrees: by working folder (the deepest project wins), else by a whole path in the command line.
  assert.deepEqual(by[551], { kind: "worktree", projectId: "wt" }, "a dev server in a Portal terminal, by its folder");
  assert.deepEqual(by[820], { kind: "worktree", projectId: "wt-sub" }, "the subfolder project, not its parent");
  assert.deepEqual(by[800], { kind: "worktree", projectId: "wt" }, "a build server by --workspace_directory");
  assert.deepEqual(by[830], { kind: "worktree", projectId: "wt2" });
  assert.deepEqual(by[841], { kind: "worktree", projectId: "wt" }, "a small process by its command line");
  assert.deepEqual(by[900], { kind: "worktree", projectId: "wt" });
  // A process that matches nothing itself inherits the worktree of its nearest ancestor that did.
  assert.deepEqual(by[801], { kind: "worktree", projectId: "wt" });
  assert.deepEqual(by[802], { kind: "worktree", projectId: "wt" });
  // The server's other descendants with no worktree stay the server's.
  assert.deepEqual(by[550], { kind: "portal", role: "server" });
  assert.deepEqual(by[552], { kind: "portal", role: "server" });
  // 4. None.
  for (const pid of [1, 810, 840]) assert.deepEqual(by[pid], { kind: "none" }, String(pid));
});

test("only a worktree is inherited, from the nearest ancestor that matched on its own, and an inherited row says from where", () => {
  const rows = attribute({ ...input, cwds });
  const at = (pid) => rows.find((entry) => entry.pid === pid);
  assert.equal(at(801).inheritedFrom, 800);
  assert.equal(at(802).inheritedFrom, 800, "through an ancestor that only inherited");
  assert.equal(at(800).inheritedFrom, null, "matched on its own");
  assert.equal(at(552).inheritedFrom, null, "below a terminal (the server's): nothing to inherit");
  assert.equal(at(1530).inheritedFrom, null, "session trees are rule 1, not inheritance");
  assert.equal(at(840).inheritedFrom, null);

  // A dev server's worker below a terminal: the nearest own match is the dev server (a worktree), not the server above it.
  const extra = parsePs([...table.rows.values()].map((entry) => row(entry.pid, entry.ppid, entry.pgid, entry.rssBytes / MB, entry.command)).concat([
    row(553, 551, 550, 10, "node next-worker"),
    row(554, 553, 550, 10, "esbuild --service"),
  ]).join("\n"), 1_000_000);
  const deeper = attribute({ ...input, table: extra, cwds });
  const of = (pid) => deeper.find((entry) => entry.pid === pid);
  assert.deepEqual([of(553).owner, of(553).inheritedFrom], [{ kind: "worktree", projectId: "wt" }, 551]);
  assert.deepEqual([of(554).owner, of(554).inheritedFrom], [{ kind: "worktree", projectId: "wt" }, 551]);
});

test("each row says whether it may be stopped, and why not", () => {
  // The server runs under a terminal's shell (400) in the shell's group, which also holds a helper (410).
  const lines = [...table.rows.values()].map((entry) =>
    entry.pid === 500 ? row(500, 400, 400, 120, entry.command) : row(entry.pid, entry.ppid, entry.pgid, entry.rssBytes / MB, entry.command));
  lines.push(row(300, 1, 300, 30, "tmux"), row(400, 300, 400, 5, "-zsh"), row(410, 1, 400, 5, `node helper ${WT}/x`));
  const rows = attribute({ ...input, table: parsePs(lines.join("\n"), 1_000_000), cwds });
  const at = (pid) => rows.find((entry) => entry.pid === pid);
  const verdict = (pid) => [at(pid).stoppable, at(pid).stopBlockedReason];
  for (const pid of [520, 522, 530, 510, 540, 800, 551, 900]) assert.deepEqual(verdict(pid), [true, null], String(pid));
  assert.deepEqual(verdict(840), [false, "not attributed to a session, a worktree, or Portal"]);
  assert.deepEqual(verdict(801), [false, "inherited from pid 800; stop that process"]);
  assert.deepEqual(verdict(500), [false, "part of the Portal server"]);
  assert.deepEqual(verdict(552), [false, "part of the Portal server"], "a terminal's process with no worktree");
  assert.deepEqual(verdict(601), [false, "Portal's web server"]);
  assert.deepEqual(verdict(700), [false, "Portal's database"]);
  assert.deepEqual(verdict(710), [false, "Portal's database"]);
  // Above the server, and in a group with the server or what it runs under.
  assert.deepEqual(at(400).owner, { kind: "none" });
  assert.deepEqual(at(410).owner, { kind: "worktree", projectId: "wt" });
  assert.deepEqual(verdict(410), [false, "its process group holds the Portal server"]);
  const ancestorRows = attribute({
    ...input,
    table: parsePs([...lines, row(420, 300, 420, 5, `zsh ${WT}`)].join("\n"), 1_000_000),
    worktrees: [...input.worktrees, { projectId: "root", path: "/" }],
    cwds: new Map([[300, WT]]),
  });
  assert.equal(ancestorRows.find((entry) => entry.pid === 300).stopBlockedReason, "the Portal server runs under it");
  assert.equal(ancestorRows.find((entry) => entry.pid === 420).stoppable, true, "a sibling of the server's terminal is not above it");
});

test("orphans are session or worktree processes whose parent is pid 1", () => {
  const rows = attribute({ ...input, cwds });
  const orphans = rows.filter((entry) => entry.orphan).map((entry) => entry.pid).sort((a, b) => a - b);
  assert.deepEqual(orphans, [800, 820, 830, 841, 900]);
  assert.equal(rows.find((entry) => entry.pid === 801).orphan, false, "an inherited row has a parent");
  assert.equal(rows.find((entry) => entry.pid === 840).orphan, false, "an unattributed process is never an orphan");
  assert.equal(rows.find((entry) => entry.pid === 700).orphan, false, "nor is Portal's");
});

test("rows carry the footprint where measured, else RSS, and the table's columns", () => {
  const rows = attribute({ ...input, cwds });
  const cli = rows.find((entry) => entry.pid === 520);
  assert.equal(cli.memoryBytes, 400 * MB, "footprint");
  assert.equal(rows.find((entry) => entry.pid === 522).memoryBytes, 200 * MB, "rss");
  assert.deepEqual({ pgid: cli.pgid, ppid: cli.ppid, elapsedSeconds: cli.elapsedSeconds, cpuSeconds: cli.cpuSeconds, cwd: cli.cwd }, {
    pgid: 520, ppid: 510, elapsedSeconds: 60, cpuSeconds: 1, cwd: null,
  });
  assert.equal(rows.find((entry) => entry.pid === 551).cwd, `${WT}/apps/web`);
  assert.equal(rows.length, table.rows.size);
});

test("a path in a command line counts only as a whole path", () => {
  assert.ok(commandNames(`bazel --workspace_directory=${WT}`, WT));
  assert.ok(commandNames(`cat ${WT}/x`, WT));
  assert.ok(commandNames(`cat "${WT}"`, WT));
  assert.ok(commandNames(`${WT}/bin/tool --x`, WT));
  assert.ok(commandNames(`cat ${WT}/`, `${WT}/`), "a root with a trailing slash");
  assert.ok(!commandNames(`cat ${WT}-old/x`, WT));
  assert.ok(!commandNames(`cat /prefix${WT}`, WT));
  assert.ok(!commandNames("anything", ""));
});

test("the server's own measuring commands are left out, and its other children are not", () => {
  const rows = attribute({
    table: parsePs([
      row(1, 0, 1, 18, "/sbin/launchd"),
      row(500, 1, 500, 120, "node apps/server/src/index.ts"),
      row(530, 500, 530, 2, "top -l 1 -stats pid,mem"),
      row(531, 500, 531, 1, "/bin/ps -A -o pid=,ppid=,pgid=,etime=,time=,rss=,command="),
      row(532, 500, 532, 1, "du -sk -x /tmp/a"),
      row(533, 500, 533, 40, "git status --porcelain"),
      row(540, 1, 540, 2, "top"),
    ].join("\n")),
    memory: null,
    sessions: [],
    adapterPids: [],
    serverPid: 500,
    webPids: [],
    databasePids: [],
    worktrees: [],
  });
  assert.deepEqual(rows.map((r) => r.pid).sort((a, b) => a - b), [1, 500, 533, 540]);
});
