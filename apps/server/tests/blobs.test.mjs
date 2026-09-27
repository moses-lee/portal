import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BLOB_NAME, MIN_INLINE_BYTES, createBlobStore, externalizeImages, mimeTypeOf, sha256 } from "../src/lib/blobs.ts";

const bytes = Buffer.alloc(MIN_INLINE_BYTES, 9);
const data = bytes.toString("base64");
const name = `${sha256(bytes)}.png`;
const image = { type: "content", content: { type: "image", data, mimeType: "image/png" } };

test("inline images in tool results become blob URLs, once per distinct image, and rawOutput copies follow", () => {
  const update = {
    sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "shot taken" } }, image, image],
    rawOutput: { image: data, nested: [{ again: data }], note: "done" },
  };
  const { update: logged, files } = externalizeImages(update);
  assert.deepEqual(files.map((file) => file.name), [name]);
  assert.equal(files[0].mimeType, "image/png");
  assert.deepEqual(logged.content[0], update.content[0]);
  assert.deepEqual(logged.content[1], { type: "content", content: { type: "image", data: "", mimeType: "image/png", uri: `/api/blobs/${name}` } });
  assert.deepEqual(logged.content[2], logged.content[1]);
  assert.deepEqual(logged.rawOutput, { image: `/api/blobs/${name}`, nested: [{ again: `/api/blobs/${name}` }], note: "done" });
  assert.equal(logged.toolCallId, "c");
  // The input is left alone.
  assert.equal(update.content[1].content.data, data);
  assert.equal(update.rawOutput.image, data);
});

test("updates without a large inline image are returned as they are", () => {
  const small = { sessionUpdate: "tool_call", toolCallId: "c", title: "t", content: [{ type: "content", content: { type: "image", data: "aGk=", mimeType: "image/png" } }] };
  assert.equal(externalizeImages(small).update, small);
  const text = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } };
  assert.equal(externalizeImages(text).update, text);
  const noContent = { sessionUpdate: "tool_call_update", toolCallId: "c", status: "in_progress" };
  assert.equal(externalizeImages(noContent).update, noContent);
});

test("the blob store writes a file once per hash and answers whether it has one", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portal-blobs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createBlobStore(path.join(dir, "nested", "blobs"));
  const [a, b] = await Promise.all([store.put(bytes, "image/png"), store.put(bytes, "image/png")]);
  assert.equal(a, name);
  assert.equal(b, name);
  assert.equal(await store.has(name), true);
  assert.deepEqual(readFileSync(store.pathOf(name)), bytes);
  assert.equal(await store.has(`${"0".repeat(64)}.png`), false);
  assert.equal(await store.put(bytes, "image/png"), name, "a second write is a no-op");
  assert.equal(await store.put(Buffer.from("other"), "application/x-thing"), `${sha256(Buffer.from("other"))}.bin`);
});

test("blob names are hashes with an extension, and the extension names the type", () => {
  assert.ok(BLOB_NAME.test(name));
  assert.equal(BLOB_NAME.test("../etc/passwd"), false);
  assert.equal(BLOB_NAME.test(`${"a".repeat(64)}`), false);
  assert.equal(mimeTypeOf(name), "image/png");
  assert.equal(mimeTypeOf(`${"a".repeat(64)}.jpg`), "image/jpeg");
  assert.equal(mimeTypeOf(`${"a".repeat(64)}.bin`), "application/octet-stream");
});
