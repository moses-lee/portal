import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decryptSecret,
  encryptSecret,
  generateServerKey,
  loadServerKey,
  parseServerKey,
  serverKeyFile,
  serverKeyFrom,
} from "../src/settings/crypto.ts";

function tempHome(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-key-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, "portal-home");
}

test("a secret round-trips, and every sealing uses a fresh nonce", () => {
  const key = generateServerKey();
  for (const secret of ["sk-ant-secret", "", "é🔑".repeat(50), "k".repeat(512)]) {
    const sealed = encryptSecret(key, secret, "anthropic");
    assert.ok(!sealed.includes(secret) || secret === "", "the payload does not contain the plaintext");
    assert.equal(decryptSecret(key, sealed, "anthropic"), secret);
  }
  const a = encryptSecret(key, "same", "openai");
  const b = encryptSecret(key, "same", "openai");
  assert.notEqual(a, b);
  // nonce (12) + ciphertext (4) + tag (16)
  assert.equal(Buffer.from(a, "base64").length, 12 + 4 + 16);
});

test("tampering with any part of the payload is detected", () => {
  const key = generateServerKey();
  const sealed = Buffer.from(encryptSecret(key, "sk-openai-secret", "openai"), "base64");
  for (const index of [0, 11, 12, sealed.length - 17, sealed.length - 16, sealed.length - 1]) {
    const altered = Buffer.from(sealed);
    altered[index] ^= 0x01;
    assert.throws(() => decryptSecret(key, altered.toString("base64"), "openai"), `byte ${index}`);
  }
  assert.throws(() => decryptSecret(key, sealed.subarray(0, 20).toString("base64"), "openai"), /truncated/);
  assert.throws(() => decryptSecret(key, sealed.subarray(0, sealed.length - 1).toString("base64"), "openai"));
});

test("the wrong key or the wrong context cannot open a payload", () => {
  const key = generateServerKey();
  const sealed = encryptSecret(key, "sk-openai-secret", "openai");
  assert.throws(() => decryptSecret(generateServerKey(), sealed, "openai"));
  assert.throws(() => decryptSecret(key, sealed, "anthropic"), "a row copied under another name does not open");
  assert.throws(() => decryptSecret(key, sealed));
  assert.equal(decryptSecret(serverKeyFrom(Buffer.from(key.key)), sealed, "openai"), "sk-openai-secret");
});

test("keyId is the first 16 hex characters of sha256(key), and keys must be 32 bytes", () => {
  const bytes = randomBytes(32);
  assert.equal(serverKeyFrom(bytes).keyId, createHash("sha256").update(bytes).digest("hex").slice(0, 16));
  assert.match(generateServerKey().keyId, /^[0-9a-f]{16}$/);
  assert.throws(() => serverKeyFrom(randomBytes(16)), /32 bytes/);
  assert.equal(parseServerKey(bytes.toString("hex")).keyId, serverKeyFrom(bytes).keyId, "hex is accepted");
  assert.equal(parseServerKey(`  ${bytes.toString("base64")}\n`).keyId, serverKeyFrom(bytes).keyId, "base64 is accepted");
  assert.throws(() => parseServerKey("c2hvcnQ="), /32 bytes/);
  assert.throws(() => parseServerKey(""), /32 bytes/);
});

test("loadServerKey creates a private key file once and reads the same key afterwards", async (t) => {
  const home = tempHome(t);
  const created = await loadServerKey(home);
  const file = serverKeyFile(home);
  assert.equal(statSync(file).mode & 0o777, 0o600, "the key file is 0600");
  assert.equal(statSync(home).mode & 0o077, 0, "a fresh PORTAL_HOME is 0700");
  assert.equal(Buffer.from(readFileSync(file, "utf8").trim(), "base64").length, 32);
  const again = await loadServerKey(home);
  assert.equal(again.keyId, created.keyId);
  assert.deepEqual(again.key, created.key);

  // Concurrent first loads agree on one key.
  const other = tempHome(t);
  const keys = await Promise.all([loadServerKey(other), loadServerKey(other), loadServerKey(other)]);
  assert.equal(new Set(keys.map(({ keyId }) => keyId)).size, 1);
});

test("loadServerKey reads a hex key and refuses to replace a file that holds no key", async (t) => {
  const home = tempHome(t);
  mkdirSync(home, { recursive: true });
  const bytes = randomBytes(32);
  writeFileSync(serverKeyFile(home), bytes.toString("hex") + "\n");
  assert.equal((await loadServerKey(home)).keyId, serverKeyFrom(bytes).keyId);

  writeFileSync(serverKeyFile(home), "not a key");
  await assert.rejects(loadServerKey(home), /server\.key.*32 bytes/);
  assert.equal(readFileSync(serverKeyFile(home), "utf8"), "not a key", "the bad file is left alone");
});
