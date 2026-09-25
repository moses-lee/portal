import assert from "node:assert/strict";
import test from "node:test";
import { emptyScope } from "../src/orchestrator/types.ts";
import {
  FRESH_MS, RECENT_CHANGE_LINES, coveredByIntent, freshAndMine, previousAnswerAt, renderRecentChanges, selectRecentChanges, threadRefs, touchesThread,
} from "../src/orchestrator/world/recent.ts";
import { T0 } from "./fixtures/orchestrator-fakes.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;

let nextId = 1;
/** A change-log row; a PR of someone else's, detected a minute ago, unless told otherwise. */
function row(overrides = {}) {
  const number = overrides.number ?? 7;
  const { number: _, ...rest } = overrides;
  return {
    id: nextId++, subject: `pr:acme/app#${number}`, at: T0 - MIN, kind: "pr_checks_failing", fingerprint: `pr:acme/app#${number}`,
    summary: `PR acme/app#${number} "Thing" needs attention: checks failing`, detail: null,
    refs: { pull: { repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}` } }, mine: false, activeAt: null, ...rest,
  };
}

const noRefs = () => threadRefs({ scope: emptyScope(), messages: [], items: [] });
const select = (rows, overrides = {}) => selectRecentChanges({ rows, now: T0, since: T0 - HOUR, refs: noRefs(), intents: [], dismissed: new Set(), ...overrides });
const message = (role, text, metadata = {}) => ({ id: `${role}-${text}`, role, parts: [{ type: "text", text }], metadata: { at: T0, ...metadata } });

test("threadRefs reads what a thread named: scope, touched items' links, PRs and ids in its text and tool inputs", () => {
  const scope = { ...emptyScope(), sessionIds: ["s-scope"], repos: ["Acme/Lib"] };
  const messages = [
    message("user", "How is acme/app#12 doing? And PR 34, pull request #56, https://github.com/acme/web/pull/78"),
    { id: "a1", role: "assistant", metadata: { at: T0, itemIds: ["i1"] }, parts: [
      { type: "tool-resolve_pull", toolCallId: "c1", state: "output-available", input: { number: 90 }, output: {} },
      { type: "tool-get_session", toolCallId: "c2", state: "output-available", input: { id: "0f3c9a2e-session" }, output: {} },
    ] },
  ];
  const refs = threadRefs({ scope, messages, items: [{ id: "i1", links: { projectId: "p-item", pull: { repo: "acme/app", number: 3, url: "u" } } }] });
  assert.deepEqual([...refs.sessionIds], ["s-scope"]);
  assert.deepEqual([...refs.projectIds], ["p-item"]);
  assert.deepEqual([...refs.repos], ["acme/lib"]);
  assert.ok(refs.pulls.has("acme/app#3") && refs.pulls.has("acme/app#12") && refs.pulls.has("acme/web#78"));
  for (const number of [12, 34, 56, 90]) assert.ok(refs.numbers.has(number), `#${number}`);
  assert.ok(touchesThread({ subject: "session:0f3c9a2e-session", refs: { sessionId: "0f3c9a2e-session" } }, refs), "an id in a tool input");
  assert.ok(touchesThread(row({ number: 34 }), refs), "a bare PR number");
  assert.ok(touchesThread({ ...row({ number: 5 }), refs: { pull: { repo: "acme/lib", number: 5, url: "u" } } }, refs), "a repo in the thread's scope");
  assert.ok(!touchesThread(row({ number: 35 }), refs));
  // A project speaks for its own worktree and folder, not for every session in it.
  assert.ok(touchesThread({ subject: "worktree:p-item", refs: { projectId: "p-item" } }, refs));
  assert.ok(!touchesThread({ subject: "session:other", refs: { sessionId: "other", projectId: "p-item" } }, refs));
});

test("the keep rules: touching the thread, fresh and the user's own, or a new review request; nothing else", () => {
  const touching = row({ number: 12 });
  const freshMine = row({ number: 20, mine: true, activeAt: T0 - 2 * HOUR });
  const staleMine = row({ number: 21, mine: true, activeAt: T0 - FRESH_MS - MIN });
  const freshSession = row({ subject: "session:s1", kind: "session_finished", fingerprint: "session_finished:s1", refs: { sessionId: "s1" }, mine: true, activeAt: T0 - 30 * MIN });
  const review = row({ number: 30, subject: "review:acme/app#30", kind: "pr_review_requested", fingerprint: "pr_review_requested:acme/app" });
  const others = row({ number: 40 });
  const dirty = row({ subject: "worktree:w1", kind: "worktree_dirty", fingerprint: "worktree_dirty:w1", refs: { projectId: "w1" } });
  const refs = threadRefs({ scope: emptyScope(), messages: [message("user", "what about #12?")], items: [] });
  const { shown, more } = select([touching, freshMine, staleMine, freshSession, review, others, dirty], { refs });
  assert.deepEqual(shown.map((entry) => entry.subject).sort(), [touching, freshMine, freshSession, review].map((entry) => entry.subject).sort());
  assert.equal(more, 0);
  assert.equal(freshAndMine(freshMine, T0), true);
  assert.equal(freshAndMine(staleMine, T0), false, "a PR failing for days is old news");
  assert.equal(freshAndMine({ ...freshMine, mine: false }, T0), false, "someone else's PR");
  assert.equal(freshAndMine({ ...dirty, mine: true, activeAt: T0 }, T0), false, "worktrees are never fresh news");
});

test("rows from before the thread's previous answer, rows an active intent covers, and dismissed rows are dropped", () => {
  const mine = { mine: true, activeAt: T0 - HOUR };
  const old = row({ number: 1, ...mine, at: T0 - 2 * HOUR });
  const watched = row({ number: 2, ...mine });
  const watchedSession = row({ subject: "session:s9", kind: "session_waiting", fingerprint: "session_waiting:s9", refs: { sessionId: "s9" }, ...mine });
  const dismissedReview = row({ number: 3, subject: "review:acme/app#3", kind: "pr_review_requested", fingerprint: "pr_review_requested:acme/app" });
  const kept = row({ number: 4, ...mine });
  const intents = [{ scope: { ...emptyScope(), pulls: [{ repo: "acme/app", number: 2, url: "u" }] } }, { scope: { ...emptyScope(), sessionIds: ["s9"] } }];
  const { shown } = select([old, watched, watchedSession, dismissedReview, kept], { intents, dismissed: new Set(["pr_review_requested:acme/app"]) });
  assert.deepEqual(shown.map((entry) => entry.subject), ["pr:acme/app#4"]);
});

test("at most RECENT_CHANGE_LINES rows, newest first, then a +N more line; nothing at all renders as empty", () => {
  const rows = Array.from({ length: RECENT_CHANGE_LINES + 3 }, (_, i) => row({ number: 100 + i, subject: `review:acme/app#${100 + i}`, kind: "pr_review_requested", at: T0 - (i + 1) * MIN }));
  const selected = select(rows);
  assert.equal(selected.shown.length, RECENT_CHANGE_LINES);
  assert.equal(selected.more, 3);
  assert.equal(selected.shown[0].subject, "review:acme/app#100");
  const text = renderRecentChanges(selected, T0);
  const lines = text.split("\n");
  assert.equal(lines.length, RECENT_CHANGE_LINES + 1);
  assert.equal(lines[0], '- 1m ago: PR acme/app#100 "Thing" needs attention: checks failing');
  assert.equal(lines.at(-1), "- +3 more (get_changes)");
  assert.equal(renderRecentChanges(select([]), T0), "");
});

test("previousAnswerAt is the thread's last chat answer before the newest user message; job notes and old tick notes do not count", () => {
  assert.equal(previousAnswerAt([message("user", "hi")]), null);
  const messages = [
    message("user", "one", { at: T0 - 5 * HOUR }),
    message("assistant", "answer", { at: T0 - 4 * HOUR, run: { id: "r1", kind: "chat" } }),
    message("assistant", "scheduled check", { at: T0 - 3 * HOUR, tick: { id: "t", reason: "schedule" } }),
    message("assistant", "helper note", { at: T0 - 2 * HOUR, run: { id: "r2", kind: "helper" } }),
    message("user", "two", { at: T0 }),
  ];
  assert.equal(previousAnswerAt(messages), T0 - 4 * HOUR);
  assert.equal(previousAnswerAt([message("assistant", "from before runs", { at: T0 - HOUR }), message("user", "x")]), T0 - HOUR);
});

test("a scope's id prefix and the World section's short id in the thread's text both name the full id of a change", () => {
  const id = "17329ac6-0c1e-4c4f-9a57-3d2b1f0e9a01";
  const change = { subject: `session:${id}`, refs: { sessionId: id } };
  const scoped = threadRefs({ scope: { ...emptyScope(), sessionIds: ["17329ac6"] }, messages: [], items: [] });
  assert.ok(touchesThread(change, scoped), "a prefix stored in the scope");
  const said = threadRefs({ scope: emptyScope(), messages: [message("assistant", "The review [17329ac6] is still working.")], items: [] });
  assert.ok(touchesThread(change, said), "the short id the model saw and repeated");
  assert.ok(!touchesThread(change, threadRefs({ scope: { ...emptyScope(), sessionIds: ["173"] }, messages: [], items: [] })), "too short to count");
  assert.ok(coveredByIntent(change, [{ scope: { ...emptyScope(), sessionIds: ["17329ac6"] } }]));
  assert.ok(!coveredByIntent(change, [{ scope: { ...emptyScope(), sessionIds: ["5e0f1b2c"] } }]));
});
