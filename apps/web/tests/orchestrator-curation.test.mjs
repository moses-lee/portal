import assert from "node:assert/strict";
import test from "node:test";
import {
  consolidationFields, consolidationInput, consolidationResult, curationRunLine, groupChanges, parseConsolidationInput,
} from "../src/lib/orchestrator/curation.ts";

test("consolidation fields read as text, and blank turns a trigger off but never the interval", () => {
  const settings = { nightlyAt: "03:00", inboxThreshold: null, minIntervalMinutes: 60 };
  assert.deepEqual(consolidationFields.map((field) => consolidationInput(settings, field)), ["03:00", "", "60"]);
  assert.deepEqual(parseConsolidationInput("nightlyAt", " 04:30 "), { value: "04:30" });
  assert.deepEqual(parseConsolidationInput("nightlyAt", ""), { value: null });
  assert.match(parseConsolidationInput("nightlyAt", "4:30").error, /HH:MM/);
  assert.deepEqual(parseConsolidationInput("inboxThreshold", "12"), { value: 12 });
  assert.deepEqual(parseConsolidationInput("inboxThreshold", "  "), { value: null });
  assert.match(parseConsolidationInput("inboxThreshold", "1001").error, /between 1 and 1000/);
  assert.match(parseConsolidationInput("inboxThreshold", "2.5").error, /whole number/);
  assert.deepEqual(parseConsolidationInput("minIntervalMinutes", "90"), { value: 90 });
  assert.match(parseConsolidationInput("minIntervalMinutes", "").error, /minutes between 1 and 1440/);
  assert.match(parseConsolidationInput("minIntervalMinutes", "0").error, /minutes/);
});

const change = (action, id) => ({ action, entityId: "e1", entity: "repo acme/app", recordId: id, key: id, reason: null, before: null, after: null });

test("curation results are read defensively and their changes grouped in the contract's order", () => {
  const result = { digest: "d", line: "Memory curation promoted 1.", counts: {}, changes: [change("left", "m3"), change("promoted", "m1"), change("left", "m4")], refused: null, considered: {}, note: null };
  assert.equal(consolidationResult({ result }), result);
  assert.equal(consolidationResult({ result: null }), null);
  assert.equal(consolidationResult({ result: { id: "helper-result", log: [] } }), null);
  assert.deepEqual(groupChanges(result.changes).map((group) => [group.label, group.changes.map((entry) => entry.recordId)]), [
    ["Promoted", ["m1"]], ["Left for you", ["m3", "m4"]],
  ]);
  assert.deepEqual(groupChanges([]), []);
  assert.equal(curationRunLine({ status: "succeeded", summary: "x", error: null, result }), "Memory curation promoted 1.");
  assert.equal(curationRunLine({ status: "running", summary: "Curate memory", error: null, result: null }), "Curating…");
  assert.equal(curationRunLine({ status: "failed", summary: null, error: "boom", result: null }), "Failed: boom");
  assert.equal(curationRunLine({ status: "cancelled", summary: null, error: null, result: null }), "Stopped.");
});
