import assert from "node:assert/strict";
import test from "node:test";
import { terminate } from "../src/lib/process-stop.ts";

/** A fake `signalTarget`: `alive(target)` says whether a target is there; every signal sent is recorded. */
function fakeSignals(alive) {
  const sent = [];
  const signal = (stop, sig) => {
    const id = "pgid" in stop ? -stop.pgid : stop.pid;
    if (sig !== 0) sent.push([id, sig]);
    return alive(id);
  };
  return { sent, signal };
}

test("a target seen gone during the grace is not sent SIGKILL, even when its number is in use again by then", async () => {
  // 101 exits on SIGTERM, and its pid is handed to a new process before the grace ends; 102 ignores SIGTERM.
  let polls = 0;
  const { sent, signal } = fakeSignals((id) => {
    if (id === 101) return polls++ === 0 || polls > 3;
    return true;
  });
  const termination = terminate([{ pid: 101 }, { pid: 102 }], { graceMs: 60_000, signal });
  await new Promise((resolve) => setTimeout(resolve, 350));
  termination.hurry();
  await termination.done;
  assert.deepEqual(sent, [[101, "SIGTERM"], [102, "SIGTERM"], [102, "SIGKILL"]]);
});

test("terminate finishes once every target is gone, and hurry sends SIGKILL only to what is left", async () => {
  const gone = new Set();
  const { sent, signal } = fakeSignals((id) => !gone.has(id));
  const termination = terminate([{ pgid: 7 }, { pid: 8 }], { graceMs: 60_000, signal });
  gone.add(-7);
  gone.add(8);
  await termination.done;
  assert.deepEqual(sent, [[-7, "SIGTERM"], [8, "SIGTERM"]]);
  termination.hurry();
  assert.deepEqual(sent, [[-7, "SIGTERM"], [8, "SIGTERM"]], "nothing to kill after the fact");
});
