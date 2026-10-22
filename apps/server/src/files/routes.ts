/**
 * `/api/files/**` and `/api/sessions/:id/uploads` (docs/FILES.md, contract in
 * `@portal/contracts/files`). Any path on the host is allowed (decision 1); a relative `path` is
 * resolved against `cwd`. Every write checks the request's origin first.
 */
import { constants, createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, chown, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type FileEntry, type FileListing, type FileStat, MAX_EDITABLE_BYTES, MAX_EXISTS_PATHS, MAX_LISTING_ENTRIES, MAX_UPLOAD_BYTES,
} from "@portal/contracts/files";
import type { AppContext } from "../context.ts";
import { errorMessage, errorStatus } from "../http/errors.ts";
import { rejectCrossOrigin } from "../http/origin.ts";
import { query } from "../http/query.ts";
import { resolveFilePath } from "../lib/fs-paths.ts";
import { displayPath } from "../lib/git-info.ts";
import { saveUpload } from "./uploads.ts";
import { detectView, mimeTypeFor, servedType } from "./view.ts";

/** What a save sends back as `If-Match`: changes whenever the file's time or size does. */
export function versionOf(info: Pick<Stats, "mtimeMs" | "size">): string {
  return `${info.mtimeMs}-${info.size}`;
}

/** `If-Match` as sent: the bare version, or an HTTP entity tag (`"…"`, `W/"…"`). Null when absent. */
function ifMatch(req: FastifyRequest): string | null {
  const header = req.headers["if-match"];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!value) return null;
  return value.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

async function statOrNull(file: string): Promise<Stats | null> {
  try {
    return await stat(file);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "EACCES" || code === "EPERM") throw Object.assign(new Error(`Permission denied: ${displayPath(file)}`), { status: 403 });
    throw err;
  }
}

export async function fileStat(file: string, info: Stats): Promise<FileStat> {
  if (info.isDirectory()) {
    return { path: file, kind: "dir", size: info.size, mtimeMs: info.mtimeMs, version: versionOf(info), mimeType: "inode/directory", view: null };
  }
  // A FIFO, socket or device is reported without being opened (docs/FILES.md): reading one could block forever.
  if (!info.isFile()) {
    return { path: file, kind: "file", size: info.size, mtimeMs: info.mtimeMs, version: versionOf(info), mimeType: "application/octet-stream", view: "binary" };
  }
  const view = await detectView(file);
  return { path: file, kind: "file", size: info.size, mtimeMs: info.mtimeMs, version: versionOf(info), mimeType: mimeTypeFor(file, view), view };
}

/** `Content-Disposition: attachment` with an ASCII fallback name and the real one in `filename*`. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** List `dir`: directories first, then by name; at most `MAX_LISTING_ENTRIES`, hidden files included. */
export async function listDirectory(dir: string): Promise<FileListing> {
  const dirents = await readdir(dir, { withFileTypes: true });
  // Kinds from the directory entries; symlinks are followed (a broken one lists as a file).
  const kinds = await Promise.all(dirents.map(async (entry): Promise<"file" | "dir"> => {
    if (entry.isDirectory()) return "dir";
    if (!entry.isSymbolicLink()) return "file";
    return (await stat(path.join(dir, entry.name)).catch(() => null))?.isDirectory() ? "dir" : "file";
  }));
  const sorted = dirents
    .map((entry, i) => ({ name: entry.name, kind: kinds[i] }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1)
      || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
  const kept = sorted.slice(0, MAX_LISTING_ENTRIES);
  const entries = await Promise.all(kept.map(async ({ name, kind }): Promise<FileEntry> => {
    const info = await stat(path.join(dir, name)).catch(() => null);
    return { name, kind, size: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0 };
  }));
  return { path: dir, entries, truncated: sorted.length > kept.length };
}

const notRegular = (file: string) => Object.assign(new Error(`Not a regular file: ${displayPath(file)}`), { status: 400 });

/** A 409 a save answers with the file's current version (null when it is gone). */
function conflict(info: Stats | null): Error {
  const error = info ? "The file changed on disk since it was opened." : "The file was deleted since it was opened.";
  return Object.assign(new Error(error), { status: 409, version: info ? versionOf(info) : null });
}

/** Throws unless `info` is a regular file at version `expected`. */
function assertVersion(file: string, info: Stats | null, expected: string): void {
  if (info && !info.isFile()) throw notRegular(file);
  if (!info || versionOf(info) !== expected) throw conflict(info);
}

/**
 * Save `body` over `file`, which `current` says is a regular file at version `expected`. Written
 * to a temporary file beside it with the old file's owner (best effort) and mode, then renamed
 * over it, so a reader never sees half a file. A file with other hard links, or in a folder Portal
 * cannot create files in, is written in place instead, so the links keep sharing it. The version is
 * checked again right before the file changes.
 */
async function saveOver(file: string, body: Uint8Array, current: Stats, expected: string): Promise<void> {
  if (current.nlink > 1) return writeInPlace(file, body, expected);
  const mode = current.mode & 0o7777;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.portal-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temp, body, { flag: "wx", mode });
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    const code = (err as { code?: string }).code;
    if (code === "EACCES" || code === "EPERM") return writeInPlace(file, body, expected);
    throw err;
  }
  try {
    // Best effort: only root may give a file away; a group the user is in works too.
    if (current.uid !== process.getuid?.() || current.gid !== process.getgid?.()) await chown(temp, current.uid, current.gid).catch(() => {});
    await chmod(temp, mode);
    assertVersion(file, await statOrNull(file), expected);
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Overwrite `file` itself (same inode): opened, its version checked, written from the start, and truncated. */
async function writeInPlace(file: string, body: Uint8Array, expected: string): Promise<void> {
  // Non-blocking, so a file swapped for a FIFO since it was checked cannot hang the open.
  const handle = await open(file, constants.O_RDWR | constants.O_NONBLOCK);
  try {
    assertVersion(file, await handle.stat(), expected);
    await handle.writeFile(body);
    await handle.truncate(body.byteLength);
  } finally {
    await handle.close();
  }
}

function sendError(reply: FastifyReply, err: unknown) {
  return reply.code(errorStatus(err) ?? 500).send({ error: errorMessage(err) });
}

/** The `path` and `cwd` query parameters, resolved. */
async function targetOf(req: FastifyRequest): Promise<string> {
  const input = query(req, "path");
  if (!input) throw Object.assign(new Error("Expected ?path="), { status: 400 });
  return resolveFilePath(input, query(req, "cwd"));
}

const notFound = (file: string) => Object.assign(new Error(`Not found: ${displayPath(file)}`), { status: 404 });

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/files/stat", async (req, reply) => {
    try {
      const file = await targetOf(req);
      const info = await statOrNull(file);
      if (!info) throw notFound(file);
      return await fileStat(file, info);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/files/list", async (req, reply) => {
    try {
      const dir = await targetOf(req);
      const info = await statOrNull(dir);
      if (!info) throw notFound(dir);
      if (!info.isDirectory()) return reply.code(400).send({ error: `Not a directory: ${displayPath(dir)}` });
      return await listDirectory(dir);
    } catch (err) {
      if ((err as { code?: string }).code === "EACCES") return reply.code(403).send({ error: errorMessage(err) });
      return sendError(reply, err);
    }
  });

  /** The bytes, labeled per `servedType`; `nosniff` always, so a browser never guesses a type that runs. */
  app.get("/api/files/raw", async (req, reply) => {
    let file: string;
    let info: Stats | null;
    try {
      file = await targetOf(req);
      info = await statOrNull(file);
      if (!info) throw notFound(file);
    } catch (err) {
      return sendError(reply, err);
    }
    if (info.isDirectory()) return reply.code(400).send({ error: `Is a directory: ${displayPath(file)}` });
    if (!info.isFile()) return reply.code(400).send({ error: notRegular(file).message });
    const view = await detectView(file);
    const { contentType, sandbox } = servedType(mimeTypeFor(file, view), view);
    const etag = `"${versionOf(info)}"`;
    reply
      .header("etag", etag)
      .header("cache-control", "no-cache")
      .header("x-content-type-options", "nosniff")
      .header("content-type", contentType);
    if (sandbox) reply.header("content-security-policy", "sandbox");
    if (query(req, "download") === "1") reply.header("content-disposition", attachmentDisposition(path.basename(file)));
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.send(createReadStream(file));
  });

  app.post("/api/files/exists", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const body = req.body as { cwd?: unknown; paths?: unknown } | null;
    if (!body || typeof body !== "object" || !Array.isArray(body.paths) || !body.paths.every((p) => typeof p === "string")) {
      return reply.code(400).send({ error: "Expected {cwd, paths: string[]}." });
    }
    if (body.paths.length > MAX_EXISTS_PATHS) return reply.code(400).send({ error: `At most ${MAX_EXISTS_PATHS} paths.` });
    if (body.cwd !== undefined && body.cwd !== null && typeof body.cwd !== "string") return reply.code(400).send({ error: "cwd must be a string." });
    const cwd = (body.cwd as string | null | undefined) ?? null;
    const paths = body.paths as string[];
    const found = await Promise.all(paths.map(async (input) => {
      if (!input || input.length > 4096) return false;
      try {
        return (await statOrNull(await resolveFilePath(input, cwd))) !== null;
      } catch {
        return false;
      }
    }));
    return { existing: paths.filter((_, i) => found[i]) };
  });

  // Raw bodies: a save's text and an upload's bytes, of any content type. Scoped to these routes,
  // so the rest of the API keeps Fastify's JSON parsing.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    /**
     * Save text. With `If-Match` the file must still be at that version (409 `{ error, version }`
     * with the current one, null when it is gone); without, the file is created and one already
     * there is refused (409). Answers `{ version }`.
     */
    scope.put("/api/files/raw", { bodyLimit: MAX_EDITABLE_BYTES }, async (req, reply) => {
      if (rejectCrossOrigin(req, reply)) return reply;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        const file = await targetOf(req);
        const expected = ifMatch(req);
        const current = await statOrNull(file);
        if (current?.isDirectory()) return reply.code(400).send({ error: `Is a directory: ${displayPath(file)}` });
        if (current && !current.isFile()) return reply.code(400).send({ error: notRegular(file).message });
        if (expected === null) {
          if (current) return reply.code(409).send({ error: "The file already exists.", version: versionOf(current) });
          const parent = await statOrNull(path.dirname(file));
          if (!parent?.isDirectory()) return reply.code(404).send({ error: `Folder not found: ${displayPath(path.dirname(file))}` });
          try {
            await writeFile(file, body, { flag: "wx" });
          } catch (err) {
            if ((err as { code?: string }).code !== "EEXIST") throw err;
            const now = await statOrNull(file);
            return reply.code(409).send({ error: "The file already exists.", version: now ? versionOf(now) : null });
          }
        } else {
          if (!current || versionOf(current) !== expected) throw conflict(current);
          await saveOver(file, body, current, expected);
        }
        const saved = await stat(file);
        return { version: versionOf(saved) };
      } catch (err) {
        const { code, status, version } = err as { code?: string; status?: number; version?: string | null };
        if (status === 409) return reply.code(409).send({ error: errorMessage(err), version: version ?? null });
        if (code === "EACCES" || code === "EPERM" || code === "EROFS") return reply.code(403).send({ error: errorMessage(err) });
        return sendError(reply, err);
      }
    });

    /** One file sent with a prompt (docs/FILES.md, decision 8): the body is its bytes. Answers `{ attachment }`. */
    scope.post<{ Params: { id: string } }>("/api/sessions/:id/uploads", { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
      if (rejectCrossOrigin(req, reply)) return reply;
      const root = ctx.sessions.uploadsDir;
      await ctx.sessions.ready;
      if (!ctx.sessions.getSession(req.params.id)) return reply.code(404).send({ error: "Unknown session." });
      if (!root) return reply.code(503).send({ error: "Uploads are not available." });
      const name = query(req, "name");
      if (!name?.trim()) return reply.code(400).send({ error: "Expected ?name=" });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        return { attachment: await saveUpload(root, req.params.id, name, body, req.headers["content-type"]) };
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });
}
