import assert from "node:assert/strict";
import test from "node:test";
import { restoreToDraft } from "../src/lib/prompt-queue.ts";

test("taken-back prompts go ahead of the draft, one per line; an empty draft is replaced", () => {
  assert.equal(restoreToDraft(["fix the tests", "then lint"], ""), "fix the tests\nthen lint");
  assert.equal(restoreToDraft(["fix the tests"], "and push"), "fix the tests\nand push");
  assert.equal(restoreToDraft([], "and push"), "and push");
  assert.equal(restoreToDraft(["  ", ""], "   "), "   ");
  assert.equal(restoreToDraft([" spaced "], "  "), "spaced");
});
