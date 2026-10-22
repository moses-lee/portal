import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES } from "@portal/contracts/files";
import { appContext, buildApp } from "../src/app.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const EVIL = { origin: "http://evil.example" };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function until(predicate, description) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(20);
  }
}

/** An app whose sessions run the fake ACP agent, over a throwaway database, with its Portal home in a scratch folder. */
async function setup(t, sessionOptions = {}) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-uploads-")));
  const home = path.join(scratch, "home");
  process.env.PORTAL_HOME = home;
  const logPath = path.join(scratch, "agent.jsonl");
  const configPath = path.join(scratch, "config.json");
  writeFileSync(logPath, "");
  writeFileSync(configPath, JSON.stringify({}));
  const agents = [{ id: "claude", name: "Claude Code", command: process.execPath, args: [fixturePath, "claude", logPath, configPath], authHint: "" }];
  const teardown = [];
  const database = await temporaryDatabase({ after: (fn) => teardown.push(fn) });
  await database.sql`insert into projects (id, name, path, created_at) values ('proj-1', 'Repo', ${scratch}, 1)`;
  const app = await buildApp({
    database, orchestrator: false, singleInstance: false, lifecycle: { start: false }, searchBackfill: { start: false },
    sessions: { agents, initializeTimeoutMs: 2_000, ...sessionOptions },
  });
  t.after(async () => {
    await app.close().catch(() => {});
    for (const fn of teardown) await fn();
    rmSync(scratch, { recursive: true, force: true });
  });
  const prompts = () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    .filter((entry) => entry.message?.method === "session/prompt").map((entry) => entry.message.params.prompt);
  const createSession = async () => {
    const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { projectId: "proj-1" } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const upload = (id, name, body, headers = { "content-type": "application/octet-stream" }) =>
    app.inject({ method: "POST", url: `/api/sessions/${id}/uploads?name=${encodeURIComponent(name)}`, payload: body, headers });
  const events = async (id) => (await app.inject({ method: "GET", url: `/api/sessions/${id}/events` })).json().events;
  return { app, scratch, home, sql: database.sql, prompts, createSession, upload, events };
}

test("uploads: stored under uploads/<id>/ with a safe name, typed from the extension, 413 over the cap", async (t) => {
  const { app, home, createSession, upload } = await setup(t);
  const session = await createSession();
  const dir = path.join(realpathSync(home), "uploads", session.id);

  let res = await upload(session.id, "Screen Shot 1.png", PNG);
  assert.equal(res.statusCode, 200, res.body);
  const { attachment } = res.json();
  assert.equal(path.dirname(attachment.path), dir);
  assert.match(path.basename(attachment.path), /^[0-9a-f]{8}-Screen_Shot_1\.png$/);
  assert.deepEqual({ ...attachment, path: undefined }, { path: undefined, name: "Screen Shot 1.png", mimeType: "image/png", size: PNG.length });
  assert.deepEqual(readFileSync(attachment.path), PNG);

  // A specific content type wins over the extension; octet-stream or none falls back to it.
  res = await upload(session.id, "photo", PNG, { "content-type": "image/jpeg" });
  assert.equal(res.json().attachment.mimeType, "image/jpeg");
  res = await upload(session.id, "IMG_0001.JPG", PNG, {});
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().attachment.mimeType, "image/jpeg");
  res = await upload(session.id, "notes.json", Buffer.from("{}"), { "content-type": "application/json" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().attachment.mimeType, "application/json");
  assert.equal(readFileSync(res.json().attachment.path, "utf8"), "{}");
  // A name that tries to leave the directory stays in it.
  res = await upload(session.id, "../../../etc/passwd", Buffer.from("x"));
  assert.equal(path.dirname(res.json().attachment.path), dir);
  assert.equal(res.json().attachment.name, "passwd");

  assert.equal((await upload("no-such-session", "a.png", PNG)).statusCode, 404);
  assert.equal((await upload(session.id, "", PNG)).statusCode, 400);
  assert.equal((await upload(session.id, "a.png", PNG, { "content-type": "image/png", ...EVIL })).statusCode, 403);
  res = await upload(session.id, "big.bin", Buffer.alloc(MAX_UPLOAD_BYTES + 1));
  assert.equal(res.statusCode, 413);
  assert.ok(res.json().error);
  // JSON routes elsewhere still parse JSON.
  assert.equal((await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: "Renamed" } })).statusCode, 200);
});

test("prompts carry attachments to the agent, the log, the queue and search; foreign paths are refused; delete removes the uploads", async (t) => {
  const { app, scratch, home, sql, prompts, createSession, upload, events } = await setup(t);
  const session = await createSession();
  const post = (id, payload, headers) => app.inject({ method: "POST", url: `/api/sessions/${id}/prompt`, payload, headers });
  const png = (await upload(session.id, "shot.png", PNG)).json().attachment;
  const pdf = (await upload(session.id, "spec sheet.pdf", Buffer.from("%PDF-1.4"))).json().attachment;
  const link = (a) => ({ type: "resource_link", uri: pathToFileURL(a.path).href, name: a.name, mimeType: a.mimeType, size: a.size });

  // Refusals: from outside the uploads, another session's, too many, nothing at all, not an array.
  const outside = path.join(scratch, "outside.png");
  writeFileSync(outside, PNG);
  assert.equal((await post(session.id, { text: "x", attachments: [{ ...png, path: outside }] })).statusCode, 400);
  assert.equal((await post(session.id, { text: "x", attachments: [{ ...png, path: path.join(path.dirname(png.path), "..", path.basename(png.path)) }] })).statusCode, 400);
  assert.equal((await post(session.id, { text: "x", attachments: [{ ...png, path: path.join(path.dirname(png.path), "missing.png") }] })).statusCode, 400);
  assert.equal((await post(session.id, { text: "x", attachments: Array(MAX_ATTACHMENTS + 1).fill(png) })).statusCode, 400);
  assert.equal((await post(session.id, { text: "  ", attachments: [] })).statusCode, 400);
  assert.equal((await post(session.id, { text: "x", attachments: png })).statusCode, 400);
  const other = await createSession();
  assert.equal((await post(other.id, { text: "x", attachments: [png] })).statusCode, 400);
  assert.equal(prompts().length, 0);

  // Text and attachments: the agent (no image capability) gets the text and a link per file.
  let res = await post(session.id, { text: "finish-tool", attachments: [png, pdf] });
  assert.equal(res.statusCode, 202, res.body);
  await until(async () => (await events(session.id)).at(-1)?.type === "turn_end", "turn end");
  assert.deepEqual(prompts().at(-1), [{ type: "text", text: "finish-tool" }, link(png), link(pdf)]);
  const user = (await events(session.id)).find((event) => event.type === "user");
  assert.deepEqual(user.attachments, [png, pdf]);
  // Search indexes the names with the text, live and from the backfill.
  const indexed = async () => (await sql`select text from session_messages where session_id = ${session.id} and role = 'user'`).map((row) => row.text);
  await until(async () => (await indexed()).length === 1, "the prompt indexed");
  assert.deepEqual(await indexed(), ["finish-tool\nshot.png\nspec sheet.pdf"]);
  await sql`delete from session_messages where session_id = ${session.id}`;
  await appContext(app).searchBackfill.run();
  assert.deepEqual(await indexed(), ["finish-tool\nshot.png\nspec sheet.pdf"]);

  // The queue keeps attachments; an edit may drop some but not add any.
  assert.equal((await post(session.id, { text: "tool" })).statusCode, 202);
  res = await post(session.id, { text: "", attachments: [png, pdf], queue: true });
  assert.equal(res.statusCode, 202, res.body);
  const queued = res.json().queued;
  assert.deepEqual(queued.attachments, [png, pdf]);
  assert.equal(queued.text, "");
  const patch = (payload) => app.inject({ method: "PATCH", url: `/api/sessions/${session.id}/queue/${queued.id}`, payload });
  assert.equal((await patch({ text: "", attachments: [{ path: outside }] })).statusCode, 400);
  assert.equal((await patch({ text: "", attachments: [] })).statusCode, 400);
  assert.equal((await patch({ text: "", attachments: "nope" })).statusCode, 400);
  res = await patch({ text: "", attachments: [{ path: pdf.path }] });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().item.attachments, [pdf]);
  res = await patch({ text: "now with words" });
  assert.deepEqual(res.json().item.attachments, [pdf], "no attachments field keeps them");
  res = await patch({ text: "words only", attachments: [] });
  assert.equal(res.json().item.attachments, undefined);
  const cancelled = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/cancel` });
  assert.equal(cancelled.json().queued.length, 1);
  await until(async () => (await events(session.id)).at(-1)?.type === "turn_end", "cancelled turn end");

  // Files only: no text block, and the session is named after the first file.
  const third = await createSession();
  const doc = (await upload(third.id, "design.md", Buffer.from("# Design"))).json().attachment;
  const sent = prompts().length;
  res = await post(third.id, { text: "", attachments: [doc] });
  assert.equal(res.statusCode, 202, res.body);
  await until(() => prompts().length > sent, "the prompt to reach the agent");
  assert.deepEqual(prompts().at(-1), [link(doc)]);
  assert.equal((await app.inject({ method: "GET", url: `/api/sessions/${third.id}` })).json().title, "design.md");
  assert.deepEqual((await events(third.id)).find((event) => event.type === "user"), { type: "user", text: "", attachments: [doc], seq: 0, ts: (await events(third.id))[0].ts });

  // Whitespace-only text with files is no text at all: no blank text block, and the log says "".
  const fourth = await createSession();
  const sketch = (await upload(fourth.id, "sketch.txt", Buffer.from("s"))).json().attachment;
  const before = prompts().length;
  res = await post(fourth.id, { text: " \n\t ", attachments: [sketch] });
  assert.equal(res.statusCode, 202, res.body);
  await until(() => prompts().length > before, "the blank prompt to reach the agent");
  assert.deepEqual(prompts().at(-1), [link(sketch)]);
  assert.equal((await events(fourth.id)).find((event) => event.type === "user").text, "");

  // Deleting a session removes its uploads, and only its.
  const uploads = path.join(realpathSync(home), "uploads");
  assert.ok(existsSync(path.join(uploads, session.id)));
  assert.equal((await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` })).statusCode, 204);
  assert.equal(existsSync(path.join(uploads, session.id)), false);
  assert.ok(existsSync(doc.path));
  // A session that never uploaded deletes fine.
  assert.equal((await app.inject({ method: "DELETE", url: `/api/sessions/${other.id}` })).statusCode, 204);
});

test("with uploads off, a prompt with attachments is a 400 and one without still sends", async (t) => {
  const { app, prompts, createSession } = await setup(t, { uploadsDir: null });
  const session = await createSession();
  const post = (payload) => app.inject({ method: "POST", url: `/api/sessions/${session.id}/prompt`, payload });
  const attachment = { path: "uploads/x/abcd1234-a.png", name: "a.png", mimeType: "image/png", size: 1 };
  for (const attachments of [[attachment], [{ ...attachment, path: "relative.png" }], "nope"]) {
    const res = await post({ text: "x", attachments });
    assert.equal(res.statusCode, 400, res.body);
  }
  assert.equal(prompts().length, 0);
  assert.equal((await post({ text: "hello", attachments: [] })).statusCode, 202);
  await until(() => prompts().length === 1, "the prompt to reach the agent");
  assert.deepEqual(prompts()[0], [{ type: "text", text: "hello" }]);
});
