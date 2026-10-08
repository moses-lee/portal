import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { asc, eq, sql } from "drizzle-orm";
import { appContext, buildApp } from "../src/app.ts";
import { orchestratorItems, projects, sessionEvents, sessionMessages, worldChanges, worldSnapshots } from "../src/db/schema.ts";
import { parsePullQuery, titleRefs } from "../src/search/pulls.ts";
import { likePattern, snippet, titleFromSummary } from "../src/search/service.ts";
import { createPgSessionStore } from "../src/sessions/pg-session-store.ts";
import { createMessageBackfill } from "../src/sessions/search-backfill.ts";
import { MESSAGE_TEXT_MAX, messageRowsFrom } from "../src/sessions/search-messages.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

function record(id, extra = {}) {
  return {
    id, agentId: "claude", agentName: "Claude Code", cwd: "/nonexistent/portal-search", projectId: "p1",
    createdAt: 1, lastActiveAt: 1, title: null, upstreamId: `up-${id}`,
    state: { modes: null, configOptions: [], commands: [] }, lost: null, turnOpen: false,
    ...extra,
  };
}

const user = (seq, text, ts = 1000 + seq) => ({ seq, ts, type: "user", text });
const reply = (seq, text, ts = 1000 + seq) => ({ seq, ts, type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const thought = (seq, text) => ({ seq, ts: 1000 + seq, type: "update", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } } });
const toolCall = (seq, title) => ({ seq, ts: 1000 + seq, type: "update", update: { sessionUpdate: "tool_call", toolCallId: `t${seq}`, title, kind: "execute", status: "completed", content: [{ type: "content", content: { type: "text", text: `output of ${title}` } }] } });

async function messageRows(db, sessionId) {
  return db.select({ seq: sessionMessages.seq, firstSeq: sessionMessages.firstSeq, role: sessionMessages.role, ts: sessionMessages.ts, text: sessionMessages.text })
    .from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).orderBy(asc(sessionMessages.seq));
}

test("messageRowsFrom keeps prompts and reply text, joins reply runs under their last seq, and caps the text", () => {
  const rows = messageRowsFrom([
    { seq: 0, ts: 1, type: "turn_start" },
    user(1, "Fix the login bug"),
    thought(2, "secret thinking"),
    reply(3, "Looking "),
    reply(4, "into it."),
    toolCall(5, "grep login"),
    reply(6, "Done."),
    user(7, "   "),
    reply(8, "x".repeat(MESSAGE_TEXT_MAX + 50)),
  ]);
  assert.deepEqual(rows.map(({ seq, role, text }) => ({ seq, role, text: text.slice(0, 20) })), [
    { seq: 1, role: "user", text: "Fix the login bug" },
    { seq: 4, role: "agent", text: "Looking into it." },
    { seq: 6, role: "agent", text: "Done." },
    { seq: 8, role: "agent", text: "x".repeat(20) },
  ]);
  assert.equal(rows[1].ts, 1003, "a run keeps its first chunk's time");
  assert.equal(rows[1].firstSeq, 3);
  assert.equal(rows[0].firstSeq, 1);
  assert.equal(rows[3].text.length, MESSAGE_TEXT_MAX);
});

test("query helpers: PR references, LIKE escaping, snippets, change-log titles", () => {
  assert.deepEqual(parsePullQuery("2695"), { number: 2695, repo: null });
  assert.deepEqual(parsePullQuery("#2695"), { number: 2695, repo: null });
  assert.deepEqual(parsePullQuery("Monorepo#12"), { number: 12, repo: "monorepo" });
  assert.deepEqual(parsePullQuery("acme/monorepo#12"), { number: 12, repo: "acme/monorepo" });
  assert.deepEqual(parsePullQuery("Spot Market"), { text: "spot market" });
  assert.deepEqual(titleRefs("Review monorepo#12 and #13, not PR 14"), [{ repo: "monorepo", number: 12 }, { repo: null, number: 13 }]);
  assert.equal(likePattern("50%_a\\b"), "%50\\%\\_a\\\\b%");
  assert.equal(titleFromSummary('PR acme/x#7 "Say "hi" back" needs attention: merge conflicts'), 'Say "hi" back');
  assert.equal(titleFromSummary("acme/x#7 was merged"), undefined);

  assert.equal(snippet("short NEEDLE text", "needle"), "short NEEDLE text");
  const long = `${"a".repeat(300)} needle\n\n here ${"b".repeat(300)}`;
  const cut = snippet(long, "NEEDLE");
  assert.match(cut, /^….*needle here.*…$/);
  assert.ok(cut.length <= 162);
  assert.ok(snippet(`needle ${"c".repeat(400)}`, "needle").startsWith("needle"));
});

test("the migration installs pg_trgm and the trigram index", async (t) => {
  const { db } = await temporaryDatabase(t);
  const [index] = await db.execute(sql`select indexdef from pg_indexes where indexname = 'session_messages_text_trgm_idx'`);
  assert.match(index.indexdef, /gin \(text gin_trgm_ops\)/);
});

test("appending events indexes prompts and reply text in the same write, and only once", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createPgSessionStore({ db });
  await store.putSession(record("s1"));
  await store.appendEvent("s1", user(0, "Why does the build fail?"));
  await store.appendEvents("s1", [{ seq: 1, ts: 1001, type: "turn_start" }, thought(2, "hmm, private"), toolCall(3, "pnpm build"), reply(4, "Because of "), reply(5, "a typo.")]);
  await store.appendEvent("s1", { seq: 6, ts: 1006, type: "turn_end", stopReason: "end_turn" });
  assert.deepEqual(await messageRows(db, "s1"), [
    { seq: 0, firstSeq: 0, role: "user", ts: 1000, text: "Why does the build fail?" },
    { seq: 5, firstSeq: 4, role: "agent", ts: 1004, text: "Because of a typo." },
  ]);

  // A refused append writes no message rows either.
  await assert.rejects(store.appendEvent("s1", user(3, "late prompt")), /out-of-order/i);
  await assert.rejects(store.appendEvent("ghost", user(0, "nobody home")), /No such session/);
  assert.equal((await messageRows(db, "s1")).length, 2);
  assert.equal((await db.select().from(sessionMessages)).length, 2);

  // Deleting the session drops its rows.
  await store.deleteSession("s1");
  assert.equal((await db.select().from(sessionMessages)).length, 0);
  await store.dispose();
});

test("a reply the runtime wrote as several appends is one row; a prompt, thought, or tool call in between keeps replies apart", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createPgSessionStore({ db });
  await store.putSession(record("s1"));
  // As the runtime flushes a streamed reply: each flush ends the text run, so one reply is several appends.
  await store.appendEvents("s1", [user(0, "Read the repo"), reply(1, "I'll start by lear")]);
  await store.appendEvents("s1", [reply(2, "ning the repo layout")]);
  await store.appendEvents("s1", [reply(3, ", then the tests."), { seq: 4, ts: 1004, type: "turn_end", stopReason: "end_turn" }]);
  await store.appendEvent("s1", user(5, "Thanks"));
  await store.appendEvent("s1", reply(6, "Next reply"));
  await store.appendEvent("s1", toolCall(7, "ls"));
  await store.appendEvent("s1", reply(8, "After the tool"));
  await store.appendEvent("s1", thought(9, "hmm"));
  await store.appendEvent("s1", reply(10, "After the thought"));
  assert.deepEqual((await messageRows(db, "s1")).map(({ seq, firstSeq, role, ts, text }) => ({ seq, firstSeq, role, ts, text })), [
    { seq: 0, firstSeq: 0, role: "user", ts: 1000, text: "Read the repo" },
    { seq: 3, firstSeq: 1, role: "agent", ts: 1001, text: "I'll start by learning the repo layout, then the tests." },
    { seq: 5, firstSeq: 5, role: "user", ts: 1005, text: "Thanks" },
    { seq: 6, firstSeq: 6, role: "agent", ts: 1006, text: "Next reply" },
    { seq: 8, firstSeq: 8, role: "agent", ts: 1008, text: "After the tool" },
    { seq: 10, firstSeq: 10, role: "agent", ts: 1010, text: "After the thought" },
  ]);

  // The joined text stays within the cap.
  await store.appendEvent("s1", reply(11, "y".repeat(MESSAGE_TEXT_MAX - 5)));
  await store.appendEvent("s1", reply(12, "z".repeat(20)));
  const [long] = (await messageRows(db, "s1")).filter((row) => row.seq === 12);
  assert.equal(long.firstSeq, 10);
  assert.equal(long.text.length, MESSAGE_TEXT_MAX);
  assert.ok(long.text.startsWith("After the thoughty"));
  await store.dispose();
});

test("the backfill indexes logs written around the store, below and above what is indexed, and is idempotent", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createPgSessionStore({ db });
  await store.putSession(record("old"));
  await store.putSession(record("mixed"));
  await store.putSession(record("empty"));
  const raw = (sessionId, events) => db.insert(sessionEvents).values(events.map((event) => ({ sessionId, seq: event.seq, ts: event.ts, body: event })));

  // As the legacy import or an older server wrote it: one row per few-character chunk, and a run
  // longer than a page so it straddles the page edge.
  const chunks = Array.from({ length: 2100 }, (_, i) => reply(2 + i, i === 2099 ? "end." : "ab"));
  await raw("old", [user(0, "Explain the pager"), thought(1, "thinking"), ...chunks, toolCall(2102, "ls"), reply(2103, "After the tool.")]);

  // Older events from before the table, then a live append on top of them.
  await raw("mixed", [user(0, "First prompt from before"), reply(1, "First reply")]);
  await store.appendEvents("mixed", [user(2, "Second prompt, live"), reply(3, "Second reply")]);
  // Written after the live rows but around the store, as if by an older server still running.
  await raw("mixed", [toolCall(4, "x"), reply(5, "Tail reply")]);

  const log = { infos: [], warns: [], info(obj, msg) { this.infos.push({ obj, msg }); }, warn(obj, msg) { this.warns.push({ obj, msg }); } };
  const backfill = createMessageBackfill({ db, log }, { start: false });
  t.after(() => backfill.dispose());
  const first = await backfill.run();
  assert.equal(first.failed, 0);
  assert.equal(first.sessions, 3);

  const old = await messageRows(db, "old");
  assert.deepEqual(old.map(({ seq, role }) => ({ seq, role })), [{ seq: 0, role: "user" }, { seq: 2101, role: "agent" }, { seq: 2103, role: "agent" }]);
  assert.equal(old[1].text, `${"ab".repeat(2099)}end.`);
  assert.equal(old[1].ts, 1002);

  assert.deepEqual((await messageRows(db, "mixed")).map(({ seq, text }) => ({ seq, text })), [
    { seq: 0, text: "First prompt from before" },
    { seq: 1, text: "First reply" },
    { seq: 2, text: "Second prompt, live" },
    { seq: 3, text: "Second reply" },
    { seq: 5, text: "Tail reply" },
  ]);

  const again = await backfill.run();
  assert.equal(again.rows, 0);
  assert.equal((await db.select().from(sessionMessages)).length, 8);
  assert.deepEqual(log.warns, []);
});

test("the backfill joins old chunks to a reply a live append continued, and the next live append keeps joining", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createPgSessionStore({ db });
  await store.putSession(record("s1"));
  // Written before the table existed: a prompt and the start of a reply, one row per chunk.
  await db.insert(sessionEvents).values([user(0, "Go"), reply(1, "Old "), reply(2, "chunks ")].map((event) => ({ sessionId: "s1", seq: event.seq, ts: event.ts, body: event })));
  // The first live write continues that reply; nothing below it is indexed yet.
  await store.appendEvent("s1", reply(3, "then live"));
  assert.deepEqual((await messageRows(db, "s1")).map(({ seq, firstSeq, text }) => ({ seq, firstSeq, text })), [{ seq: 3, firstSeq: 3, text: "then live" }]);

  const backfill = createMessageBackfill({ db, log: { info() {}, warn() {} } }, { start: false });
  t.after(() => backfill.dispose());
  await backfill.run();
  const joined = [
    { seq: 0, firstSeq: 0, role: "user", ts: 1000, text: "Go" },
    { seq: 3, firstSeq: 1, role: "agent", ts: 1001, text: "Old chunks then live" },
  ];
  assert.deepEqual(await messageRows(db, "s1"), joined);
  assert.equal((await backfill.run()).rows, 0);
  assert.deepEqual(await messageRows(db, "s1"), joined);

  await store.appendEvent("s1", reply(4, " and more."));
  assert.deepEqual((await messageRows(db, "s1")).map(({ seq, firstSeq, ts, text }) => ({ seq, firstSeq, ts, text })), [
    { seq: 0, firstSeq: 0, ts: 1000, text: "Go" },
    { seq: 4, firstSeq: 1, ts: 1001, text: "Old chunks then live and more." },
  ]);
  await store.dispose();
});

/**
 * An app over a throwaway database seeded with sessions, projects, a world build, change-log PR
 * rows, items, and message rows.
 */
async function seededApp(t) {
  // A main checkout that is on a PR's head branch right now: its sessions must not match by branch.
  const checkout = mkdtempSync(path.join(os.tmpdir(), "portal-search-checkout-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(path.join(checkout, ".git"));
  writeFileSync(path.join(checkout, ".git", "HEAD"), "ref: refs/heads/feat/spot-market\n");
  const database = await temporaryDatabase(t);
  const { db } = database;
  const store = createPgSessionStore({ db });
  await db.insert(projects).values([
    { id: "main", name: "monorepo", path: "/nonexistent/monorepo", createdAt: 1 },
    { id: "wt", name: "monorepo-spot", path: "/nonexistent/monorepo-spot", createdAt: 2, worktree: { parentId: "main", branch: "feat/spot-market" } },
    // A worktree made after the world build: it belongs to the repo through its parent.
    { id: "wt2", name: "monorepo-candles", path: "/nonexistent/monorepo-candles", createdAt: 3, worktree: { parentId: "main", branch: "fix/candles" } },
    { id: "other", name: "elsewhere", path: "/nonexistent/elsewhere", createdAt: 4 },
  ]);
  const sessions = [
    record("by-item", { projectId: "main", lastActiveAt: 10, title: "Something unrelated" }),
    record("by-title", { projectId: "main", lastActiveAt: 20, title: "Review monorepo#2695" }),
    record("by-bare-title", { projectId: "main", lastActiveAt: 30, title: "PR #2695 follow-up" }),
    record("bare-title-other-repo", { projectId: "other", lastActiveAt: 31, title: "PR #2695 elsewhere" }),
    record("by-branch", { projectId: "wt", lastActiveAt: 40, title: "Spot work" }),
    record("by-new-worktree", { projectId: "wt2", lastActiveAt: 45, title: "Candles" }),
    record("both", { projectId: "wt", lastActiveAt: 50, title: "acme/monorepo#2695 again" }),
    record("chatty", { projectId: "other", lastActiveAt: 60, title: "Chat" }),
    record("main-checkout", { projectId: "main", cwd: checkout, lastActiveAt: 70, title: "Spot market on main" }),
  ];
  for (const session of sessions) await store.putSession(session);
  const pull = (number, title, headBranch, updatedAt) => ({
    repo: "acme/monorepo", number, url: `https://github.com/acme/monorepo/pull/${number}`, title, headBranch, updatedAt,
    author: "me", roles: ["author"], state: "open", draft: false, baseBranch: "main", checks: null, reviewDecision: null, mergeable: "mergeable", localProjectId: "main", worktreeProjectId: null,
  });
  await db.insert(worldSnapshots).values({
    at: 100,
    body: {
      reason: "test",
      world: {
        pulls: [pull(2695, "Treat a completed curve as an eligible spot market", "feat/spot-market", 200), pull(2700, "Fix candles", "fix/candles", 300)],
        repos: [{ repo: "acme/monorepo", defaultBranch: "main", projectIds: ["main", "wt"] }],
        projects: [{ id: "main", repo: "acme/monorepo" }, { id: "wt", repo: "acme/monorepo" }, { id: "other", repo: "acme/other" }],
      },
    },
  });
  await db.insert(worldChanges).values([
    { subject: "pr:acme/monorepo#2497", at: 50, kind: "pr_merged", fingerprint: "f1", summary: 'acme/monorepo#2497 "Boot hermetic PostgreSQL" was merged', refs: { pull: { repo: "acme/monorepo", number: 2497, url: "https://github.com/acme/monorepo/pull/2497" } } },
    { subject: "pr:acme/monorepo#2695", at: 60, kind: "pr_merged", fingerprint: "f2", summary: 'acme/monorepo#2695 "Old title" was merged', refs: { pull: { repo: "acme/monorepo", number: 2695, url: "https://github.com/acme/monorepo/pull/2695" } } },
    { subject: "pr:acme/monorepo#2400", at: 40, kind: "pr_merged", fingerprint: "f3", summary: "acme/monorepo#2400 was merged", refs: { pull: { repo: "acme/monorepo", number: 2400, url: "https://github.com/acme/monorepo/pull/2400" } } },
  ]);
  const item = (id, links) => ({ id, status: "resolved", fingerprint: id, createdAt: 1, updatedAt: 1, body: { id, links } });
  await db.insert(orchestratorItems).values([
    item("i1", { sessionId: "by-item", pull: { repo: "acme/monorepo", number: 2695, url: "u" } }),
    item("i2", { sessionId: "both", pull: { repo: "acme/monorepo", number: 2695, url: "u" } }),
    item("i3", { sessionId: "by-title", pull: { repo: "acme/monorepo", number: 2400, url: "u" } }),
    item("i4", { sessionId: "deleted-session", pull: { repo: "acme/monorepo", number: 2695, url: "u" } }),
    item("i5", { pull: { repo: "acme/monorepo", number: 2497, url: "u" } }),
    // Known only through an item: the change log row is gone.
    item("i6", { sessionId: "by-item", pull: { repo: "acme/monorepo", number: 3000, url: "https://github.com/acme/monorepo/pull/3000" } }),
  ]);
  await store.appendEvents("chatty", [
    user(0, "Where is 100% of the CPU going?", 5_000),
    reply(1, "Mostly in the render loop; 100 percent of one core.", 6_000),
    user(2, `${"filler ".repeat(60)}The render loop again ${"tail ".repeat(60)}`, 7_000),
    user(3, "under a_b score", 8_000),
    user(4, "axb and a%b", 9_000),
  ]);
  await store.dispose();

  const app = await buildApp({ database, orchestrator: false, lifecycle: { start: false }, searchBackfill: { start: false } });
  t.after(() => app.close());
  const search = async (q) => {
    const response = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}` });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  return { app, search };
}

const pullsOf = (body) => body.pulls.map(({ sessionId, pull, via }) => `${sessionId} ${pull.repo}#${pull.number} ${via}`);

test("GET /api/search finds sessions by PR number, repo#number, title, and head branch", async (t) => {
  const { app, search } = await seededApp(t);
  assert.equal(typeof appContext(app).searchBackfill.run, "function");

  const byNumber = await search("2695");
  // Newest session first; item beats title beats branch. Not counted: a bare #2695 in another
  // repo's session, an item for a deleted session, and "main-checkout", whose main checkout is on
  // the PR's head branch now (only a worktree's branch associates).
  assert.deepEqual(pullsOf(byNumber), [
    "both acme/monorepo#2695 item",
    "by-branch acme/monorepo#2695 branch",
    "by-bare-title acme/monorepo#2695 title",
    "by-title acme/monorepo#2695 title",
    "by-item acme/monorepo#2695 item",
  ]);
  assert.equal(byNumber.pulls[0].pull.title, "Treat a completed curve as an eligible spot market", "the world's title wins over the change log's");
  assert.equal(byNumber.pulls[0].pull.url, "https://github.com/acme/monorepo/pull/2695");

  assert.deepEqual(pullsOf(await search("#2695")), pullsOf(byNumber));
  assert.deepEqual(pullsOf(await search("monorepo#2695")), pullsOf(byNumber));
  assert.deepEqual(pullsOf(await search("acme/monorepo#2695")), pullsOf(byNumber));
  assert.deepEqual(pullsOf(await search("other#2695")), []);

  // Known only from the change log: matches by number, carries its title, and an item links a session.
  const changeOnly = await search("2400");
  assert.deepEqual(pullsOf(changeOnly), ["by-title acme/monorepo#2400 item"]);
  assert.equal(changeOnly.pulls[0].pull.title, undefined);

  // Title substring, case-insensitive.
  assert.deepEqual(pullsOf(await search("ELIGIBLE spot")), pullsOf(byNumber));
  assert.deepEqual(pullsOf(await search("hermetic")), [], "a change-log PR no session is linked to finds nothing");

  // Known only through an item: matches by number, without a title.
  const itemOnly = await search("monorepo#3000");
  assert.deepEqual(pullsOf(itemOnly), ["by-item acme/monorepo#3000 item"]);
  assert.deepEqual(itemOnly.pulls[0].pull, { repo: "acme/monorepo", number: 3000, url: "https://github.com/acme/monorepo/pull/3000" });

  // Head branch substring; a worktree made after the build belongs to its parent's repo.
  assert.deepEqual(pullsOf(await search("fix/cand")), ["by-new-worktree acme/monorepo#2700 branch"]);
});

test("GET /api/search answers message hits newest first with snippets, escapes LIKE, and ignores short queries", async (t) => {
  const { app, search } = await seededApp(t);

  const loop = await search("  render LOOP ");
  assert.equal(loop.q, "render LOOP");
  assert.deepEqual(loop.messages.map(({ sessionId, seq, role, ts }) => ({ sessionId, seq, role, ts })), [
    { sessionId: "chatty", seq: 2, role: "user", ts: 7_000 },
    { sessionId: "chatty", seq: 1, role: "agent", ts: 6_000 },
  ]);
  assert.match(loop.messages[0].snippet, /^….*The render loop again.*…$/);
  assert.equal(loop.messages[1].snippet, "Mostly in the render loop; 100 percent of one core.");

  // `%` and `_` match only themselves.
  assert.deepEqual((await search("100%")).messages.map(({ seq }) => seq), [0]);
  assert.deepEqual((await search("a_b")).messages.map(({ seq }) => seq), [3]);
  assert.deepEqual((await search("a%b")).messages.map(({ seq }) => seq), [4]);

  assert.deepEqual(await search("r"), { q: "r", messages: [], pulls: [] });
  assert.deepEqual(await search("   "), { q: "", messages: [], pulls: [] });
  // Long queries are cut, not refused.
  const long = await search(`render loop ${"q".repeat(300)}`);
  assert.equal(long.q.length, 200);
  assert.deepEqual(long.messages, []);

  const bare = await app.inject({ method: "GET", url: "/api/search" });
  assert.deepEqual(bare.json(), { q: "", messages: [], pulls: [] });
});
