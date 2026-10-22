/**
 * Files on the host: the viewer/editor pane and prompt attachments (docs/FILES.md).
 *
 * HTTP surface (`path` is absolute, `~/…`, or relative to `cwd`; any path on the host is allowed):
 *   GET  /api/files/stat?path=&cwd=              FileStat; 404 { error } when missing
 *   GET  /api/files/raw?path=&cwd=&download=1    the bytes, with their MIME type; ETag is the version
 *   GET  /api/files/list?path=&cwd=              FileListing; 404 when missing, 400 when not a directory
 *   PUT  /api/files/raw?path=&cwd=               text body; `If-Match: <version>` -> { version }; 409 { error, version } when
 *                                                the file changed; no If-Match creates and 409s if it exists; 413 over MAX_EDITABLE_BYTES
 *   POST /api/files/exists { cwd, paths }        { existing } (inputs as given, that exist); at most MAX_EXISTS_PATHS
 *   POST /api/sessions/:id/uploads?name=         raw body -> { attachment }; 413 over MAX_UPLOAD_BYTES
 */

/** How the pane shows a file: from the extension, with a NUL-byte sniff for unknown ones. */
export type FileView = "text" | "markdown" | "image" | "pdf" | "binary";

export type FileStat = {
  /** Absolute, symlinks resolved. */
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  /** `${mtimeMs}-${size}`: what a save sends back as `If-Match`. */
  version: string;
  mimeType: string;
  /** Null for a directory. */
  view: FileView | null;
};

export type FileEntry = { name: string; kind: "file" | "dir"; size: number; mtimeMs: number };

/** Directories first, then by name; `truncated` once past MAX_LISTING_ENTRIES. */
export type FileListing = { path: string; entries: FileEntry[]; truncated: boolean };

/** A file sent with a prompt; stored under `~/.portal/uploads/<sessionId>/`. */
export type Attachment = { path: string; name: string; mimeType: string; size: number };

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** Text larger than this opens read-only, truncated, and a save of it is refused. */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;
export const MAX_LISTING_ENTRIES = 2000;
export const MAX_EXISTS_PATHS = 200;
