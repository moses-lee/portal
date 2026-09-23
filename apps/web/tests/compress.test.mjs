import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { jsonResponse } from "../src/lib/compress.ts";

const big = { events: Array.from({ length: 200 }, (_, i) => ({ seq: i, type: "update", text: "hello ".repeat(10) })) };
const request = (encoding) => new Request("http://portal/api", { headers: encoding === undefined ? {} : { "accept-encoding": encoding } });

test("a large body is gzipped for a client that accepts gzip", async () => {
  const r = await jsonResponse(request("gzip, deflate, br"), big);
  assert.equal(r.headers.get("content-encoding"), "gzip");
  assert.equal(r.headers.get("content-type"), "application/json");
  assert.equal(r.headers.get("vary"), "Accept-Encoding");
  const raw = Buffer.from(await r.arrayBuffer());
  assert.equal(Number(r.headers.get("content-length")), raw.byteLength);
  assert.deepEqual(JSON.parse(gunzipSync(raw).toString("utf8")), big);
  assert.ok(raw.byteLength < JSON.stringify(big).length / 5);
});

test("a client that does not accept gzip gets plain JSON", async () => {
  for (const encoding of [undefined, "br", "gzip;q=0", "identity"]) {
    const r = await jsonResponse(request(encoding), big);
    assert.equal(r.headers.get("content-encoding"), null, `accept-encoding: ${encoding}`);
    assert.deepEqual(await r.json(), big);
  }
});

test("a small body is never gzipped and status and headers pass through", async () => {
  const r = await jsonResponse(request("gzip"), { error: "nope" }, { status: 404, headers: { "x-test": "1" } });
  assert.equal(r.status, 404);
  assert.equal(r.headers.get("content-encoding"), null);
  assert.equal(r.headers.get("x-test"), "1");
  assert.deepEqual(await r.json(), { error: "nope" });
});
