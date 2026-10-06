import assert from "node:assert/strict";
import test from "node:test";
import { queueEditLabel, restoreToDraft } from "../src/lib/prompt-queue.ts";

test("taken-back prompts go ahead of the draft, one per line; an empty draft is replaced", () => {
  assert.equal(restoreToDraft(["fix the tests", "then lint"], ""), "fix the tests\nthen lint");
  assert.equal(restoreToDraft(["fix the tests"], "and push"), "fix the tests\nand push");
  assert.equal(restoreToDraft([], "and push"), "and push");
  assert.equal(restoreToDraft(["  ", ""], "   "), "   ");
  assert.equal(restoreToDraft([" spaced "], "  "), "spaced");
});

test("the composer's edit line names the prompt's place in the queue, or none until the queue has it", () => {
  const queue = [{ id: "q1" }, { id: "q2" }];
  assert.equal(queueEditLabel(queue, "q1"), "Editing queued prompt 1");
  assert.equal(queueEditLabel(queue, "q2"), "Editing queued prompt 2");
  assert.equal(queueEditLabel(queue, "gone"), "Editing a queued prompt");
  assert.equal(queueEditLabel([], "q1"), "Editing a queued prompt");
});
