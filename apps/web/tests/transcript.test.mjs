import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent, firstSeq, lastSeq, reduce, segment } from "../src/lib/transcript.ts";

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
