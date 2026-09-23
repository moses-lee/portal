import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BODY_CHARS, MAX_PROCEDURE_CHARS, canPin, findSecret, normalizeEntityKey, validateRecord,
} from "../src/orchestrator/memory/validate.ts";

const base = (overrides = {}) => ({
  entity: { type: "repo", key: "Acme/App" }, type: "convention", key: "Conventions.Tests", body: "  Tests use node:test and live in tests/.  ",
  authority: "user_stated", source: { kind: "message", quote: "tests use node:test" }, ...overrides,
});

const rejects = (input, pattern, options) => assert.throws(() => validateRecord(input, options), (err) => err.status === 400 && pattern.test(err.message));

test("a valid record is normalized: entity and record keys lowercased, body trimmed, trust by authority", () => {
  const valid = validateRecord(base());
  assert.deepEqual(valid.entity, { type: "repo", key: "acme/app" });
  assert.equal(valid.key, "conventions.tests");
  assert.equal(valid.body, "Tests use node:test and live in tests/.");
  assert.equal(valid.trust, 1);
  assert.equal(valid.pinned, false);
  assert.deepEqual(valid.scope, { projectIds: [], sessionIds: [], pulls: [], repos: [], people: [], taskTypes: [] });
  assert.equal(validateRecord(base({ authority: "observed", source: { kind: "pull", quote: "x" } })).trust, 0.6);
  assert.equal(validateRecord(base({ authority: "inferred", source: { kind: "session", quote: "x" } })).trust, 0.4);
  assert.equal(validateRecord(base({ authority: "user_confirmed", source: { kind: "pull", quote: "x" } })).trust, 0.9);
});

test("entity keys follow their type", () => {
  assert.equal(normalizeEntityKey("global", "anything"), "global");
  assert.equal(normalizeEntityKey("person", "@OctoCat"), "octocat");
  assert.equal(normalizeEntityKey("repo", "https://github.com/Acme/App.git"), "acme/app");
  assert.equal(normalizeEntityKey("task_type", "Code Review"), "code-review");
  assert.equal(normalizeEntityKey("project", "p1"), "p1");
  assert.throws(() => normalizeEntityKey("repo", "acme"), /owner\/name/);
  assert.throws(() => normalizeEntityKey("person", "not a login"), /GitHub login/);
  assert.throws(() => normalizeEntityKey("session", "has space"), /session id/);
  assert.throws(() => normalizeEntityKey("planet", "x"), /Unknown entity type/);
});

test("keys are slugs; types and authorities are known", () => {
  rejects(base({ key: "has spaces" }), /not a record key/);
  rejects(base({ key: "x".repeat(81) }), /not a record key/);
  rejects(base({ key: "-leading" }), /not a record key/);
  rejects(base({ type: "opinion" }), /Unknown record type/);
  rejects(base({ authority: "hearsay" }), /Unknown authority/);
  rejects(base({ source: { kind: "rumour" } }), /Unknown source kind/);
});

test("one claim per record: length, lines, headings, and lists are limited; procedures may list steps", () => {
  rejects(base({ body: "   " }), /needs a body/);
  rejects(base({ body: "x".repeat(MAX_BODY_CHARS + 1) }), /Split it/);
  rejects(base({ body: "a\nb\nc\nd\ne" }), /lines/);
  rejects(base({ body: "## Heading\nthen text" }), /no headings/);
  rejects(base({ body: "- use pnpm\n- use node 24" }), /several claims/);
  const steps = "1. Check out the branch.\n2. Run the tests.\n3. Read the migrations first.";
  assert.equal(validateRecord(base({ type: "procedure", key: "review", body: steps })).body, steps);
  rejects(base({ type: "procedure", body: "x".repeat(MAX_PROCEDURE_CHARS + 1) }), /Split it/);
});

test("scope has the Scope shape", () => {
  const valid = validateRecord(base({ scope: { repos: ["Acme/Web"], people: ["@Octo"], taskTypes: ["code-review"] } }));
  assert.deepEqual(valid.scope.repos, ["acme/web"]);
  assert.deepEqual(valid.scope.people, ["octo"]);
  rejects(base({ scope: { repos: ["nope"] } }), /scope.repos/);
  rejects(base({ scope: { people: [3] } }), /scope.people/);
  rejects(base({ scope: { pulls: [{ repo: "acme/app" }] } }), /scope.pulls/);
  rejects(base({ scope: [] }), /scope must be/);
});

test("secrets are refused wherever they sit: known formats, key-like context, and the stored API keys", () => {
  const cases = [
    "The key is sk-ant-api03-abcdefghijklmnop",
    "Use sk-proj-abcdefghijklmnopqrstuvwx for OpenAI.",
    "Token ghp_abcdefghijklmnopqrstuvwxyz0123 works.",
    "PAT github_pat_11ABCDEFG0123456789_abcdefghij",
    "AWS AKIAIOSFODNN7EXAMPLE",
    "Slack xoxb-1234567890-abcdefghij",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "password: Zx8vQ2mN7pL4kR9tY3wB6cH1",
  ];
  for (const text of cases) assert.ok(findSecret(text), text);
  assert.equal(findSecret("Prefers conventional-commit-style-messages-always"), null);
  assert.equal(findSecret("Commit 3f2a9c1e7b4d8a6f0e5c2b1a9d8e7f6a5b4c3d2e is the base"), null, "a hash without a key word is not a secret");
  assert.equal(findSecret("The token budget is 1500 per turn"), null);
  assert.equal(findSecret("Worktrees live in /Users/me/repos/portal-ov2-memory"), null);
  assert.ok(findSecret("my custom key zzzsecretvalue123", ["zzzsecretvalue123"]));

  rejects(base({ body: "Deploy with token ghp_abcdefghijklmnopqrstuvwxyz0123" }), /never stores secrets/);
  rejects(base({ source: { kind: "message", quote: "sk-ant-api03-abcdefghijklmnop" } }), /never stores secrets/);
  rejects(base({ body: "The key is plainwords123XYZ" }), /never stores secrets/, { knownSecrets: ["plainwords123XYZ"] });
});

test("authority follows the source: content is never user-stated, only the user's claims pin, content never pins", () => {
  for (const kind of ["pull", "session", "tool", "import", "consolidator"]) {
    rejects(base({ source: { kind, quote: "x" } }), /not the user's own statement/);
  }
  assert.equal(validateRecord(base({ source: { kind: "ui" } })).authority, "user_stated");
  assert.equal(validateRecord(base({ pinned: true })).pinned, true);
  rejects(base({ authority: "observed", source: { kind: "message", quote: "x" }, pinned: true }), /Only claims the user stated or confirmed/);
  rejects(base({ authority: "inferred", source: { kind: "message", quote: "x" }, pinned: true }), /Only claims the user stated or confirmed/);
  rejects(base({ authority: "user_confirmed", source: { kind: "pull", quote: "x" }, pinned: true }), /never a pinned directive/);
  assert.equal(validateRecord(base({ authority: "user_confirmed", source: { kind: "import", quote: "x" }, pinned: true })).pinned, true);
  assert.equal(canPin("user_confirmed", { kind: "session" }), false);
  assert.equal(canPin("user_confirmed", { kind: "import" }), true);
  assert.equal(canPin("observed", { kind: "message" }), false);
});
