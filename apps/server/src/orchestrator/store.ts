/**
 * Record rules for the orchestrator store, shared by every backend: ids, the memory cap, shape
 * guards, patch validation, and how a new or patched item is built. The in-memory store here
 * backs tests and disposable runtimes; the Postgres store (`src/orchestrator/pg-store.ts`) applies
 * the same rules so a backend swap cannot change behaviour.
 */
import { randomBytes } from "node:crypto";
import type {
  Item, ItemAction, ItemKind, ItemLinks, ItemPatch, OrchestratorMessage, OrchestratorStore, PullRef, Scope, TickSnapshot,
} from "./types.ts";
import type { LegacyTickReport } from "./jobs/legacy.ts";
import { emptyScope } from "./types.ts";

/** A store operation the caller got wrong; `status` is the HTTP status to answer with. */
export class OrchestratorStoreError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OrchestratorStoreError";
    this.status = status;
  }
}

/** Size cap for the memory text, in bytes of UTF-8. Longer text is truncated, not rejected. */
export const MAX_MEMORY_BYTES = 32 * 1024;

const TRUNCATION_NOTE = "\n\n[Portal truncated this file: memory is capped at 32 KiB.]";

/** Every item kind; a patch may move an item to another kind as its condition changes. */
export const itemKinds = [
  "session_finished", "session_stopped", "session_waiting", "session_offline", "session_hung", "pr_checks_failing", "pr_changes_requested", "pr_conflicts",
  "pr_review_requested", "pr_merged", "pr_closed", "worktree_merged", "worktree_dirty", "folder_missing", "watch_update", "intent_update", "review_findings",
  "approval_needed", "memory_reconfirm", "custom",
] as const satisfies readonly ItemKind[];
const itemKindSet = new Set<string>(itemKinds);
/**
 * Kinds nothing creates any more: the session states they raised show live in the workspace.
 * Old rows keep them; `create_item` and `update_item` refuse them.
 */
export const retiredItemKinds = ["session_finished", "session_stopped", "session_waiting", "session_offline", "session_hung"] as const satisfies readonly ItemKind[];
const itemStatuses = new Set(["open", "snoozed", "resolved", "dismissed"]);

/**
 * A short, URL-safe id (8 base64url characters; 48 bits). The model reads and echoes these, so
 * they are kept far shorter than UUIDs. `taken` is re-rolled against, since collisions inside one
 * table, however unlikely, would silently merge two records.
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
// Shape checks for stored records (and for records imported from the old JSON files)
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

/** For patches: the column is a bigint, so a fractional or out-of-range time is a 400, not a database error. */
function isNullableEpoch(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

/** Minimal check: the fields the UI and the model need to address a message. Parts are trusted as written. */
export function isOrchestratorMessage(value: unknown): value is OrchestratorMessage {
  return isRecord(value) && typeof value.id === "string" && typeof value.role === "string" && Array.isArray(value.parts);
}

export function isItem(value: unknown): value is Item {
  return isRecord(value) && typeof value.id === "string" && typeof value.kind === "string"
    && typeof value.title === "string" && typeof value.body === "string" && isRecord(value.links) && Array.isArray(value.actions)
    && typeof value.fingerprint === "string" && itemStatuses.has(value.status as string)
    && typeof value.createdAt === "number" && typeof value.updatedAt === "number" && isNullableNumber(value.snoozedUntil);
}

// ---------------------------------------------------------------------------------------------
// Patch validation
// ---------------------------------------------------------------------------------------------

/*
 * The store is the last line of defence for `updateItem`: the API routes take a JSON
 * body and the model's tools take whatever it produced, and a record the guards below reject would
 * break the page and the model's reads of it (and the file store used to drop it). So a patch is
 * reduced to the keys `ItemPatch` allows (anything else is ignored), every value is
 * checked to the depth the UI relies on, and the merged record is run through the same guard
 * before it is written.
 */

const isString = (value: unknown): value is string => typeof value === "string";
const isOptionalString = (value: unknown): value is string | undefined => value === undefined || isString(value);

function isPullRef(value: unknown): value is PullRef {
  return isRecord(value) && isString(value.repo) && typeof value.number === "number" && isString(value.url);
}

function isItemLinks(value: unknown): value is ItemLinks {
  return isRecord(value) && isOptionalString(value.projectId) && isOptionalString(value.sessionId)
    && isOptionalString(value.intentId) && isOptionalString(value.jobId) && isOptionalString(value.approvalId)
    && (value.pull === undefined || isPullRef(value.pull));
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
    kind: { check: (v) => isString(v) && itemKindSet.has(v), expected: `one of ${oneOf(itemKindSet)}` },
    title: { check: isString, expected: "a string" },
    body: { check: isString, expected: "a string" },
    links: { check: isItemLinks, expected: "an object of projectId, sessionId, intentId, jobId, approvalId (strings) and pull ({ repo, number, url })" },
    actions: { check: (v) => Array.isArray(v) && v.every(isItemAction), expected: `an array of actions of type ${Object.keys(actionFields).join(", ")} with their string fields` },
    status: { check: (v) => isString(v) && itemStatuses.has(v), expected: `one of ${oneOf(itemStatuses)}` },
    snoozedUntil: { check: isNullableEpoch, expected: "an integer (epoch ms) or null" },
  });
}

export function isTickReport(value: unknown): value is LegacyTickReport {
  return isRecord(value) && typeof value.id === "string" && typeof value.reason === "string"
    && typeof value.startedAt === "number" && typeof value.finishedAt === "number" && Array.isArray(value.log);
}

export function isTickSnapshot(value: unknown): value is TickSnapshot {
  return isRecord(value) && typeof value.at === "number" && isRecord(value.sessions) && isRecord(value.pulls)
    && isRecord(value.worktrees) && Array.isArray(value.missingProjects);
}

// ---------------------------------------------------------------------------------------------
// Building records (shared by the backends)
// ---------------------------------------------------------------------------------------------

export type ItemInput = Parameters<OrchestratorStore["createItem"]>[0];

export const unknownItem = (id: string) => new OrchestratorStoreError(`Unknown item "${id}".`, 404);

/** A clock value strictly after `previous`, so "changed since" comparisons never miss a same-millisecond update. */
const after = (previous: number) => Math.max(Date.now(), previous + 1);

/** `snoozed` needs a wake-up time; any other status has none. */
function checkSnooze(item: Item): Item {
  if (item.status === "snoozed") {
    if (typeof item.snoozedUntil !== "number") throw new OrchestratorStoreError("A snoozed item needs snoozedUntil.", 400);
    return item;
  }
  return item.snoozedUntil === null ? item : { ...item, snoozedUntil: null };
}

/** Refuse to persist a record the guards reject; `check` is the same guard the rest of the store trusts. */
function loadable<T>(what: string, record: T, check: (value: unknown) => boolean): T {
  if (!check(record)) throw new OrchestratorStoreError(`The resulting ${what} would not be readable; check the field types.`, 400);
  return record;
}

/** A new item from `createItem` input, with defaults filled and validated. */
export function buildItem(input: ItemInput, id: string, at = Date.now()): Item {
  return loadable("item", checkSnooze({
    ...input,
    id,
    status: input.status ?? "open",
    snoozedUntil: input.snoozedUntil ?? null,
    createdAt: at,
    updatedAt: at,
  }), isItem);
}

/** `current` with an already-parsed patch applied; identity and creation time are kept, `updatedAt` advances. */
export function patchItem(current: Item, allowed: ItemPatch): Item {
  return loadable("item", checkSnooze({ ...current, ...allowed, id: current.id, createdAt: current.createdAt, updatedAt: after(current.updatedAt) }), isItem);
}

/** `partial` over an empty scope, every list copied and deduplicated. */
export function normalizeScope(partial: Partial<Scope> | undefined): Scope {
  const scope = emptyScope();
  if (!partial) return scope;
  const unique = <T>(values: T[] | undefined, key: (value: T) => string) => {
    const seen = new Set<string>();
    return (values ?? []).filter((value) => {
      const k = key(value);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const same = (value: string) => value;
  return {
    projectIds: unique(partial.projectIds, same),
    sessionIds: unique(partial.sessionIds, same),
    pulls: unique(partial.pulls, (pull) => `${pull.repo}#${pull.number}`),
    repos: unique(partial.repos, same),
    people: unique(partial.people, same),
    taskTypes: unique(partial.taskTypes, same),
  };
}

/** Whether an item still stands for its condition, so a new one with the same fingerprint updates it rather than creating another. */
export const isLive = (item: Item) => item.status === "open" || item.status === "snoozed";

// ---------------------------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------------------------

/** In-memory implementation; what tests and disposable runtimes use. Every change is synchronous, so no queueing is needed. */
export function createMemoryOrchestratorStore(): OrchestratorStore {
  /** Rows with ordinals, as the database numbers them. */
  let rows: { ordinal: number; message: OrchestratorMessage }[] = [];
  let nextOrdinal = 1;
  const insert = (next: OrchestratorMessage[]) => {
    rows = [...rows, ...next.map((message) => ({ ordinal: nextOrdinal++, message }))];
  };
  /** Newest first. */
  let items: Item[] = [];
  let snapshot: TickSnapshot | null = null;
  let memory = "";

  function requireItem(id: string): Item {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw unknownItem(id);
    return item;
  }

  return {
    ready: Promise.resolve(),

    async readMessages() {
      return rows.map((row) => row.message);
    },
    async readMessageRows() {
      return rows.map((row) => ({ ...row }));
    },
    async readMessagePage({ before, after, limit }) {
      const matching = rows.filter((row) => (before === undefined || row.ordinal < before) && (after === undefined || row.ordinal > after));
      const forwards = after !== undefined && before === undefined;
      const hasMore = matching.length > limit;
      const page = forwards ? matching.slice(0, limit) : matching.slice(Math.max(0, matching.length - limit));
      return { messages: page.map((row) => row.message), hasMore, before: page[0]?.ordinal ?? null, after: page.at(-1)?.ordinal ?? null };
    },
    async getMessage(id) {
      return rows.find((row) => row.message.id === id)?.message ?? null;
    },
    async writeMessages(next) {
      rows = [];
      insert(next);
    },
    async appendMessages(next) {
      insert(next);
    },
    async deleteMessagesThrough(ordinal) {
      rows = rows.filter((row) => row.ordinal > ordinal);
    },
    async replaceMessage(ordinal, message) {
      rows = rows.map((row) => (row.ordinal === ordinal ? { ordinal, message } : row));
    },

    async listItems(filter) {
      return filter?.status ? items.filter((item) => filter.status!.includes(item.status)) : [...items];
    },
    async getItem(id) {
      return items.find((item) => item.id === id) ?? null;
    },
    async findItemByFingerprint(fingerprint) {
      return items.find((item) => item.fingerprint === fingerprint && isLive(item)) ?? null;
    },
    async createItem(input) {
      const item = buildItem(input, newId((id) => items.some((existing) => existing.id === id)));
      items = [item, ...items];
      return item;
    },
    async updateItem(id, patch) {
      const allowed = parseItemPatch(patch);
      const item = patchItem(requireItem(id), allowed);
      items = items.map((existing) => (existing.id === id ? item : existing));
      return item;
    },

    async readSnapshot() {
      return snapshot;
    },
    async writeSnapshot(next) {
      snapshot = next;
    },

    async readMemory() {
      return memory;
    },
    async writeMemory(text) {
      memory = capMemory(text);
    },
  };
}
