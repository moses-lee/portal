/**
 * Persistence for the orchestrator: one directory of small files (see `OrchestratorStore` in
 * ./types.ts for the layout). Everything is loaded once into memory, which stays authoritative
 * afterwards, so reads are cheap; each change rewrites its whole file atomically (tmp + rename),
 * with read-modify-writes serialized per file so concurrent callers never lose each other's work.
 * An in-memory implementation shares the same behaviour for tests and disposable runtimes.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Item, ItemAction, ItemLinks, ItemPatch, OrchestratorMessage, OrchestratorStore, PullRef, TickReport, TickSnapshot, Watch, WatchPatch,
} from "./types.ts";

/** A store operation the caller got wrong; `status` is the HTTP status to answer with. */
export class OrchestratorStoreError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OrchestratorStoreError";
    this.status = status;
  }
}

export function defaultOrchestratorDir() {
  return path.join(process.env.PORTAL_HOME || path.join(os.homedir(), ".portal"), "orchestrator");
}

/** How many tick reports `ticks.json` keeps (the newest). */
export const MAX_TICK_REPORTS = 50;

/** Size cap for memory.md, in bytes of UTF-8. Longer text is truncated, not rejected. */
export const MAX_MEMORY_BYTES = 32 * 1024;

const TRUNCATION_NOTE = "\n\n[Portal truncated this file: memory is capped at 32 KiB.]";

const itemLists = new Set(["needs_you", "ideas"]);
const itemStatuses = new Set(["open", "snoozed", "resolved", "dismissed"]);
const watchStatuses = new Set(["active", "done", "cancelled"]);

/**
 * A short, URL-safe id (8 base64url characters; 48 bits). The model reads and echoes these, so
 * they are kept far shorter than UUIDs. `taken` is re-rolled against, since collisions inside one
 * file, however unlikely, would silently merge two records.
 */
export function newId(taken: (id: string) => boolean = () => false): string {
  for (;;) {
    const id = randomBytes(6).toString("base64url").slice(0, 8);
    if (!taken(id)) return id;
  }
}

/** Truncate `text` to fit MAX_MEMORY_BYTES, ending in a note so the model knows something is missing. */
export function capMemory(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_MEMORY_BYTES) return text;
  const budget = MAX_MEMORY_BYTES - Buffer.byteLength(TRUNCATION_NOTE, "utf8");
  // Cutting at a byte boundary may split a multi-byte character; decoding leaves U+FFFD there.
  const head = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8").replace(/�+$/, "");
  return head + TRUNCATION_NOTE;
}

// ---------------------------------------------------------------------------------------------
// Shape checks for records read back from hand-editable files
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

/** Minimal check: the fields the UI and the model need to address a message. Parts are trusted as written. */
export function isOrchestratorMessage(value: unknown): value is OrchestratorMessage {
  return isRecord(value) && typeof value.id === "string" && typeof value.role === "string" && Array.isArray(value.parts);
}

export function isItem(value: unknown): value is Item {
  return isRecord(value) && typeof value.id === "string" && typeof value.list === "string" && typeof value.kind === "string"
    && typeof value.title === "string" && typeof value.body === "string" && isRecord(value.links) && Array.isArray(value.actions)
    && typeof value.fingerprint === "string" && itemStatuses.has(value.status as string)
    && typeof value.createdAt === "number" && typeof value.updatedAt === "number" && isNullableNumber(value.snoozedUntil);
}

export function isWatch(value: unknown): value is Watch {
  const links = isRecord(value) ? value.links : null;
  return isRecord(value) && typeof value.id === "string" && typeof value.intent === "string" && typeof value.notes === "string"
    && watchStatuses.has(value.status as string) && isRecord(links)
    && Array.isArray(links.sessionIds) && Array.isArray(links.projectIds) && Array.isArray(links.pulls)
    && typeof value.createdAt === "number" && typeof value.updatedAt === "number" && isNullableNumber(value.lastCheckedAt);
}

// ---------------------------------------------------------------------------------------------
// Patch validation
// ---------------------------------------------------------------------------------------------

/*
 * The store is the last line of defence for `updateItem`/`updateWatch`: the API routes take a JSON
 * body and the model's tools take whatever it produced, and anything persisted verbatim that the
 * loader's guards reject would silently drop the whole record on the next start. So a patch is
 * reduced to the keys `ItemPatch`/`WatchPatch` allow (anything else is ignored), every value is
 * checked to the depth the UI relies on, and the merged record is run through the same guard the
 * loader uses before it is written.
 */

const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isOptionalString = (value: unknown): value is string | undefined => value === undefined || isString(value);

function isPullRef(value: unknown): value is PullRef {
  return isRecord(value) && isString(value.repo) && typeof value.number === "number" && isString(value.url);
}

function isItemLinks(value: unknown): value is ItemLinks {
  return isRecord(value) && isOptionalString(value.projectId) && isOptionalString(value.sessionId)
    && isOptionalString(value.watchId) && (value.pull === undefined || isPullRef(value.pull));
}

/** The string fields each action type needs; `label` (and `agentId` for start_session) are optional extras. */
const actionFields: Record<ItemAction["type"], readonly string[]> = {
  open_session: ["sessionId"],
  open_url: ["url"],
  start_session: ["projectId", "prompt"],
  send_prompt: ["sessionId", "prompt"],
  remove_worktree: ["projectId"],
  ask_portal: ["text"],
};

function isItemAction(value: unknown): value is ItemAction {
  if (!isRecord(value) || !isString(value.type) || !(value.type in actionFields)) return false;
  return actionFields[value.type as ItemAction["type"]].every((field) => isString(value[field]))
    && isOptionalString(value.label) && (value.type !== "start_session" || isOptionalString(value.agentId));
}

function isWatchLinks(value: unknown): value is Watch["links"] {
  return isRecord(value) && isStringArray(value.sessionIds) && isStringArray(value.projectIds)
    && Array.isArray(value.pulls) && value.pulls.every(isPullRef);
}

const oneOf = (values: Set<string>) => [...values].join(", ");

/** Copies the allowed keys of `input` that pass their check into a fresh patch, naming the first one that fails. */
function pickPatch<T extends object>(
  what: string,
  input: unknown,
  checks: { [K in keyof T]-?: { check: (value: unknown) => boolean; expected: string } },
): T {
  if (!isRecord(input)) throw new OrchestratorStoreError(`A ${what} patch must be a JSON object.`, 400);
  const patch: Record<string, unknown> = {};
  for (const [key, { check, expected }] of Object.entries(checks) as [string, { check: (value: unknown) => boolean; expected: string }][]) {
    if (input[key] === undefined) continue;
    if (!check(input[key])) throw new OrchestratorStoreError(`${what} patch: "${key}" must be ${expected}.`, 400);
    patch[key] = input[key];
  }
  return patch as T;
}

/** Reduce unknown input (a request body, a tool argument) to a valid `ItemPatch`, or throw a 400 `OrchestratorStoreError`. */
export function parseItemPatch(input: unknown): ItemPatch {
  return pickPatch<ItemPatch>("item", input, {
    list: { check: (v) => isString(v) && itemLists.has(v), expected: `one of ${oneOf(itemLists)}` },
    title: { check: isString, expected: "a string" },
    body: { check: isString, expected: "a string" },
    links: { check: isItemLinks, expected: "an object of projectId, sessionId, watchId (strings) and pull ({ repo, number, url })" },
    actions: { check: (v) => Array.isArray(v) && v.every(isItemAction), expected: `an array of actions of type ${Object.keys(actionFields).join(", ")} with their string fields` },
    status: { check: (v) => isString(v) && itemStatuses.has(v), expected: `one of ${oneOf(itemStatuses)}` },
    snoozedUntil: { check: isNullableNumber, expected: "a number (epoch ms) or null" },
  });
}

/** Reduce unknown input to a valid `WatchPatch`, or throw a 400 `OrchestratorStoreError`. */
export function parseWatchPatch(input: unknown): WatchPatch {
  return pickPatch<WatchPatch>("watch", input, {
    intent: { check: isString, expected: "a string" },
    notes: { check: isString, expected: "a string" },
    status: { check: (v) => isString(v) && watchStatuses.has(v), expected: `one of ${oneOf(watchStatuses)}` },
    links: { check: isWatchLinks, expected: "{ sessionIds: string[], projectIds: string[], pulls: { repo, number, url }[] }" },
    lastCheckedAt: { check: isNullableNumber, expected: "a number (epoch ms) or null" },
  });
}

export function isTickReport(value: unknown): value is TickReport {
  return isRecord(value) && typeof value.id === "string" && typeof value.reason === "string"
    && typeof value.startedAt === "number" && typeof value.finishedAt === "number" && Array.isArray(value.log);
}

export function isTickSnapshot(value: unknown): value is TickSnapshot {
  return isRecord(value) && typeof value.at === "number" && isRecord(value.sessions) && isRecord(value.pulls)
    && isRecord(value.worktrees) && Array.isArray(value.missingProjects);
}

// ---------------------------------------------------------------------------------------------
// Shared behaviour over a set of documents
// ---------------------------------------------------------------------------------------------

/** Everything the store holds, one entry per file. */
type State = {
  messages: OrchestratorMessage[];
  /** Newest first. */
  items: Item[];
  /** Newest first. */
  watches: Watch[];
  snapshot: TickSnapshot | null;
  /** Newest last, at most MAX_TICK_REPORTS. */
  ticks: TickReport[];
  memory: string;
};

type Key = keyof State;

export const emptyState = (): State => ({ messages: [], items: [], watches: [], snapshot: null, ticks: [], memory: "" });

/**
 * Run `fn` on the current value of one document and persist what it returns, then make that the
 * current value. Implementations serialize calls per key so `fn` always sees the latest value.
 */
type Commit = <K extends Key, T>(key: K, fn: (current: State[K]) => { next: State[K]; result: T }) => Promise<T>;

const now = () => Date.now();

/** A clock value strictly after `previous`, so "changed since" comparisons never miss a same-millisecond update. */
const after = (previous: number) => Math.max(now(), previous + 1);

/** Build the `OrchestratorStore` methods over `state`; how `commit` persists is the backend's business. */
function buildStore(ready: Promise<void>, state: State, commit: Commit): OrchestratorStore {
  function requireItem(items: Item[], id: string): Item {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new OrchestratorStoreError(`Unknown item "${id}".`, 404);
    return item;
  }

  function requireWatch(watches: Watch[], id: string): Watch {
    const watch = watches.find((candidate) => candidate.id === id);
    if (!watch) throw new OrchestratorStoreError(`Unknown watch "${id}".`, 404);
    return watch;
  }

  /** `snoozed` needs a wake-up time; any other status has none. */
  function checkSnooze(item: Item): Item {
    if (item.status === "snoozed") {
      if (typeof item.snoozedUntil !== "number") throw new OrchestratorStoreError("A snoozed item needs snoozedUntil.", 400);
      return item;
    }
    return item.snoozedUntil === null ? item : { ...item, snoozedUntil: null };
  }

  /** Refuse to persist a record the loader would drop on the next start; `check` is the loader's own guard. */
  function loadable<T>(what: string, record: T, check: (value: unknown) => boolean): T {
    if (!check(record)) throw new OrchestratorStoreError(`The resulting ${what} would not be readable; check the field types.`, 400);
    return record;
  }

  return {
    ready,

    async readMessages() {
      await ready;
      return [...state.messages];
    },
    writeMessages(messages) {
      return commit("messages", () => ({ next: [...messages], result: undefined }));
    },
    appendMessages(messages) {
      return commit("messages", (current) => ({ next: [...current, ...messages], result: undefined }));
    },

    async listItems() {
      await ready;
      return [...state.items];
    },
    async getItem(id) {
      await ready;
      return state.items.find((item) => item.id === id) ?? null;
    },
    async findItemByFingerprint(fingerprint) {
      await ready;
      return state.items.find((item) => item.fingerprint === fingerprint && (item.status === "open" || item.status === "snoozed")) ?? null;
    },
    createItem(input) {
      return commit("items", (items) => {
        const at = now();
        const item = loadable("item", checkSnooze({
          ...input,
          id: newId((id) => items.some((existing) => existing.id === id)),
          status: input.status ?? "open",
          snoozedUntil: input.snoozedUntil ?? null,
          createdAt: at,
          updatedAt: at,
        }), isItem);
        return { next: [item, ...items], result: item };
      });
    },
    async updateItem(id, patch) {
      // Parsed before queueing so a bad patch fails fast and never waits behind a write.
      const allowed = parseItemPatch(patch);
      return commit("items", (items) => {
        const current = requireItem(items, id);
        const item = loadable("item", checkSnooze({ ...current, ...allowed, id, createdAt: current.createdAt, updatedAt: after(current.updatedAt) }), isItem);
        return { next: items.map((existing) => (existing.id === id ? item : existing)), result: item };
      });
    },

    async listWatches() {
      await ready;
      return [...state.watches];
    },
    async getWatch(id) {
      await ready;
      return state.watches.find((watch) => watch.id === id) ?? null;
    },
    createWatch(input) {
      return commit("watches", (watches) => {
        const at = now();
        const watch: Watch = {
          id: newId((id) => watches.some((existing) => existing.id === id)),
          intent: input.intent,
          notes: input.notes,
          status: "active",
          links: input.links ?? { sessionIds: [], projectIds: [], pulls: [] },
          createdAt: at,
          updatedAt: at,
          lastCheckedAt: null,
        };
        return { next: [watch, ...watches], result: watch };
      });
    },
    async updateWatch(id, patch) {
      const allowed = parseWatchPatch(patch);
      return commit("watches", (watches) => {
        const current = requireWatch(watches, id);
        const watch = loadable("watch", { ...current, ...allowed, id, createdAt: current.createdAt, updatedAt: after(current.updatedAt) }, isWatch);
        return { next: watches.map((existing) => (existing.id === id ? watch : existing)), result: watch };
      });
    },

    async readSnapshot() {
      await ready;
      return state.snapshot;
    },
    writeSnapshot(snapshot) {
      return commit("snapshot", () => ({ next: snapshot, result: undefined }));
    },

    async listTicks() {
      await ready;
      return [...state.ticks];
    },
    appendTick(report) {
      return commit("ticks", (ticks) => ({ next: [...ticks, report].slice(-MAX_TICK_REPORTS), result: undefined }));
    },

    async readMemory() {
      await ready;
      return state.memory;
    },
    writeMemory(text) {
      return commit("memory", () => ({ next: capMemory(text), result: undefined }));
    },
  };
}

/** In-memory implementation; also what tests and disposable runtimes use. */
export function createMemoryOrchestratorStore(): OrchestratorStore {
  const state = emptyState();
  return buildStore(Promise.resolve(), state, async (key, fn) => {
    const { next, result } = fn(state[key]);
    state[key] = next;
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// File-backed implementation
// ---------------------------------------------------------------------------------------------

const files: Record<Key, string> = {
  messages: "conversation.json",
  items: "items.json",
  watches: "watches.json",
  snapshot: "snapshot.json",
  ticks: "ticks.json",
  memory: "memory.md",
};

const listChecks = { messages: isOrchestratorMessage, items: isItem, watches: isWatch, ticks: isTickReport } as const;

/**
 * Turn a file's text into its document, or null when the file is unusable as a whole (not JSON,
 * wrong top-level shape). Lists are filtered element by element: a bad record is dropped with a
 * warning rather than taking the whole list down with it, since these files are hand-editable.
 * The result is wrapped because a snapshot document is legitimately `null` before the first tick.
 */
function parseDocument<K extends Key>(key: K, text: string, file: string): { value: State[K] } | null {
  if (key === "memory") return { value: text as State[K] };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (key === "snapshot") return parsed === null || isTickSnapshot(parsed) ? { value: parsed as State[K] } : null;
  if (!Array.isArray(parsed)) return null;
  const check: (value: unknown) => boolean = listChecks[key as keyof typeof listChecks];
  const kept = parsed.filter(check);
  if (kept.length < parsed.length) console.warn(`Dropping ${parsed.length - kept.length} unreadable record(s) from ${file}.`);
  if (key === "items" || key === "watches") (kept as { createdAt: number }[]).sort((a, b) => b.createdAt - a.createdAt);
  return { value: (key === "ticks" ? kept.slice(-MAX_TICK_REPORTS) : kept) as State[K] };
}

function serializeDocument<K extends Key>(key: K, value: State[K]): string {
  return key === "memory" ? (value as string) : JSON.stringify(value, null, 2) + "\n";
}

/**
 * File-backed store under `dir` (created on first write, mode 0700; files 0600). `ready` resolves
 * once every file has been read; a file that cannot be parsed is treated as empty and moved to
 * `<name>.corrupt-<timestamp>` when that document is next written, so the user's text is kept.
 */
export function createOrchestratorStore({ dir = defaultOrchestratorDir() }: { dir?: string } = {}): OrchestratorStore {
  const state = emptyState();
  const corrupt = new Set<Key>();
  /**
   * Files that exist but could not be read (EACCES, EIO, ...), with the error. Unlike a corrupt file,
   * whose text we have and back up, an unreadable one must never be written: the in-memory default
   * would replace data we never saw. Every commit for such a key rejects with the load error.
   */
  const unreadable = new Map<Key, unknown>();

  async function loadDocument<K extends Key>(key: K) {
    const file = path.join(dir, files[key]);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return;
      unreadable.set(key, err);
      throw err;
    }
    const loaded = parseDocument(key, text, file);
    if (!loaded) {
      console.warn(`Ignoring unreadable orchestrator file ${file}; it will be backed up on the next change.`);
      corrupt.add(key);
      return;
    }
    state[key] = loaded.value;
  }

  const ready = Promise.all((Object.keys(files) as Key[]).map(loadDocument)).then(() => {});

  async function saveDocument<K extends Key>(key: K, value: State[K]) {
    const file = path.join(dir, files[key]);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (corrupt.has(key)) {
      // Keep the unreadable file for the user instead of silently overwriting it.
      await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      corrupt.delete(key);
    }
    const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
    try {
      await writeFile(tmp, serializeDocument(key, value), { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  // One chain per file so concurrent changes to a document never interleave their read-modify-write.
  const queues = new Map<Key, Promise<unknown>>();
  const commit: Commit = (key, fn) => {
    const run = (queues.get(key) ?? Promise.resolve()).then(async () => {
      // Awaited inside every commit rather than used as the chain's head: the chain swallows
      // rejections to stay usable, so a rejected `ready` would otherwise gate only the first commit
      // and the second would save the empty default over the file that could not be read.
      await ready.catch((err: unknown) => { throw unreadable.get(key) ?? err; });
      const { next, result } = fn(state[key]);
      await saveDocument(key, next);
      state[key] = next;
      return result;
    });
    queues.set(key, run.catch(() => {}));
    return run;
  };

  return buildStore(ready, state, commit);
}
