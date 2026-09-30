/**
 * Folding fetched pages of a Portal thread into the messages already held. The server sends fresh
 * objects every time; a message whose content did not change keeps the object already held, so the
 * memoised rows (`PortalMessage`) skip rendering. Pure, so the unit tests pin identity and order.
 *
 * The contract has no `updatedAt` on a message, and a part count misses a reply whose text grew or
 * a tool part whose input and output arrived (`toolIO` omitted, then loaded). So the key is the
 * content itself: same id, same role, same number of parts, then a structural comparison that stops
 * at the first difference. Messages are plain JSON and pages are small, so this stays cheap.
 *
 * `@ai-sdk/react`'s `setMessages` copies the array and notifies its subscribers whatever it is given,
 * so returning `current` does not spare `PortalThread` a render; what it buys is that every row
 * object is the one already held, so the memoised rows skip.
 */
import type { OrchestratorMessage } from "./types.ts";

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Structural equality over JSON-shaped values; a key holding `undefined` counts as absent, as in JSON. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  // Only arrays and plain objects are compared by content; anything else (a Date, a Map) must be the same object.
  if (!Array.isArray(a) && (!isPlainObject(a) || !isPlainObject(b))) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], other[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) if (!sameValue(left[key], right[key])) return false;
  return true;
}

/** True when `b` would draw exactly as `a`: the same message with the same content. */
export function sameMessage(a: OrchestratorMessage, b: OrchestratorMessage): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.role !== b.role || a.parts.length !== b.parts.length) return false;
  return sameValue(a, b);
}

/** `incoming`'s message, or the held one when nothing in it changed. */
function reuse(held: OrchestratorMessage | undefined, incoming: OrchestratorMessage): OrchestratorMessage {
  return held && sameMessage(held, incoming) ? held : incoming;
}

/** Whether two lists hold the same objects in the same order. */
function sameList(a: OrchestratorMessage[], b: OrchestratorMessage[]): boolean {
  return a.length === b.length && a.every((message, i) => message === b[i]);
}

/**
 * The server's page replaces what is held (the newest page on load, or a reload after a failed
 * turn): the result is `page`, in its order, but each unchanged message is the object already held.
 * Returns `current` itself when nothing changed at all (see the note above on what that buys).
 */
export function replaceWithPage(current: OrchestratorMessage[], page: OrchestratorMessage[]): OrchestratorMessage[] {
  const held = new Map(current.map((message) => [message.id, message]));
  const next = page.map((message) => reuse(held.get(message.id), message));
  return sameList(current, next) ? current : next;
}

/**
 * What arrived since the newest message held (an `?after=` page): messages already held are
 * replaced in place by the server's copy when it differs, new ones go at the end in page order.
 * Returns `current` itself when nothing changed (see the note above).
 */
export function mergeMessages(current: OrchestratorMessage[], incoming: OrchestratorMessage[]): OrchestratorMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(incoming.map((message) => [message.id, message]));
  const known = new Set<string>();
  let changed = false;
  const merged = current.map((message) => {
    known.add(message.id);
    const server = byId.get(message.id);
    if (!server) return message;
    const kept = reuse(message, server);
    if (kept !== message) changed = true;
    return kept;
  });
  const added = incoming.filter((message) => !known.has(message.id));
  if (!changed && added.length === 0) return current;
  return added.length === 0 ? merged : [...merged, ...added];
}

/** The page before the oldest message held (`?before=`), prepended; messages already held are skipped. */
export function prependOlder(current: OrchestratorMessage[], older: OrchestratorMessage[]): OrchestratorMessage[] {
  const known = new Set(current.map((message) => message.id));
  const fresh = older.filter((message) => !known.has(message.id));
  return fresh.length === 0 ? current : [...fresh, ...current];
}
