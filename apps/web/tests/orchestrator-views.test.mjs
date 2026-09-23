import assert from "node:assert/strict";
import test from "node:test";
import { activityFilters, activityLinks, describeKind, matchesPrefix, mergeActivity } from "../src/lib/orchestrator/activity.ts";
import { canPin, groupEntities, lineage, partitionRecords } from "../src/lib/orchestrator/memory.ts";
import { portalLocation, portalPath, isPortalPath } from "../src/lib/session-routes.ts";

const entry = (id, kind = "chat.turn") => ({ id, at: id, actor: "agent", kind, summary: `e${id}`, refs: {}, detail: null });

test("activity filters are prefixes and merging dedupes newest first", () => {
  assert.equal(activityFilters[0].prefix, null);
  assert.ok(activityFilters.slice(1).every((filter) => filter.prefix.endsWith(".")));
  assert.equal(matchesPrefix(entry(1, "memory.approved"), "memory."), true);
  assert.equal(matchesPrefix(entry(1, "memory.approved"), "item."), false);
  assert.equal(matchesPrefix(entry(1, "memory.approved"), null), true);
  const page = [entry(5), entry(4)];
  assert.equal(mergeActivity(page, [entry(4)]), page);
  assert.deepEqual(mergeActivity(page, [entry(6), entry(5)]).map((e) => e.id), [6, 5, 4]);
  assert.deepEqual(mergeActivity(page, [entry(2), entry(3)]).map((e) => e.id), [5, 4, 3, 2]);
  assert.equal(describeKind("memory.approved"), "Memory approved");
  assert.equal(describeKind("tool.call"), "Tool call");
});

test("activity links come out most useful first", () => {
  const pull = { repo: "o/r", number: 4, url: "https://github.com/o/r/pull/4" };
  assert.deepEqual(
    activityLinks({ threadId: "t1", pull, sessionId: "s1", projectId: "p1", itemId: "i1", recordId: "r1", entityId: "e1" }).map((l) => l.type),
    ["thread", "pull", "session", "item", "record"],
  );
  assert.deepEqual(activityLinks({ entityId: "e1", projectId: "p1" }), [
    { type: "entity", id: "e1" },
    { type: "project", id: "p1" },
  ]);
  assert.deepEqual(activityLinks({ recordId: "r1", entityId: "e1" }), [{ type: "record", id: "r1", entityId: "e1" }]);
});

const entity = (id, type, name, activeRecords = 1) => ({ id, type, key: name, name, summary: "", activeRecords, createdAt: 0, updatedAt: 0 });

test("entities group by type in the contract's order with record counts", () => {
  const groups = groupEntities([
    entity("e1", "repo", "zeta/app", 2),
    entity("e2", "global", "global", 4),
    entity("e3", "repo", "acme/web", 3),
    entity("e4", "person", "octocat", 0),
  ]);
  assert.deepEqual(groups.map((g) => [g.type, g.label, g.records, g.entities.map((e) => e.id)]), [
    ["global", "Global", 4, ["e2"]],
    ["person", "People", 0, ["e4"]],
    ["repo", "Repositories", 5, ["e3", "e1"]],
  ]);
});

const record = (id, extra = {}) => ({
  id, entityId: "e1", type: "fact", key: id, body: id, status: "active", scope: {}, authority: "observed",
  source: { kind: "ui" }, trust: 0.5, pinned: false, reviewBy: null, supersedes: null, supersededBy: null,
  createdAt: 0, updatedAt: 0, ...extra,
});

test("records split into active, inbox, and history", () => {
  const parts = partitionRecords([
    record("b"),
    record("a"),
    record("pinned", { pinned: true }),
    record("p1", { status: "proposed", createdAt: 1 }),
    record("p2", { status: "proposed", createdAt: 2 }),
    record("old", { status: "superseded", updatedAt: 1 }),
    record("gone", { status: "archived", updatedAt: 2 }),
  ]);
  assert.deepEqual(parts.active.map((r) => r.id), ["pinned", "a", "b"]);
  assert.deepEqual(parts.proposed.map((r) => r.id), ["p2", "p1"]);
  assert.deepEqual(parts.history.map((r) => r.id), ["gone", "old"]);
});

test("lineage walks both ways and survives a cycle", () => {
  const v1 = record("v1", { status: "superseded", supersededBy: "v2" });
  const v2 = record("v2", { status: "superseded", supersedes: "v1", supersededBy: "v3" });
  const v3 = record("v3", { supersedes: "v2" });
  const byId = new Map([v1, v2, v3].map((r) => [r.id, r]));
  assert.deepEqual(lineage(v2, byId).map((r) => r.id), ["v1", "v2", "v3"]);
  assert.deepEqual(lineage(v3, byId).map((r) => r.id), ["v1", "v2", "v3"]);
  const a = record("a", { supersedes: "b", supersededBy: "b" });
  const b = record("b", { supersedes: "a", supersededBy: "a" });
  assert.deepEqual(lineage(a, new Map([["a", a], ["b", b]])).map((r) => r.id), ["b", "a"]);
  assert.equal(canPin({ authority: "user_stated" }), true);
  assert.equal(canPin({ authority: "observed" }), false);
});

test("portal paths round-trip every view", () => {
  assert.equal(isPortalPath("/portal"), true);
  assert.equal(isPortalPath("/portal/memory/e1"), true);
  assert.equal(isPortalPath("/portals"), false);
  assert.deepEqual(portalLocation("/portal"), { view: "chat", threadId: "main" });
  assert.deepEqual(portalLocation("/portal/threads/t%201"), { view: "chat", threadId: "t 1" });
  assert.deepEqual(portalLocation("/portal/goals"), { view: "goals" });
  assert.deepEqual(portalLocation("/portal/memory"), { view: "memory", entityId: null });
  assert.deepEqual(portalLocation("/portal/memory/e1"), { view: "memory", entityId: "e1" });
  assert.deepEqual(portalLocation("/portal/memory/curation"), { view: "memory", entityId: null, runId: null });
  assert.deepEqual(portalLocation("/portal/memory/curation/r%201"), { view: "memory", entityId: null, runId: "r 1" });
  assert.equal(portalPath({ view: "memory", entityId: null, runId: "r 1" }), "/portal/memory/curation/r%201");
  assert.equal(portalPath({ view: "memory", entityId: null, runId: null }), "/portal/memory/curation");
  assert.equal(portalPath({ view: "memory", entityId: "e1" }), "/portal/memory/e1");
  assert.deepEqual(portalLocation("/portal/nope/deeper"), { view: "chat", threadId: "main" });
  assert.equal(portalPath(), "/portal");
  assert.equal(portalPath("activity"), "/portal/activity");
  assert.equal(portalPath({ view: "chat", threadId: "t 1" }), "/portal/threads/t%201");
  assert.equal(portalPath({ view: "chat", threadId: "main" }), "/portal");
  assert.equal(portalPath({ view: "memory", entityId: "e/1" }), "/portal/memory/e%2F1");
});
