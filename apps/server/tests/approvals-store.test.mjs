import assert from "node:assert/strict";
import test from "node:test";
import { createPgApprovalStore } from "../src/orchestrator/approvals/pg-store.ts";
import { createMemoryApprovalStore, grantCovers } from "../src/orchestrator/approvals/store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const T0 = 1_700_000_000_000;

const request = (overrides = {}) => ({
  tool: "run_command", title: "Run git push", summary: "Run this:\n\n```sh\ngit push\n```", input: { cwd: "/repo", command: "git push" },
  risk: "outbound", origin: "chat", repo: "acme/app", threadId: "main", runId: "run1", jobId: null, intentId: null, itemId: null,
  requestedAt: T0, expiresAt: T0 + 60_000, ...overrides,
});

const grant = (overrides = {}) => ({ tool: "run_command", scope: "always", jobId: null, intentId: null, repo: null, approvalId: "a1", createdAt: T0, ...overrides });

function behaviour(label, open) {
  test(`${label}: create, get, and list by status and run, newest first`, async (t) => {
    const store = await open(t);
    const first = await store.create(request());
    const second = await store.create(request({ requestedAt: T0 + 1, runId: "run2", input: { text: "nul\u0000byte" } }));
    assert.match(first.id, /^[\w-]{8}$/);
    assert.deepEqual(first, {
      ...request(), id: first.id, status: "pending", decidedAt: null, decision: null, result: null, error: null,
    });
    assert.deepEqual(await store.get(first.id), first);
    assert.equal(await store.get("missing"), null);
    assert.deepEqual(second.input, { text: "nulbyte" }, "NUL bytes are stripped before writing");
    assert.deepEqual((await store.list()).map((row) => row.id), [second.id, first.id]);
    assert.deepEqual((await store.list({ status: ["pending"], runId: "run1" })).map((row) => row.id), [first.id]);
    assert.deepEqual(await store.list({ status: ["approved"] }), []);
    assert.deepEqual(await store.list({ status: [] }), []);
    assert.deepEqual((await store.list({ limit: 1 })).map((row) => row.id), [second.id]);
  });

  test(`${label}: a decision is recorded once, only while pending and unexpired`, async (t) => {
    const store = await open(t);
    const approval = await store.create(request());
    const decided = await store.decide(approval.id, { approve: true, scope: "repo" }, T0 + 10);
    assert.equal(decided.status, "approved");
    assert.equal(decided.decidedAt, T0 + 10);
    assert.deepEqual(decided.decision, { approve: true, scope: "repo" });
    assert.equal(await store.decide(approval.id, { approve: false, scope: "once" }, T0 + 11), null, "a second decision changes nothing");
    assert.equal((await store.get(approval.id)).status, "approved");
    assert.equal(await store.decide("missing", { approve: true, scope: "once" }, T0), null);

    const denied = await store.decide((await store.create(request())).id, { approve: false, scope: "once" }, T0 + 5);
    assert.equal(denied.status, "denied");

    const late = await store.create(request());
    assert.equal(await store.decide(late.id, { approve: true, scope: "once" }, T0 + 60_000), null, "an expired request cannot be approved");
  });

  test(`${label}: results are recorded, NUL-free; expiry marks only overdue pending requests`, async (t) => {
    const store = await open(t);
    const approval = await store.create(request());
    const recorded = await store.recordResult(approval.id, { result: { code: 0, stdout: "a\u0000b" }, error: null });
    assert.deepEqual(recorded.result, { code: 0, stdout: "ab" });
    const failed = await store.recordResult(approval.id, { result: { error: "boom" }, error: "boom" });
    assert.equal(failed.error, "boom");
    assert.equal(await store.recordResult("missing", { result: null, error: null }), null);

    const soon = await store.create(request({ expiresAt: T0 + 100 }));
    const later = await store.create(request({ expiresAt: T0 + 1000 }));
    const decided = await store.create(request({ expiresAt: T0 + 100 }));
    await store.decide(decided.id, { approve: false, scope: "once" }, T0 + 1);
    assert.deepEqual(await store.expire(T0 + 99), []);
    const expired = await store.expire(T0 + 100);
    assert.deepEqual(expired.map((row) => [row.id, row.status]), [[soon.id, "expired"]]);
    assert.equal((await store.get(later.id)).status, "pending");
    assert.equal((await store.get(decided.id)).status, "denied");
    assert.deepEqual(await store.expire(T0 + 100), [], "expiring twice finds nothing");
  });

  test(`${label}: grants are created, listed newest first, revoked once, and kept`, async (t) => {
    const store = await open(t);
    const always = await store.createGrant(grant());
    const repo = await store.createGrant(grant({ scope: "repo", repo: "acme/app", createdAt: T0 + 1 }));
    assert.deepEqual(always, { ...grant(), id: always.id, revokedAt: null });
    assert.deepEqual((await store.listGrants()).map((row) => row.id), [repo.id, always.id]);
    const revoked = await store.revokeGrant(always.id, T0 + 5);
    assert.equal(revoked.revokedAt, T0 + 5);
    assert.equal((await store.revokeGrant(always.id, T0 + 9)).revokedAt, T0 + 5, "revoking again keeps the first time");
    assert.equal(await store.revokeGrant("missing", T0), null);
    assert.deepEqual((await store.listGrants()).map((row) => row.id), [repo.id]);
    assert.deepEqual((await store.listGrants({ includeRevoked: true })).map((row) => row.id), [repo.id, always.id]);
  });

  test(`${label}: a grant matches by tool and scope: always, the same repo, the same job or intent`, async (t) => {
    const store = await open(t);
    const query = (overrides = {}) => ({ tool: "run_command", repo: null, jobId: null, intentId: null, ...overrides });
    assert.equal(await store.matchGrant(query()), null);

    const repo = await store.createGrant(grant({ scope: "repo", repo: "Acme/App" }));
    assert.equal((await store.matchGrant(query({ repo: "acme/app" })))?.id, repo.id, "repos compare case-insensitively");
    assert.equal(await store.matchGrant(query({ repo: "acme/other" })), null);
    assert.equal(await store.matchGrant(query()), null, "a repo grant needs a repo");
    assert.equal(await store.matchGrant(query({ tool: "delete_session", repo: "acme/app" })), null, "grants are per tool");

    const job = await store.createGrant(grant({ scope: "job", jobId: "j1", intentId: "i1", createdAt: T0 + 1 }));
    assert.equal((await store.matchGrant(query({ jobId: "j1" })))?.id, job.id);
    assert.equal((await store.matchGrant(query({ intentId: "i1" })))?.id, job.id, "the intent that asked is covered too");
    assert.equal(await store.matchGrant(query({ jobId: "j2" })), null);

    const always = await store.createGrant(grant({ tool: "delete_session", createdAt: T0 + 2 }));
    assert.equal((await store.matchGrant(query({ tool: "delete_session" })))?.id, always.id);
    assert.equal(await store.matchGrant(query({ jobId: "j1", scopes: ["always"] })), null, "scopes narrow what counts");
    assert.equal((await store.matchGrant(query({ tool: "delete_session", scopes: ["always"] })))?.id, always.id);

    await store.revokeGrant(always.id, T0 + 3);
    assert.equal(await store.matchGrant(query({ tool: "delete_session" })), null, "a revoked grant covers nothing");
  });
}

behaviour("memory approvals", async () => createMemoryApprovalStore());
behaviour("postgres approvals", async (t) => createPgApprovalStore({ db: (await temporaryDatabase(t)).db }));

test("grantCovers: an unknown scope covers nothing", () => {
  assert.equal(grantCovers({ ...grant(), id: "g", revokedAt: null, scope: "once" }, { tool: "run_command", repo: null, jobId: null, intentId: null }), false);
});
