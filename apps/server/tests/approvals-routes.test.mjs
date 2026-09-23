import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fakeDeps, fakeSettings, fakeTimers, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const home = mkdtempSync(path.join(os.tmpdir(), "portal-approvals-routes-"));
process.env.PORTAL_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { buildApp } = await import("../src/app.ts");

test("routes: list pending, decide (running the call), list and revoke grants; every route is same-origin only", async (t) => {
  const database = await temporaryDatabase(t);
  const { deps, state } = fakeDeps({ sessions: [sessionMeta()] });
  const app = await buildApp({ database, orchestrator: { settingsStore: fakeSettings({ key: null }), deps, timers: fakeTimers() } });
  t.after(() => app.close());
  const inject = (method, url, payload, headers = {}) => app.inject({ method, url, payload, headers });

  assert.deepEqual((await inject("GET", "/api/portal/approvals")).json(), { approvals: [] });
  assert.equal((await inject("GET", "/api/portal/approvals?status=bogus")).statusCode, 400);

  // A card action the agent wrote asks first; the request is what the dialog lists.
  const { createPgOrchestratorStore } = await import("../src/orchestrator/pg-store.ts");
  const item = await createPgOrchestratorStore({ db: database.db }).createItem({
    list: "needs_you", kind: "custom", title: "Nudge", body: "", links: { sessionId: "s1" }, fingerprint: "custom:nudge",
    actions: [{ type: "send_prompt", sessionId: "s1", prompt: "Carry on with the tests" }],
  });
  const clicked = (await inject("POST", `/api/portal/items/${item.id}/actions/0`)).json();
  const listed = (await inject("GET", "/api/portal/approvals")).json().approvals;
  assert.deepEqual(listed.map((approval) => [approval.id, approval.tool, approval.origin, approval.status]), [[clicked.approvalId, "send_prompt", "card", "pending"]]);
  assert.match(listed[0].summary, /Carry on with the tests/);
  assert.equal((await inject("GET", "/api/portal")).json().status.counts.approvals, 1);

  const decideUrl = `/api/portal/approvals/${clicked.approvalId}/decide`;
  assert.equal((await inject("POST", decideUrl, ["yes"])).statusCode, 400);
  assert.equal((await inject("POST", decideUrl, { approve: "yes" })).statusCode, 400);
  assert.equal((await inject("POST", decideUrl, { approve: true, scope: "forever" })).statusCode, 400);
  const job = await inject("POST", decideUrl, { approve: true, scope: "job" });
  assert.equal(job.statusCode, 400);
  assert.match(job.json().error, /card action/);
  assert.equal((await inject("POST", "/api/portal/approvals/nope0000/decide", { approve: true })).statusCode, 404);

  const decided = await inject("POST", decideUrl, { approve: true, scope: "always" });
  assert.equal(decided.statusCode, 200);
  assert.equal(decided.json().approval.status, "approved");
  assert.deepEqual(decided.json().approval.decision, { approve: true, scope: "always" });
  assert.deepEqual(state.prompts, [{ id: "s1", text: "Carry on with the tests" }]);
  assert.equal((await inject("POST", decideUrl, { approve: true })).statusCode, 409);
  assert.deepEqual((await inject("GET", "/api/portal/approvals")).json(), { approvals: [] });
  assert.deepEqual((await inject("GET", "/api/portal/approvals?status=approved")).json().approvals.map((approval) => approval.id), [clicked.approvalId]);

  const grants = (await inject("GET", "/api/portal/approvals/grants")).json().grants;
  assert.deepEqual(grants.map((grant) => [grant.tool, grant.scope, grant.approvalId]), [["send_prompt", "always", clicked.approvalId]]);
  // The grant covers the next click: it runs at once.
  assert.deepEqual((await inject("POST", `/api/portal/items/${item.id}/actions/0`)).json(), {});
  assert.equal(state.prompts.length, 2);

  assert.equal((await inject("DELETE", `/api/portal/approvals/grants/${grants[0].id}`)).statusCode, 204);
  assert.equal((await inject("DELETE", "/api/portal/approvals/grants/nope0000")).statusCode, 404);
  assert.deepEqual((await inject("GET", "/api/portal/approvals/grants")).json(), { grants: [] });
  assert.ok((await inject("POST", `/api/portal/items/${item.id}/actions/0`)).json().approvalId, "revoked: the click asks again");

  const cross = { origin: "https://evil.example", host: "localhost" };
  for (const [method, url, payload] of [
    ["GET", "/api/portal/approvals"], ["POST", decideUrl, { approve: true }], ["GET", "/api/portal/approvals/grants"],
    ["DELETE", `/api/portal/approvals/grants/${grants[0].id}`],
  ]) {
    assert.equal((await inject(method, url, payload, cross)).statusCode, 403, `${method} ${url}`);
  }
});
