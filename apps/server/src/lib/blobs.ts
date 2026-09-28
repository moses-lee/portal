/**
 * Content-addressed files for the large binary payloads agents put in tool results: screenshots
 * mostly. A base64 image inside a `tool_call`/`tool_call_update` is written once under its
 * SHA-256 (so the same screenshot repeated in `content` and `rawOutput` is one file) and the event
 * carries a URL instead. Pages and live streams then cost what the text costs, and browsers cache
 * the images by hash. Nothing reads the files back except `GET /api/blobs/:name`.
 */
import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

export const BLOB_ROUTE = "/api/blobs";

/** Extensions for the image types agents send; anything else is served as octet-stream. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};
const MIME_BY_EXTENSION = Object.fromEntries(Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime]));

/** `<64 hex>.<ext>`: the only shape the route accepts, so a name can never leave the directory. */
export const BLOB_NAME = /^([a-f0-9]{64})\.([a-z0-9]{1,8})$/;

export function mimeTypeOf(name: string): string {
  const ext = BLOB_NAME.exec(name)?.[2];
  return (ext && MIME_BY_EXTENSION[ext]) || "application/octet-stream";
}

/** Only inline payloads at least this long are moved out; a tiny icon is cheaper inline. */
export const MIN_INLINE_BYTES = 4 * 1024;

export type BlobStore = {
  /** The directory files live in. */
  dir: string;
  /** Write `bytes` if absent; resolves to the file name. Safe to call concurrently for one hash. */
  put(bytes: Uint8Array, mimeType: string): Promise<string>;
  /** Absolute path for a name the route validated with `BLOB_NAME`. */
  pathOf(name: string): string;
  /** Whether the file exists (and is not still being written). */
  has(name: string): Promise<boolean>;
};

export function createBlobStore(dir: string): BlobStore {
  const ready = mkdir(dir, { recursive: true });
  const writes = new Map<string, Promise<string>>();
  return {
    dir,
    pathOf: (name) => path.join(dir, name),
    async has(name) {
      return stat(path.join(dir, name)).then((s) => s.isFile(), () => false);
    },
    put(bytes, mimeType) {
      const name = `${sha256(bytes)}.${EXTENSIONS[mimeType] ?? "bin"}`;
      const pending = writes.get(name);
      if (pending) return pending;
      const run = (async () => {
        await ready;
        const target = path.join(dir, name);
        if (await stat(target).then(() => true, () => false)) return name;
        // Write beside, then rename: a reader never sees a half-written file.
        const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(temp, bytes);
        await rename(temp, target);
        return name;
      })().finally(() => {
        if (writes.get(name) === run) writes.delete(name);
      });
      writes.set(name, run);
      return run;
    },
  };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type ImageItem = acp.ToolCallContent & { type: "content"; content: acp.ImageContent };

function isInlineImage(item: acp.ToolCallContent): item is ImageItem {
  return item.type === "content" && item.content.type === "image" && typeof item.content.data === "string" && item.content.data.length >= MIN_INLINE_BYTES;
}

/** Replace every string equal to one of `strings` anywhere inside `value` (used to strip the copy in `rawOutput`). */
function replaceStrings(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === "string") return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => replaceStrings(entry, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceStrings(entry, replacements)]));
  }
  return value;
}

export type Externalized = {
  update: acp.SessionUpdate;
  /** Files to write, by name; empty when nothing was moved out. */
  files: { name: string; bytes: Uint8Array; mimeType: string }[];
};

/**
 * Move inline images of a tool update out to blobs. Pure apart from hashing: the returned update
 * names the files, and `files` holds what to write. Every image item becomes
 * `{ type: "image", mimeType, data: "", uri: "/api/blobs/<name>" }`; a `rawOutput` that repeats the
 * same base64 (Claude Code's screenshot tool does) gets the URL in its place too. Updates without
 * inline images are returned as they are.
 */
export function externalizeImages(update: acp.SessionUpdate): Externalized {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return { update, files: [] };
  if (!Array.isArray(update.content) || !update.content.some(isInlineImage)) return { update, files: [] };
  const files: Externalized["files"] = [];
  const replacements = new Map<string, string>();
  const content = update.content.map((item): acp.ToolCallContent => {
    if (!isInlineImage(item)) return item;
    const bytes = Buffer.from(item.content.data, "base64");
    const name = `${sha256(bytes)}.${EXTENSIONS[item.content.mimeType] ?? "bin"}`;
    const uri = `${BLOB_ROUTE}/${name}`;
    if (!files.some((file) => file.name === name)) files.push({ name, bytes, mimeType: item.content.mimeType });
    replacements.set(item.content.data, uri);
    const image: acp.ImageContent = { ...item.content, data: "", uri };
    return { ...item, content: image } as acp.ToolCallContent;
  });
  const rawOutput = update.rawOutput === undefined ? undefined : replaceStrings(update.rawOutput, replacements);
  return { update: { ...update, content, ...(rawOutput === undefined ? {} : { rawOutput }) }, files };
}
