import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent, firstSeq, lastSeq, reduce, segment } from "../src/transcript.ts";

const text = (seq, t, kind = "agent_message_chunk") => ({ seq, ts: 0, type: "update", update: { sessionUpdate: kind, content: { type: "text", text: t } } });
const user = (seq, t) => ({ seq, ts: 0, type: "user", text: t });

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

test("a page that starts inside a turn reduces on its own; the turn is keyed by its first event", () => {
  const turns = segment([text(40, "tail"), { seq: 41, ts: 0, type: "turn_end", stopReason: "end_turn" }, user(42, "next")]);
  assert.deepEqual(turns.map((t) => t.key), [40, 42]);
  assert.deepEqual(turns[0].blocks.map((b) => b.kind), ["assistant", "turn_end"]);
  assert.equal(firstSeq({ turns, hasMore: true }), 40);
});
