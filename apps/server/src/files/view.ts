/**
 * What kind of file a path is, for the file pane (docs/FILES.md): its view (text, markdown, image,
 * pdf, binary) and MIME type, from the extension, with a NUL-byte sniff of the first 8 KB for
 * extensions the tables do not know. Also how `GET /api/files/raw` labels the bytes it serves.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { FileView } from "@portal/contracts/files";

const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);

/** Source, config, data, and prose formats that open in the editor. */
const TEXT = new Set([
  "txt", "text", "log", "csv", "tsv", "json", "jsonc", "json5", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "properties", "xml", "xsd", "xsl", "plist", "html", "htm", "xhtml", "css", "scss", "sass", "less", "styl",
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "astro", "py", "pyi", "ipynb", "rb", "go", "rs", "java", "kt",
  "kts", "scala", "groovy", "gradle", "swift", "m", "mm", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "cs", "fs", "php", "pl", "pm",
  "lua", "r", "jl", "dart", "zig", "nim", "ex", "exs", "erl", "hrl", "hs", "ml", "mli", "clj", "cljs", "edn", "elm", "sql", "graphql", "gql",
  "proto", "thrift", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "bzl", "bazel", "star", "bazelrc", "cmake", "mk", "make", "nix",
  "tf", "tfvars", "hcl", "dockerfile", "diff", "patch", "tex", "bib", "rst", "adoc", "org", "vim", "el", "lisp", "lock", "gitignore",
  "gitattributes", "editorconfig", "npmrc", "nvmrc", "prettierrc", "eslintrc", "babelrc", "srt", "vtt", "pem", "crt",
]);

/** Formats that are never worth sniffing. */
const BINARY = new Set([
  "zip", "gz", "tgz", "bz2", "xz", "zst", "tar", "7z", "rar", "jar", "war", "class", "exe", "dll", "so", "dylib", "o", "a", "wasm",
  "node", "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "mp4", "m4v", "mov", "avi", "mkv", "webm", "woff", "woff2", "ttf", "otf",
  "eot", "sqlite", "sqlite3", "db", "psd", "ai", "sketch", "heic", "heif", "tif", "tiff", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "numbers", "pages", "dmg", "iso", "bin", "dat", "pyc", "parquet", "arrow", "pkl",
]);

const MIME: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", mdx: "text/markdown",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
  avif: "image/avif", ico: "image/x-icon", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff",
  pdf: "application/pdf",
  txt: "text/plain", log: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson", yaml: "application/yaml", yml: "application/yaml", toml: "application/toml", xml: "application/xml",
  html: "text/html", htm: "text/html", xhtml: "application/xhtml+xml", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  cjs: "text/javascript", ts: "text/typescript", tsx: "text/typescript", py: "text/x-python", sh: "application/x-sh", sql: "application/sql",
  zip: "application/zip", gz: "application/gzip", tgz: "application/gzip", tar: "application/x-tar", wasm: "application/wasm",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/opus",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Bytes read to tell text from binary when the extension does not say. */
export const SNIFF_BYTES = 8 * 1024;

/** The extension, lower case and without the dot; a dotfile's name (`.gitignore` -> `gitignore`); else the name (`Dockerfile`). */
function extensionOf(file: string): string {
  const base = path.basename(file).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(dot + 1);
}

/** The view an extension decides on its own; null when only the contents can tell. */
export function viewFromExtension(file: string): FileView | null {
  const ext = extensionOf(file);
  if (MARKDOWN.has(ext)) return "markdown";
  if (IMAGE.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (TEXT.has(ext)) return "text";
  if (BINARY.has(ext)) return "binary";
  return null;
}

/** Text unless the bytes hold a NUL. */
export function sniffView(head: Uint8Array): FileView {
  return head.includes(0) ? "binary" : "text";
}

/**
 * The file's view: the extension's, else a sniff of its first `SNIFF_BYTES`. An unreadable file
 * counts as binary, and so does anything that is not a regular file (a FIFO, socket or device):
 * it is opened non-blocking and never read, since a read could wait forever.
 */
export async function detectView(file: string): Promise<FileView> {
  const known = viewFromExtension(file);
  if (known) return known;
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return "binary";
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return sniffView(buffer.subarray(0, bytesRead));
  } catch {
    return "binary";
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The MIME type the extension names; `text/plain` for other text and `application/octet-stream` for other binary. */
export function mimeTypeFor(file: string, view: FileView | null = viewFromExtension(file)): string {
  return MIME[extensionOf(file)] ?? (view === "text" || view === "markdown" ? "text/plain" : "application/octet-stream");
}

/** Types that render as a document in a browser tab and so could run script on Portal's origin. */
const ACTIVE = new Set(["text/html", "application/xhtml+xml", "image/svg+xml", "application/xml", "text/xml"]);

/**
 * How `GET /api/files/raw` labels a file: images, PDFs, audio and video as what they are, so
 * `<img>`, `<iframe>` and `<video>` work; HTML as HTML; every other text as `text/plain`, so a
 * script or stylesheet never runs as one. `sandbox` is set for types that could run script
 * (HTML, SVG, XML): the route sends them with `Content-Security-Policy: sandbox`, which renders
 * them in an opaque origin with scripts off. Not on PDFs: Chrome refuses to show a sandboxed PDF.
 */
export function servedType(mimeType: string, view: FileView | null): { contentType: string; sandbox: boolean } {
  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") return { contentType: "text/html; charset=utf-8", sandbox: true };
  if (view === "image" || view === "pdf" || /^(audio|video|font)\//.test(mimeType)) return { contentType: mimeType, sandbox: ACTIVE.has(mimeType) };
  if (view === "text" || view === "markdown") return { contentType: "text/plain; charset=utf-8", sandbox: false };
  return { contentType: "application/octet-stream", sandbox: false };
}
