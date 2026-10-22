import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent, firstSeq, lastSeq, reduce, segment } from "../src/transcript.ts";

const text = (seq, t, kind = "agent_message_chunk") => ({ seq, ts: 0, type: "update", update: { sessionUpdate: kind, content: { type: "text", text: t } } });
const user = (seq, t) => ({ seq, ts: 0, type: "user", text: t });

test("Codex terminal deltas render live and from history without losing sparse updates or repeating replayed chunks", () => {
  const call = (seq, extra) => ({ seq, ts: 0, type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "shell", ...extra } });
  const chunk = (data, terminal_id = "shell") => ({ terminal_output_delta: { terminal_id, data } });
  const events = [
    { seq: 0, ts: 0, type: "update", update: {
      sessionUpdate: "tool_call", toolCallId: "shell", title: "pnpm test", kind: "execute", status: "in_progress",
      rawInput: { command: "pnpm test" }, content: [{ type: "terminal", terminalId: "shell" }],
      _meta: chunk("Starting\n"),
    } },
    call(1, { _meta: chunk("PASS\n") }),
    call(2, { _meta: chunk("PASS\n") }),
    call(3, { _meta: chunk("wrong terminal", "other") }),
    call(4, { _meta: chunk(42) }),
    call(5, { _meta: { terminal_output_delta: null } }),
    call(6, { status: "completed", _meta: { terminal_exit: { terminal_id: "shell", exit_code: 0, signal: null } } }),
  ];
  let history = { turns: segment(events.slice(0, 1)), hasMore: false };
  const before = history.turns[0].blocks[0];
  for (const event of events.slice(1)) history = appendEvent(history, event);
  const [block] = history.turns[0].blocks;
  assert.equal(before.rawOutput, "Starting\n", "old snapshots stay immutable");
  assert.equal(block.rawOutput, "Starting\nPASS\nPASS\n");
  assert.equal(block.title, "pnpm test");
  assert.equal(block.toolKind, "execute");
  assert.equal(block.status, "completed");
  assert.deepEqual(block.rawInput, { command: "pnpm test" });
  assert.deepEqual(reduce(events), [block], "stored history renders exactly like live chunks");
  assert.equal(appendEvent(history, events[2]), history, "replayed sequence numbers do not append twice");
});

test("Codex completion-only output and old aggregate results remain readable", () => {
  const start = { seq: 0, ts: 0, type: "update", update: { sessionUpdate: "tool_call", toolCallId: "shell", title: "echo ok" } };
  const end = (extra) => ({ seq: 1, ts: 0, type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "shell", status: "completed", ...extra } });
  assert.equal(reduce([start, end({ _meta: { terminal_output_delta: { terminal_id: "shell", data: "ok\n" } } })])[0].rawOutput, "ok\n");
  assert.deepEqual(reduce([start, end({ rawOutput: { formatted_output: "ok\n", exit_code: 0 } })])[0].rawOutput, { formatted_output: "ok\n", exit_code: 0 });
  assert.equal(reduce([start, end({ rawOutput: "search result" })])[0].rawOutput, "search result");
});

test("reduce concatenates adjacent text, tracks tool updates, and settles permissions at turn end", () => {
  const blocks = reduce([
    user(0, "hi"),
    text(1, "He"), text(2, "llo"),
    { seq: 3, ts: 0, type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", status: "pending" } },
    { seq: 4, ts: 0, type: "permission_request", requestId: "p1", toolCall: { toolCallId: "t1" }, options: [] },
    { seq: 5, ts: 0, type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "a\nb" } },
    text(6, "done"),
    { seq: 7, ts: 0, type: "turn_end", stopReason: "end_turn" },
  ]);
  assert.deepEqual(blocks.map((b) => b.kind), ["user", "assistant", "tool", "permission", "assistant", "turn_end"]);
  assert.equal(blocks[1].text, "Hello");
  assert.equal(blocks[2].status, "completed");
  assert.equal(blocks[2].rawOutput, "a\nb");
  assert.deepEqual(blocks[3].response, { outcome: "cancelled" });
});

test("segment splits at user events and appendEvent re-reduces only the last turn", () => {
  const history = { turns: segment([user(0, "a"), text(1, "x"), user(2, "b"), text(3, "y")]), hasMore: false };
  assert.deepEqual(history.turns.map((t) => t.key), [0, 2]);
  assert.equal(firstSeq(history), 0);
  assert.equal(lastSeq(history), 3);
  const next = appendEvent(history, text(4, "z"));
  assert.equal(next.turns[0], history.turns[0]);
  assert.equal(next.turns[1].blocks[1].text, "yz");
  const another = appendEvent(next, user(5, "c"));
  assert.deepEqual(another.turns.map((t) => t.key), [0, 2, 5]);
  assert.equal(lastSeq(another), 5);
  assert.equal(firstSeq({ turns: [], hasMore: false }), undefined);
});

test("appendEvent updates only the block an event touches and ignores an event it already holds", () => {
  const call = (seq, extra) => ({ seq, ts: 0, type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", ...extra } });
  let history = { turns: segment([
    user(0, "go"),
    text(1, "one"),
    { seq: 2, ts: 0, type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", status: "pending" } },
  ]), hasMore: false };
  const [turn] = history.turns;
  const before = turn.blocks;
  history = appendEvent(history, call(3, { status: "in_progress" }));
  const after = history.turns[0].blocks;
  assert.notEqual(after, before, "a changed turn gets a new blocks array");
  assert.equal(after[0], before[0], "untouched blocks keep their identity");
  assert.equal(after[1], before[1]);
  assert.notEqual(after[2], before[2]);
  assert.equal(after[2].status, "in_progress");
  assert.equal(before[2].status, "pending", "the old snapshot is left alone");
  assert.equal(history.turns[0].lastSeq, 3);
  // The same event again (a replay, or React calling an updater twice) changes nothing.
  const same = appendEvent(history, call(3, { status: "in_progress" }));
  assert.equal(same.turns, history.turns);
  const stale = appendEvent(history, text(2, "late"));
  assert.equal(stale.turns, history.turns);
  // Streamed text extends the assistant block as a new object; the tool block keeps its identity.
  const more = appendEvent(history, text(4, "two"));
  assert.equal(more.turns[0].blocks[2], after[2]);
  assert.equal(more.turns[0].blocks.length, 4, "text after a tool starts a new block");
  assert.equal(more.turns[0].blocks.at(-1).kind, "assistant");
  // Client-only notices (negative seqs) are always applied and never move the cursor.
  const noticed = appendEvent(more, { seq: -1, ts: 0, type: "error", message: "offline" });
  assert.equal(noticed.turns[0].blocks.at(-1).message, "offline");
  assert.equal(lastSeq(noticed), 4);
  const twice = appendEvent(noticed, { seq: -2, ts: 0, type: "error", message: "still" });
  assert.equal(twice.turns[0].blocks.length, more.turns[0].blocks.length + 2);
  assert.deepEqual(reduce([user(0, "go"), text(1, "one"), call(3, { status: "in_progress" })]).map((b) => b.kind), ["user", "assistant"], "an update for an unknown call is dropped");
});

test("appendEvent ignores a replayed user event, so a replay opens no second turn; a first event or a client notice still applies", () => {
  const turnEnd = (seq) => ({ seq, ts: 0, type: "turn_end", stopReason: "end_turn" });
  const history = { turns: segment([user(0, "a"), text(1, "x"), turnEnd(2), user(3, "b"), turnEnd(4)]), hasMore: false };
  const span = (h) => h.turns.map((t) => [t.key, t.lastSeq]);
  assert.deepEqual(span(history), [[0, 2], [3, 4]]);
  // The stream reopened from an older cursor and replayed 2..4 (see `lib/session-stream-hub`).
  const replayed = [turnEnd(2), user(3, "b"), turnEnd(4)].reduce(appendEvent, history);
  assert.equal(replayed, history, "nothing changes, and the history keeps its identity");
  assert.deepEqual(span(replayed), [[0, 2], [3, 4]]);
  // The next prompt still opens a turn, and a replay of it is dropped too.
  const next = appendEvent(replayed, user(5, "c"));
  assert.deepEqual(span(next), [[0, 2], [3, 4], [5, 5]]);
  assert.equal(appendEvent(next, user(5, "c")), next);
  // A user event with a stale seq (below the last turn) is a replay as well.
  assert.equal(appendEvent(next, user(1, "old")), next);
  // The first event of an empty history always opens a turn, whatever its seq; a client notice (negative seq) always applies.
  assert.deepEqual(span(appendEvent({ turns: [], hasMore: false }, user(0, "first"))), [[0, 0]]);
  assert.deepEqual(span(appendEvent({ turns: [], hasMore: false }, text(7, "mid-turn"))), [[7, 7]]);
  const noticed = appendEvent(next, { seq: -1, ts: 0, type: "error", message: "offline" });
  assert.equal(noticed.turns.at(-1).blocks.at(-1).message, "offline");
  assert.equal(lastSeq(noticed), 5);
});

test("a page that starts inside a turn reduces on its own; the turn is keyed by its first event", () => {
  const turns = segment([text(40, "tail"), { seq: 41, ts: 0, type: "turn_end", stopReason: "end_turn" }, user(42, "next")]);
  assert.deepEqual(turns.map((t) => t.key), [40, 42]);
  assert.deepEqual(turns[0].blocks.map((b) => b.kind), ["assistant", "turn_end"]);
  assert.equal(firstSeq({ turns, hasMore: true }), 40);
});

test("a prompt keeps its logged time and a turn records when it ended", () => {
  let history = { turns: segment([{ ...user(0, "hi"), ts: 1000 }, { ...text(1, "Hel"), ts: 1100 }]), hasMore: false };
  assert.equal(history.turns[0].blocks[0].at, 1000);
  assert.equal(history.turns[0].endedAt, null, "a running turn has no end time");
  history = appendEvent(history, { ...text(2, "lo"), ts: 1200 });
  // A client-only notice (negative seq) describes a failed request; it does not end the turn.
  history = appendEvent(history, { seq: -1, ts: 1300, type: "error", message: "request failed" });
  assert.equal(history.turns[0].endedAt, null);
  history = appendEvent(history, { seq: 3, ts: 1500, type: "turn_end", stopReason: "end_turn" });
  assert.equal(history.turns[0].endedAt, 1500);
  assert.equal(history.turns[0].blocks.at(-1).at, 1500);
  // A server-side error cuts the turn off.
  const cut = segment([user(0, "a"), { seq: 1, ts: 1400, type: "error", message: "Portal restarted" }]);
  assert.equal(cut[0].endedAt, 1400);
  // A turn that ended at an unknown time is still ended.
  assert.equal(segment([user(0, "a"), { seq: 1, ts: 0, type: "turn_end", stopReason: "end_turn" }])[0].endedAt, 0);
});

test("a user block carries the prompt's attachments, and has none when the event has none", () => {
  const shot = { path: "/home/me/.portal/uploads/s1/ab12cd34-shot.png", name: "shot.png", mimeType: "image/png", size: 2048 };
  const [withFiles] = reduce([{ ...user(0, ""), attachments: [shot] }]);
  assert.deepEqual(withFiles, { kind: "user", text: "", at: 0, attachments: [shot] });
  const [plain] = reduce([{ ...user(0, "hi"), attachments: [] }]);
  assert.equal("attachments" in plain, false, "an empty list adds no field");
});
