import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES } from "@portal/contracts/files";
import {
  acceptFiles,
  addAttachments,
  clearEditRemovals,
  editKey,
  formatBytes,
  moveAttachments,
  needsResize,
  readAttachments,
  readEditRemovals,
  removeFromEdit,
  restoreAttachments,
  uploadAttachments,
} from "../src/lib/attachments.ts";

const file = (name, size) => ({ name, size });
const stored = (name) => ({ path: `/home/me/.portal/uploads/s1/x-${name}`, name, mimeType: "image/png", size: 10 });

test("files over the size limit or past the count limit are left out, with a notice", () => {
  assert.deepEqual(acceptFiles(0, [file("a", 1), file("b", 2)]), { accepted: [file("a", 1), file("b", 2)], notice: null });
  const big = acceptFiles(0, [file("huge.mov", MAX_UPLOAD_BYTES + 1), file("ok.txt", 5)]);
  assert.deepEqual(big.accepted, [file("ok.txt", 5)]);
  assert.match(big.notice, /huge\.mov is over the 25 MB limit/);
  const many = acceptFiles(MAX_ATTACHMENTS - 1, [file("a", 1), file("b", 1)]);
  assert.deepEqual(many.accepted, [file("a", 1)]);
  assert.match(many.notice, /at most 10 files/);
  assert.deepEqual(acceptFiles(MAX_ATTACHMENTS, [file("a", 1)]).accepted, []);
});

test("an image is re-encoded when over 3.75 MB (5 MB as base64) or longer than 2576 px on an edge", () => {
  assert.equal(needsResize(1024, 2576, 1000), false);
  assert.equal(needsResize(1024, 1000, 2577), true);
  assert.equal(needsResize(3_932_160, 100, 100), false);
  assert.equal(needsResize(3_932_161, 100, 100), true);
});

test("sizes read in B, KB and MB", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(3.5 * 1024 * 1024), "3.5 MB");
  assert.equal(formatBytes(25 * 1024 * 1024), "25 MB");
});

test("a stopped prompt's attachments come back once each, and move with the start page's hand-over", () => {
  restoreAttachments("start", [stored("a.png"), stored("b.png")]);
  restoreAttachments("start", [stored("a.png")]);
  assert.deepEqual(readAttachments("start").map((item) => [item.name, item.status, item.uploaded.path]), [
    ["a.png", "uploaded", stored("a.png").path],
    ["b.png", "uploaded", stored("b.png").path],
  ]);
  moveAttachments("start", "s1");
  assert.equal(readAttachments("start").length, 0);
  assert.equal(readAttachments("s1").length, 2);
});

test("removals from a queued prompt being edited are kept per prompt until cleared", () => {
  const key = editKey("s1", "q1");
  removeFromEdit(key, "/p/a");
  assert.deepEqual(readEditRemovals(key), ["/p/a"]);
  assert.deepEqual(readEditRemovals(editKey("s1", "q2")), []);
  clearEditRemovals(key);
  assert.deepEqual(readEditRemovals(key), []);
});

test("two sends of the same composer at once upload each file once", async () => {
  const opened = [];
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    upload = {};
    status = 200;
    responseText = "";
    open(method, url) {
      opened.push(url);
    }
    setRequestHeader() {}
    send() {
      this.responseText = JSON.stringify({ attachment: stored(`up${opened.length}.txt`) });
      setTimeout(() => this.onload(), 5);
    }
  };
  try {
    addAttachments("shared", [new File(["hi"], "a.txt", { type: "text/plain" })]);
    const [first, second] = await Promise.all([uploadAttachments("shared", "s1"), uploadAttachments("shared", "s1")]);
    assert.equal(opened.length, 1);
    assert.deepEqual(first.attachments, second.attachments);
    assert.equal(readAttachments("shared")[0].status, "uploaded");
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});
