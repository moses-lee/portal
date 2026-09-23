import assert from "node:assert/strict";
import test from "node:test";
import { consolidationFields, consolidationInput, parseConsolidationInput } from "../src/lib/orchestrator/curation.ts";

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
