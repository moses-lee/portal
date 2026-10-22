/**
 * Files sent with prompts (docs/FILES.md, decision 4): stored under `<portalHome>/uploads/<sessionId>/`
 * as `<random8>-<safe name>`, outside any worktree, and removed with their session. A prompt's
 * attachments must point into its own session's directory.
 */
import { randomBytes } from "node:crypto";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Attachment, MAX_ATTACHMENTS } from "@portal/contracts/files";
import { httpError } from "../http/errors.ts";
import { mimeTypeFor } from "./view.ts";

/** Session ids are UUIDs; anything that could leave the uploads directory is refused. */
const SESSION_DIR = /^[A-Za-z0-9_-]{1,128}$/;
const NAME_MAX = 255;
const STORED_NAME_MAX = 100;

function sessionDir(root: string, sessionId: string): string {
  if (!SESSION_DIR.test(sessionId)) throw httpError("Invalid session id.", 400);
  return path.join(root, sessionId);
}

/** `name` cut to `max` characters, keeping a short extension. */
function truncateKeepingExtension(name: string, max: number): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  return name.slice(0, max - ext.length) + ext;
}

/** The display name: the last path segment of what the browser sent, without control characters. */
export function displayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return truncateKeepingExtension(base, NAME_MAX) || "file";
}

/**
 * The name a file is stored under (after its random prefix): ASCII letters, digits, `.`, `-` and
 * `_` only, so the path needs no escaping in a `file://` URL or a shell, no leading dot, and at
 * most 100 characters with the extension kept.
 */
export function sanitizeUploadName(name: string): string {
  const base = displayName(name).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  let safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[._]+/, "").replace(/\.{2,}/g, ".");
  if (!safe || safe === "_") safe = "file";
  return truncateKeepingExtension(safe, STORED_NAME_MAX);
}

/** A `type/subtype` that says more than "some bytes"; parameters dropped. Null otherwise. */
function specificMimeType(contentType: string | undefined): string | null {
  const type = contentType?.split(";")[0].trim().toLowerCase();
  if (!type || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)) return null;
  if (type === "application/octet-stream" || type === "application/x-www-form-urlencoded" || type.startsWith("multipart/")) return null;
  return type;
}

/** Write one upload; answers the attachment a prompt can then carry. */
export async function saveUpload(
  root: string, sessionId: string, name: string, bytes: Uint8Array, contentType?: string,
): Promise<Attachment> {
  const dir = sessionDir(root, sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // The canonical path, as `stat` reports it, so a file pane opened on it is the same path.
  const real = await realpath(dir);
  const display = displayName(name);
  const file = path.join(real, `${randomBytes(4).toString("hex")}-${sanitizeUploadName(display)}`);
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return { path: file, name: display, mimeType: specificMimeType(contentType) ?? mimeTypeFor(display), size: bytes.byteLength };
}

/** Remove a session's uploads; nothing to remove is fine. */
export async function removeSessionUploads(root: string, sessionId: string): Promise<void> {
  if (!SESSION_DIR.test(sessionId)) return;
  await rm(path.join(root, sessionId), { recursive: true, force: true });
}

/**
 * Check a prompt's `attachments` from the request body: at most `MAX_ATTACHMENTS`, each naming a
 * file directly inside this session's uploads directory that exists. Answers them normalized (the
 * size as stored, a MIME type from the extension when the one given is not a type). Throws a 400.
 */
export async function validateAttachments(root: string, sessionId: string, raw: unknown): Promise<Attachment[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw httpError("attachments must be an array.", 400);
  if (raw.length > MAX_ATTACHMENTS) throw httpError(`At most ${MAX_ATTACHMENTS} attachments per prompt.`, 400);
  if (raw.length === 0) return [];
  let dir: string;
  try {
    dir = await realpath(sessionDir(root, sessionId));
  } catch (err) {
    if ((err as { status?: number }).status) throw err;
    throw httpError("Attachments must be uploaded to this session first.", 400);
  }
  const out: Attachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw httpError("Each attachment must be an object.", 400);
    const { path: file, name, mimeType } = item as Record<string, unknown>;
    if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file || path.dirname(file) !== dir) {
      throw httpError("An attachment must be a file uploaded to this session.", 400);
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw httpError(`Attachment not found: ${path.basename(file)}`, 400);
    const shown = typeof name === "string" && name.trim() ? displayName(name) : path.basename(file).replace(/^[0-9a-f]{8}-/, "");
    out.push({ path: file, name: shown, mimeType: specificMimeType(typeof mimeType === "string" ? mimeType : undefined) ?? mimeTypeFor(shown), size: info.size });
  }
  return out;
}
