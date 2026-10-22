/**
 * Paths in agent text and links (docs/FILES.md, "Transcript"): what a reply link points at, the
 * line suffix on a path, and which inline code or bare words look enough like a path to ask the
 * server whether they exist (decision 14).
 */
import { inAppLinkPath } from "./session-routes.ts";

/** Where a link in a reply goes. A `file` path is as written (absolute, `~/…`, or relative), less its line suffix. */
export type HrefTarget =
  | { kind: "external"; href: string }
  | { kind: "app"; path: string }
  | { kind: "file"; path: string; line: number | null }
  /** An in-page anchor (`#notes`) or an empty href: left as it is. */
  | { kind: "none" }
  /** Nothing this machine or browser can open (`localhost:3000`, `?q`, `C:\x`): shown as its text. */
  | { kind: "text" };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/** A path with a line suffix (`README.md:42`, `a.ts:4:7`) reads like a URL scheme; it is not one. */
const LINE_AFTER_COLON = /^\d+(?::\d+)?$/;

/** The URL scheme of `href` (lower case), or null for a path, including `name.ext:42`. */
export function hrefScheme(href: string): string | null {
  const match = SCHEME.exec(href);
  if (!match) return null;
  if (LINE_AFTER_COLON.test(href.slice(match[0].length))) return null;
  return match[1].toLowerCase();
}

const MARKDOWN_SCHEMES = new Set(["http", "https", "irc", "ircs", "mailto", "xmpp", "file"]);

/**
 * react-markdown's `urlTransform`: its default drops `file:` links and any path with a line
 * suffix (it reads `README.md:42` as a scheme). This keeps those, and still drops `javascript:`
 * and other schemes the default refuses.
 */
export function keepMarkdownUrl(url: string): string {
  const scheme = hrefScheme(url);
  return scheme === null || MARKDOWN_SCHEMES.has(scheme) ? url : "";
}

/** A path's trailing `:42`, `:42:7`, `#L42` (also `#L42-L50`, `#L42C7`) as a line; the path without it. */
export function parseLineSuffix(input: string): { path: string; line: number | null } {
  const match = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/.exec(input);
  if (!match) return { path: input, line: null };
  const line = Number(match[2] ?? match[3]);
  return { path: match[1], line: line > 0 ? line : null };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A file link's target: a fragment that is not a line (`#section`) dropped, then decoded (a `%23` in a name stays). */
function fileTarget(raw: string): HrefTarget {
  const hash = raw.indexOf("#");
  const path = hash > 0 && !/^#L\d/.test(raw.slice(hash)) ? raw.slice(0, hash) : raw;
  return { kind: "file", ...parseLineSuffix(decode(path)) };
}

/** `localhost:3000`, `example.com:8080`, `127.0.0.1:80`: a host and port, not `README.md:42` or `Makefile:12`. */
function isHostAndPort(value: string): boolean {
  const match = /^([^/:]+):\d+$/.exec(value);
  if (!match) return false;
  const name = match[1].toLowerCase();
  if (name === "localhost") return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && !KNOWN_EXTENSIONS.has(name.slice(dot + 1));
}

/**
 * Classifies a link's `href`, first match wins: a URL scheme opens in a new browser tab; a Portal
 * route navigates in place; `file://…`, `/abs`, `~/…` and relative paths are files. A Windows
 * path, a bare query and a host with a port are none of these, so they stay text.
 * Markdown percent-encodes spaces and non-ASCII in link targets, so file paths are decoded.
 */
export function classifyHref(href: string | null | undefined, origin: string | null): HrefTarget {
  const value = href?.trim() ?? "";
  if (!value || value.startsWith("#")) return { kind: "none" };
  if (value.startsWith("?") || /^[a-z]:[\\/]/i.test(value) || isHostAndPort(value)) return { kind: "text" };
  const scheme = hrefScheme(value);
  if (scheme === "file") {
    // file:///abs/path, file://localhost/abs/path; any other host is not this machine's.
    const rest = value.replace(/^file:(?:\/\/(?:localhost)?)?/i, "");
    if (!rest.startsWith("/")) return { kind: "external", href: value };
    return fileTarget(rest);
  }
  const app = scheme === null || scheme === "http" || scheme === "https" ? inAppLinkPath(value, origin) : null;
  if (app !== null) return { kind: "app", path: app };
  if (scheme !== null || value.startsWith("//")) return { kind: "external", href: value };
  return fileTarget(value);
}

/** Absolute or home-relative: openable without a working directory. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path === "~" || path.startsWith("~/");
}

/** The raw bytes of a file, for ⌘-click and middle-click (`GET /api/files/raw`). */
export function rawFileUrl(path: string, cwd?: string | null): string {
  const query = new URLSearchParams({ path });
  if (cwd && !isAbsolutePath(path)) query.set("cwd", cwd);
  return `/api/files/raw?${query}`;
}

const KNOWN_EXTENSIONS = new Set(
  (
    "md mdx markdown txt rst adoc log csv tsv json jsonl yaml yml toml ini cfg conf env lock xml html htm css scss sass less " +
    "js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi ipynb rb rs go java kt kts scala swift m mm c h cc cpp cxx hpp hh " +
    "cs fs php pl lua dart ex exs erl hs ml clj zig nim r jl sh bash zsh fish ps1 bat sql graphql gql proto thrift bzl bazel " +
    "bazelrc star gradle cmake mk tf tfvars nix dockerfile patch diff png jpg jpeg gif webp svg ico bmp avif heic pdf zip gz tgz"
  ).split(" "),
);

/** Characters no path in prose has; their presence means code, a URL, or markup. */
const NOT_A_PATH = /[\s`'"<>|*?{}[\]()=,;!$&\\^]/;

/**
 * A candidate path in agent text (inline code or a bare word): no spaces, contains `/` or ends in
 * a known extension, optionally with a line suffix. Only candidates are checked for existence;
 * this only keeps obvious non-paths (`a == b`, URLs, version numbers) from being asked about.
 */
export function pathCandidate(text: string): { path: string; line: number | null } | null {
  if (text.length < 2 || text.length > 400 || NOT_A_PATH.test(text)) return null;
  if (hrefScheme(text) !== null || text.startsWith("//")) return null;
  const { path, line } = parseLineSuffix(text);
  if (path.includes(":") || path.includes("#")) return null;
  if (/^[./~]+$/.test(path) || path.includes("//") || path.startsWith("-")) return null;
  const name = path.replace(/\/+$/, "").split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!path.includes("/") && !KNOWN_EXTENSIONS.has(extension)) return null;
  // `1.2/3.4` and `24/7` are numbers, not paths.
  if (/^[\d./]+$/.test(path)) return null;
  return { path, line };
}

/** Punctuation that sits around a word in prose but is not part of a path. */
const LEADING = /^[("'[{<]+/;
const TRAILING = /[)"'\]}>.,;:!?]+$/;

/** The bare words in `text` that are path candidates, with their offsets, for wrapping in place. */
export function bareTokenCandidates(text: string): { start: number; end: number; path: string; line: number | null }[] {
  const found: { start: number; end: number; path: string; line: number | null }[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0];
    const lead = LEADING.exec(word)?.[0].length ?? 0;
    // Keep a line suffix: trailing punctuation goes, but `:42` before it stays.
    const core = word.slice(lead).replace(TRAILING, "");
    if (!core.includes("/") && !core.includes(".")) continue;
    const candidate = pathCandidate(core);
    if (!candidate) continue;
    const start = match.index + lead;
    found.push({ start, end: start + core.length, ...candidate });
  }
  return found;
}

/** The slice of hast the plugin below touches (the `hast` types are not a direct dependency). */
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** Text inside these is code, a link already, or not prose. */
const NO_PATH_TOKENS = new Set(["a", "code", "pre", "script", "style", "svg"]);

function wrapPathTokens(node: HastNode) {
  if (!node.children) return;
  const children: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      const text = child.value;
      let at = 0;
      for (const { start, end } of bareTokenCandidates(text)) {
        if (start > at) children.push({ type: "text", value: text.slice(at, start) });
        const token = text.slice(start, end);
        children.push({
          type: "element",
          tagName: "span",
          properties: { dataPathToken: token },
          children: [{ type: "text", value: token }],
        });
        at = end;
      }
      if (at === 0) children.push(child);
      else if (at < text.length) children.push({ type: "text", value: text.slice(at) });
      continue;
    }
    if (child.type === "element" && !NO_PATH_TOKENS.has(child.tagName ?? "")) wrapPathTokens(child);
    children.push(child);
  }
  node.children = children;
}

/**
 * A rehype plugin: wraps each bare word in prose that could be a path in
 * `<span data-path-token="…">`, so the renderer can turn the ones that exist into file links.
 * Code, links and code blocks are left alone; inline code is checked by its own renderer.
 */
export function rehypePathTokens() {
  return (tree: HastNode) => {
    wrapPathTokens(tree);
  };
}
