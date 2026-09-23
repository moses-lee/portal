/**
 * Secrets at rest. Provider API keys are sealed with AES-256-GCM under one server key that lives
 * outside the database (`<PORTAL_HOME>/server.key`), so a database dump or backup alone does not
 * reveal them. The payload format is base64 of `nonce (12) || ciphertext || tag (16)`; the
 * credential's name is bound in as additional authenticated data, so a row copied under another
 * name fails to open rather than handing one provider's key to another.
 *
 * Threat model: this protects copies of the database (dumps, backups, a volume handed to someone),
 * not the running host. Anything that runs as the Portal user can read `server.key` and query
 * Postgres, and that includes the orchestrator model's `run_command` tool; its `read_file` guard
 * against the key and the settings files is a courtesy, not a boundary.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SERVER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

export type ServerKey = {
  key: Buffer;
  /** First 16 hex characters of sha256(key): stored with each credential so a replaced key is detectable. */
  keyId: string;
};

export function serverKeyFrom(key: Buffer): ServerKey {
  if (key.length !== SERVER_KEY_BYTES) throw new Error(`A server key is ${SERVER_KEY_BYTES} bytes, got ${key.length}.`);
  return { key, keyId: createHash("sha256").update(key).digest("hex").slice(0, 16) };
}

export function generateServerKey(): ServerKey {
  return serverKeyFrom(randomBytes(SERVER_KEY_BYTES));
}

export function serverKeyFile(portalHome: string): string {
  return path.join(portalHome, "server.key");
}

/** The key file's text: 64 hex characters, or base64 (what this module writes). Surrounding whitespace is ignored. */
export function parseServerKey(text: string): ServerKey {
  const trimmed = text.trim();
  const bytes = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (bytes.length !== SERVER_KEY_BYTES) {
    throw new Error(`The server key must be ${SERVER_KEY_BYTES} bytes as base64 or hex; the file holds ${bytes.length} bytes.`);
  }
  return serverKeyFrom(bytes);
}

/**
 * The server key from `<portalHome>/server.key`, created (0600, in a 0700 directory when that is
 * new too) on first use. An existing file that does not hold a key is an error, never replaced:
 * overwriting it would orphan every credential sealed under the old key.
 */
export async function loadServerKey(portalHome: string): Promise<ServerKey> {
  const file = serverKeyFile(portalHome);
  try {
    return parseServerKey(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw withFile(err, file);
  }
  const created = generateServerKey();
  await mkdir(portalHome, { recursive: true, mode: 0o700 });
  try {
    // `wx` so two processes starting at once cannot each write a different key.
    await writeFile(file, created.key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    return created;
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw withFile(err, file);
    return parseServerKey(await readFile(file, "utf8"));
  }
}

function withFile(err: unknown, file: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Cannot load the server key ${file}: ${message}`, { cause: err });
}

/** Seal `plaintext`; `context` (the credential name) must be given again to open it. */
export function encryptSecret({ key }: ServerKey, plaintext: string, context = ""): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/** Open a payload from `encryptSecret`. Throws when it was altered, sealed under another key, or under another context. */
export function decryptSecret({ key }: ServerKey, payload: string, context = ""): string {
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length < NONCE_BYTES + TAG_BYTES) throw new Error("The sealed secret is truncated.");
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]).toString("utf8");
}
