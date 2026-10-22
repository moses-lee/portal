import assert from "node:assert/strict";
import { chmodSync, closeSync, constants, linkSync, mkdirSync, openSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { MAX_EDITABLE_BYTES, MAX_EXISTS_PATHS } from "@portal/contracts/files";
import { buildApp } from "../src/app.ts";
import { attachmentDisposition } from "../src/files/routes.ts";
import { displayName, sanitizeUploadName } from "../src/files/uploads.ts";
import { detectView, mimeTypeFor, servedType, sniffView, viewFromExtension } from "../src/files/view.ts";
import { MAX_PROMPT_IMAGE_BYTES, buildPrompt, promptBlocks } from "../src/lib/acp-runtime.ts";
import { PathError, resolveFilePath } from "../src/lib/fs-paths.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const EVIL = { origin: "http://evil.example" };

function scratchDir(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-files-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function rejects400(promise) {
  await assert.rejects(promise, (err) => err instanceof PathError && err.status === 400);
}

test("resolveFilePath: absolute, ~, file://, relative with and without cwd, symlinks, missing files", async (t) => {
  const root = scratchDir(t);
  mkdirSync(path.join(root, "real/sub"), { recursive: true });
  writeFileSync(path.join(root, "real/a.txt"), "a");
  symlinkSync(path.join(root, "real"), path.join(root, "link"));
  symlinkSync(path.join(root, "real/a.txt"), path.join(root, "a-link.txt"));

  assert.equal(await resolveFilePath(path.join(root, "real/a.txt")), path.join(root, "real/a.txt"));
  assert.equal(await resolveFilePath("~/x/../a.txt", null, root + "/real"), path.join(root, "real/a.txt"));
  assert.equal(await resolveFilePath("~", null, root), root);
  assert.equal(await resolveFilePath(pathToFileURL(path.join(root, "real/a.txt")).href), path.join(root, "real/a.txt"));
  assert.equal(await resolveFilePath(`file://${root}/real/with%20space.md`), path.join(root, "real/with space.md"));
  // Relative: against cwd, which may itself be ~/…; without one, a 400.
  assert.equal(await resolveFilePath("a.txt", path.join(root, "real")), path.join(root, "real/a.txt"));
  assert.equal(await resolveFilePath("./sub/../a.txt", "~/real", root), path.join(root, "real/a.txt"));
  await rejects400(resolveFilePath("a.txt"));
  await rejects400(resolveFilePath("a.txt", "relative/cwd"));
  await rejects400(resolveFilePath(""));
  await rejects400(resolveFilePath("/tmp/a\0b"));
  await rejects400(resolveFilePath("file:///tmp/a%00b"));
  await rejects400(resolveFilePath("file://remote-host/etc/passwd"));
  // Symlinks resolve to their targets, in the leaf and in a parent.
  assert.equal(await resolveFilePath(path.join(root, "a-link.txt")), path.join(root, "real/a.txt"));
  assert.equal(await resolveFilePath(path.join(root, "link/a.txt")), path.join(root, "real/a.txt"));
  // Missing: the nearest existing parent is realpathed and the rest joined back on.
  assert.equal(await resolveFilePath(path.join(root, "link/new/deeper.md")), path.join(root, "real/new/deeper.md"));
  assert.equal(await resolveFilePath("nope.txt", path.join(root, "link")), path.join(root, "real/nope.txt"));
});

test("view detection: extension tables first, a NUL sniff for the rest", async (t) => {
  assert.equal(viewFromExtension("/a/README.md"), "markdown");
  assert.equal(viewFromExtension("/a/x.MDX"), "markdown");
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]) assert.equal(viewFromExtension(`/a/x.${ext}`), "image", ext);
  assert.equal(viewFromExtension("/a/doc.pdf"), "pdf");
  for (const name of ["x.ts", "x.tsx", "x.py", "x.json", "x.yaml", "x.html", "x.css", "x.go", "x.rs", ".gitignore", "Dockerfile"]) {
    assert.equal(viewFromExtension(`/a/${name}`), "text", name);
  }
  assert.equal(viewFromExtension("/a/x.zip"), "binary");
  assert.equal(viewFromExtension("/a/LICENSE"), null);
  assert.equal(viewFromExtension("/a/x.weird"), null);
  assert.equal(sniffView(Buffer.from("hello\n")), "text");
  assert.equal(sniffView(Buffer.from([0x68, 0x00, 0x69])), "binary");
  assert.equal(sniffView(Buffer.alloc(0)), "text");

  const root = scratchDir(t);
  writeFileSync(path.join(root, "LICENSE"), "MIT\n");
  writeFileSync(path.join(root, "blob.weird"), Buffer.from([1, 2, 0, 3]));
  // A NUL past the first 8 KB is not looked at.
  writeFileSync(path.join(root, "late.weird"), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
  writeFileSync(path.join(root, "fake.png"), "not really");
  assert.equal(await detectView(path.join(root, "LICENSE")), "text");
  assert.equal(await detectView(path.join(root, "blob.weird")), "binary");
  assert.equal(await detectView(path.join(root, "late.weird")), "text");
  assert.equal(await detectView(path.join(root, "fake.png")), "image");

  assert.equal(mimeTypeFor("/a/x.png"), "image/png");
  assert.equal(mimeTypeFor("/a/x.md"), "text/markdown");
  assert.equal(mimeTypeFor("/a/LICENSE", "text"), "text/plain");
  assert.equal(mimeTypeFor("/a/blob", "binary"), "application/octet-stream");
  // Served types: nothing that runs script, sandboxed where a document could.
  assert.deepEqual(servedType("text/html", "text"), { contentType: "text/html; charset=utf-8", sandbox: true });
  assert.deepEqual(servedType("image/svg+xml", "image"), { contentType: "image/svg+xml", sandbox: true });
  assert.deepEqual(servedType("image/png", "image"), { contentType: "image/png", sandbox: false });
  assert.deepEqual(servedType("application/pdf", "pdf"), { contentType: "application/pdf", sandbox: false });
  assert.deepEqual(servedType("text/javascript", "text"), { contentType: "text/plain; charset=utf-8", sandbox: false });
  assert.deepEqual(servedType("application/zip", "binary"), { contentType: "application/octet-stream", sandbox: false });
});

test("upload names are sanitized to a safe stored name; the display name keeps the original", () => {
  assert.equal(sanitizeUploadName("Screen Shot 2026-10-22 at 9.41.03 AM.png"), "Screen_Shot_2026-10-22_at_9.41.03_AM.png");
  assert.equal(sanitizeUploadName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeUploadName("C:\\Users\\me\\report.pdf"), "report.pdf");
  assert.equal(sanitizeUploadName(".bashrc"), "bashrc");
  assert.equal(sanitizeUploadName("..."), "file");
  assert.equal(sanitizeUploadName("résumé.pdf"), "resume.pdf");
  assert.equal(sanitizeUploadName("照片.jpg"), "jpg");
  assert.equal(sanitizeUploadName(""), "file");
  const long = sanitizeUploadName(`${"a".repeat(300)}.jpeg`);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith(".jpeg"));
  assert.equal(displayName("a/b/photo\u0000.png"), "photo.png");
  assert.equal(displayName("照片.jpg"), "照片.jpg");
  assert.equal(attachmentDisposition("naïve \"x\".txt"), `attachment; filename="na_ve _x_.txt"; filename*=UTF-8''na%C3%AFve%20%22x%22.txt`);
});

test("promptBlocks: text, then images when the agent takes them, then a resource_link for every attachment", async (t) => {
  const png = { path: "/u/s/abcd1234-shot.png", name: "shot.png", mimeType: "image/png", size: 10 };
  const pdf = { path: "/u/s/beef0000-spec.pdf", name: "spec.pdf", mimeType: "application/pdf", size: 20 };
  const svg = { path: "/u/s/00000000-icon.svg", name: "icon.svg", mimeType: "image/svg+xml", size: 5 };
  const huge = { ...png, path: "/u/s/11111111-huge.png", size: MAX_PROMPT_IMAGE_BYTES + 1 };
  const link = (a) => ({ type: "resource_link", uri: `file://${a.path}`, name: a.name, mimeType: a.mimeType, size: a.size });
  const images = new Map([[png.path, "QUJD"], [huge.path, "QUJD"], [svg.path, "QUJD"]]);

  assert.deepEqual(promptBlocks("hi", [], {}), [{ type: "text", text: "hi" }]);
  // Whitespace-only text with files sends no text block (the Claude API refuses a blank one).
  assert.deepEqual(promptBlocks(" \n\t", [pdf], {}), [link(pdf)]);
  // No image capability: links only.
  assert.deepEqual(promptBlocks("look", [png, pdf], {}, images), [{ type: "text", text: "look" }, link(png), link(pdf)]);
  assert.deepEqual(promptBlocks("look", [png], { promptCapabilities: { image: false } }, images), [{ type: "text", text: "look" }, link(png)]);
  // Image capability: the image inline as well; empty text sends no text block.
  const caps = { promptCapabilities: { image: true } };
  assert.deepEqual(promptBlocks("", [pdf, png], caps, images), [{ type: "image", data: "QUJD", mimeType: "image/png" }, link(pdf), link(png)]);
  // SVG and oversized images, or ones that could not be read, go as links only.
  assert.deepEqual(promptBlocks("", [svg, huge], caps, images), [link(svg), link(huge)]);
  assert.deepEqual(promptBlocks("", [png], caps, new Map()), [link(png)]);
  // Paths that need escaping are escaped in the URI.
  assert.equal(promptBlocks("", [{ ...pdf, path: "/u/a b#c.pdf" }], {})[0].uri, "file:///u/a%20b%23c.pdf");

  const root = scratchDir(t);
  const file = path.join(root, "dot.png");
  writeFileSync(file, Buffer.from([1, 2, 3]));
  const real = { path: file, name: "dot.png", mimeType: "image/png", size: 3 };
  assert.deepEqual(await buildPrompt("x", [real], caps), [
    { type: "text", text: "x" }, { type: "image", data: "AQID", mimeType: "image/png" }, link(real),
  ]);
  assert.deepEqual(await buildPrompt("x", [{ ...real, path: path.join(root, "gone.png") }], caps), [
    { type: "text", text: "x" }, link({ ...real, path: path.join(root, "gone.png") }),
  ]);
});

async function filesApp(t) {
  const root = scratchDir(t);
  process.env.PORTAL_HOME = path.join(root, "home");
  const teardown = [];
  const database = await temporaryDatabase({ after: (fn) => teardown.push(fn) });
  const app = await buildApp({ database, orchestrator: false, singleInstance: false, lifecycle: { start: false }, searchBackfill: { start: false } });
  t.after(async () => {
    await app.close().catch(() => {});
    for (const fn of teardown) await fn();
  });
  return { app, root };
}

test("files routes: stat, raw, list, PUT with versions, exists", async (t) => {
  const { app, root } = await filesApp(t);
  const dir = path.join(root, "work");
  mkdirSync(path.join(dir, "zdir"), { recursive: true });
  mkdirSync(path.join(dir, "Adir"));
  writeFileSync(path.join(dir, "notes.md"), "# Notes\n");
  writeFileSync(path.join(dir, ".hidden"), "h");
  writeFileSync(path.join(dir, "b.html"), "<script>alert(1)</script>");
  writeFileSync(path.join(dir, "pic.svg"), "<svg/>");
  writeFileSync(path.join(dir, "data.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(dir, "run.sh"), "echo hi\n");
  chmodSync(path.join(dir, "run.sh"), 0o755);
  const get = (url, headers) => app.inject({ method: "GET", url, headers });
  const q = (p, extra = "") => `path=${encodeURIComponent(p)}${extra}`;

  // stat
  let res = await get(`/api/files/stat?${q("notes.md")}&cwd=${encodeURIComponent(dir)}`);
  assert.equal(res.statusCode, 200, res.body);
  const notes = res.json();
  const info = statSync(path.join(dir, "notes.md"));
  assert.deepEqual(notes, {
    path: path.join(dir, "notes.md"), kind: "file", size: 8, mtimeMs: info.mtimeMs, version: `${info.mtimeMs}-8`, mimeType: "text/markdown", view: "markdown",
  });
  assert.equal((await get(`/api/files/stat?${q(dir)}`)).json().kind, "dir");
  assert.equal((await get(`/api/files/stat?${q(dir)}`)).json().view, null);
  assert.equal((await get(`/api/files/stat?${q("data.bin", `&cwd=${encodeURIComponent(dir)}`)}`)).json().view, "binary");
  assert.equal((await get(`/api/files/stat?${q(path.join(dir, "missing.md"))}`)).statusCode, 404);
  assert.equal((await get(`/api/files/stat?${q("notes.md")}`)).statusCode, 400);
  assert.equal((await get("/api/files/stat")).statusCode, 400);

  // raw
  res = await get(`/api/files/raw?${q(path.join(dir, "notes.md"))}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "# Notes\n");
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers.etag, `"${notes.version}"`);
  assert.equal(res.headers["content-disposition"], undefined);
  assert.equal((await get(`/api/files/raw?${q(path.join(dir, "notes.md"))}`, { "if-none-match": `"${notes.version}"` })).statusCode, 304);
  res = await get(`/api/files/raw?${q(path.join(dir, "b.html"))}&download=1`);
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res.headers["content-security-policy"], "sandbox");
  assert.equal(res.headers["content-disposition"], `attachment; filename="b.html"; filename*=UTF-8''b.html`);
  res = await get(`/api/files/raw?${q(path.join(dir, "pic.svg"))}`);
  assert.equal(res.headers["content-type"], "image/svg+xml");
  assert.equal(res.headers["content-security-policy"], "sandbox");
  assert.equal((await get(`/api/files/raw?${q(path.join(dir, "data.bin"))}`)).headers["content-type"], "application/octet-stream");
  assert.equal((await get(`/api/files/raw?${q(dir)}`)).statusCode, 400);
  assert.equal((await get(`/api/files/raw?${q(path.join(dir, "nope"))}`)).statusCode, 404);

  // list: directories first, then by name, hidden files included
  res = await get(`/api/files/list?${q(dir)}`);
  assert.equal(res.statusCode, 200, res.body);
  const listing = res.json();
  assert.equal(listing.path, dir);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.entries.map((e) => [e.name, e.kind]), [
    ["Adir", "dir"], ["zdir", "dir"], [".hidden", "file"], ["b.html", "file"], ["data.bin", "file"], ["notes.md", "file"], ["pic.svg", "file"], ["run.sh", "file"],
  ]);
  assert.equal(listing.entries.find((e) => e.name === "notes.md").size, 8);
  assert.equal((await get(`/api/files/list?${q(path.join(dir, "notes.md"))}`)).statusCode, 400);
  assert.equal((await get(`/api/files/list?${q(path.join(dir, "gone"))}`)).statusCode, 404);

  // PUT: guarded by If-Match; create-only without it
  const put = (p, payload, headers = {}) => app.inject({ method: "PUT", url: `/api/files/raw?${q(p)}`, payload, headers: { "content-type": "text/plain", ...headers } });
  const script = path.join(dir, "run.sh");
  const scriptVersion = (await get(`/api/files/stat?${q(script)}`)).json().version;
  res = await put(script, "echo changed\n", { "if-match": scriptVersion });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(readFileSync(script, "utf8"), "echo changed\n");
  assert.equal(statSync(script).mode & 0o777, 0o755, "the file keeps its mode");
  const saved = res.json().version;
  assert.equal(saved, (await get(`/api/files/stat?${q(script)}`)).json().version);
  // The old version is now stale: 409 with the current one, nothing written.
  res = await put(script, "echo stale\n", { "if-match": scriptVersion });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().version, saved);
  assert.ok(res.json().error);
  assert.equal(readFileSync(script, "utf8"), "echo changed\n");
  // An entity tag form is accepted too.
  assert.equal((await put(script, "echo tagged\n", { "if-match": `"${saved}"` })).statusCode, 200);
  // Without If-Match: refuses an existing file, creates a new one (any content type).
  res = await put(script, "x");
  assert.equal(res.statusCode, 409);
  assert.equal(readFileSync(script, "utf8"), "echo tagged\n");
  res = await put(path.join(dir, "new.txt"), "fresh", { "content-type": "application/octet-stream" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(readFileSync(path.join(dir, "new.txt"), "utf8"), "fresh");
  res = await app.inject({ method: "PUT", url: `/api/files/raw?${q(path.join(dir, "bare.txt"))}`, payload: "no type", headers: { "content-type": undefined } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(readFileSync(path.join(dir, "bare.txt"), "utf8"), "no type");
  assert.equal((await put(path.join(dir, "no/such/dir.txt"), "x")).statusCode, 404);
  assert.equal((await put(dir, "x", { "if-match": "1-1" })).statusCode, 400);
  // A file deleted since it was opened: 409 with a null version.
  res = await put(path.join(dir, "vanished.txt"), "x", { "if-match": "1-1" });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().version, null);
  assert.equal((await put(path.join(dir, "big.txt"), "x".repeat(MAX_EDITABLE_BYTES + 1))).statusCode, 413);
  assert.equal((await put(path.join(dir, "evil.txt"), "x", EVIL)).statusCode, 403);
  // No temporary files are left behind.
  assert.deepEqual((await get(`/api/files/list?${q(dir)}`)).json().entries.filter((e) => e.name.includes("portal-")), []);

  // exists: inputs as given, resolved against cwd
  const exists = (payload, headers) => app.inject({ method: "POST", url: "/api/files/exists", payload, headers });
  res = await exists({ cwd: dir, paths: ["notes.md", "./zdir", path.join(dir, "b.html"), "missing.md", "", "a/b", `file://${dir}/run.sh`] });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { existing: ["notes.md", "./zdir", path.join(dir, "b.html"), `file://${dir}/run.sh`] });
  // Without a cwd, relative inputs simply do not exist.
  assert.deepEqual((await exists({ paths: ["notes.md", path.join(dir, "notes.md")] })).json(), { existing: [path.join(dir, "notes.md")] });
  assert.equal((await exists({ cwd: dir, paths: Array(MAX_EXISTS_PATHS + 1).fill("x") })).statusCode, 400);
  assert.equal((await exists({ cwd: dir, paths: "notes.md" })).statusCode, 400);
  assert.equal((await exists({ cwd: dir, paths: [] }, EVIL)).statusCode, 403);
});

test("files routes: a FIFO or device is reported without being opened, and raw and PUT refuse it", { timeout: 20_000 }, async (t) => {
  const { app, root } = await filesApp(t);
  const dir = path.join(root, "work");
  mkdirSync(dir);
  const fifo = path.join(dir, "pipe");
  execFileSync("mkfifo", [fifo]);
  // Were anything to open the FIFO for reading, a writer opening it unblocks that read, so the test cannot hang.
  t.after(() => {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {}
  });
  const get = (url) => app.inject({ method: "GET", url });
  const q = (p) => `path=${encodeURIComponent(p)}`;

  let res = await get(`/api/files/stat?${q(fifo)}`);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual({ ...res.json(), mtimeMs: 0, version: "" }, {
    path: fifo, kind: "file", size: 0, mtimeMs: 0, version: "", mimeType: "application/octet-stream", view: "binary",
  });
  assert.equal(await detectView(fifo), "binary");
  res = await get(`/api/files/raw?${q(fifo)}`);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /Not a regular file/);
  const version = (await get(`/api/files/stat?${q(fifo)}`)).json().version;
  res = await app.inject({ method: "PUT", url: `/api/files/raw?${q(fifo)}`, payload: "x", headers: { "content-type": "text/plain", "if-match": version } });
  assert.equal(res.statusCode, 400);
  res = await get(`/api/files/list?${q(dir)}`);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().entries.map((e) => [e.name, e.kind]), [["pipe", "file"]]);
  // A character device is not streamed either.
  assert.equal((await get(`/api/files/stat?${q("/dev/zero")}`)).json().view, "binary");
  assert.equal((await get(`/api/files/raw?${q("/dev/zero")}`)).statusCode, 400);
});

test("files routes: PUT keeps hard links and works in a folder it cannot create files in", async (t) => {
  const { app, root } = await filesApp(t);
  const dir = path.join(root, "work");
  mkdirSync(dir);
  const q = (p) => `path=${encodeURIComponent(p)}`;
  const versionOf = async (p) => (await app.inject({ method: "GET", url: `/api/files/stat?${q(p)}` })).json().version;
  const put = (p, payload, version) =>
    app.inject({ method: "PUT", url: `/api/files/raw?${q(p)}`, payload, headers: { "content-type": "text/plain", "if-match": version } });

  // A hard link: written in place, so the other name sees the change and the inode stays.
  const file = path.join(dir, "a.txt");
  const other = path.join(dir, "b.txt");
  writeFileSync(file, "a much longer original body\n");
  linkSync(file, other);
  const inode = statSync(file).ino;
  let res = await put(file, "short\n", await versionOf(file));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(readFileSync(file, "utf8"), "short\n", "truncated to the new body");
  assert.equal(readFileSync(other, "utf8"), "short\n");
  assert.equal(statSync(file).ino, inode);
  assert.equal(res.json().version, await versionOf(file));
  // A stale version is still refused in place.
  res = await put(file, "stale\n", "1-1");
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().version, await versionOf(file));
  assert.equal(readFileSync(other, "utf8"), "short\n");

  // A file Portal may write in a folder it may not create files in (root ignores the mode, so skip there).
  if (process.getuid?.() !== 0) {
    const locked = path.join(root, "locked");
    mkdirSync(locked);
    const inside = path.join(locked, "c.txt");
    writeFileSync(inside, "before\n");
    chmodSync(locked, 0o555);
    try {
      res = await put(inside, "after\n", await versionOf(inside));
    } finally {
      chmodSync(locked, 0o755); // before the scratch folder is removed
    }
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(readFileSync(inside, "utf8"), "after\n");
  }
  // The usual save still replaces the file (a new inode), and leaves no temporary file.
  const single = path.join(dir, "single.txt");
  writeFileSync(single, "one\n");
  const before = statSync(single).ino;
  assert.equal((await put(single, "two\n", await versionOf(single))).statusCode, 200);
  assert.equal(readFileSync(single, "utf8"), "two\n");
  assert.notEqual(statSync(single).ino, before);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes("portal-")), []);
});
