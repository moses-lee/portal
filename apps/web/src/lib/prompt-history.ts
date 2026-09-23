/**
 * Prompt history lets the composer recall earlier messages with Up/Down, like a shell. One list per
 * conversation, oldest first, holding what the server accepted. It is a per-browser record kept in
 * localStorage, with an in-memory fallback when storage is unavailable.
 */

const prefix = "portal.history.v1:";
const memory = new Map<string, string[]>();

/** The history key of an agent session's composer. */
export const sessionHistoryKey = (sessionId: string) => `session:${sessionId}`;

/** Entries kept per conversation; older ones fall off the front. */
export const HISTORY_LIMIT = 100;

/** Read a stored list back; anything malformed is treated as empty. */
export function parseHistory(text: string | null): string[] {
  if (!text) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/** Append `text` (trimmed), skipping blanks and repeats of the newest entry. Returns the same list when nothing changed. */
export function appendHistory(entries: readonly string[], text: string, limit = HISTORY_LIMIT): readonly string[] {
  const entry = text.trim();
  if (!entry || entries.at(-1) === entry) return entries;
  return [...entries, entry].slice(-limit);
}

/**
 * Whether Up/Down should browse history rather than move the caret: only with a collapsed caret on
 * the first line (Up) or the last line (Down).
 */
export function atHistoryEdge(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: "up" | "down",
): boolean {
  if (selectionStart !== selectionEnd) return false;
  return direction === "up"
    ? !value.slice(0, selectionStart).includes("\n")
    : !value.slice(selectionEnd).includes("\n");
}

export function readPromptHistory(key: string): readonly string[] {
  try {
    const stored = localStorage.getItem(prefix + key);
    // Read storage each time so prompts sent from another tab show up.
    if (stored !== null || !memory.has(key)) return parseHistory(stored);
  } catch {
    /* Storage is optional. */
  }
  return memory.get(key) ?? [];
}

export function recordPrompt(key: string, text: string) {
  const entries = readPromptHistory(key);
  const next = appendHistory(entries, text);
  if (next === entries) return;
  memory.set(key, [...next]);
  try {
    localStorage.setItem(prefix + key, JSON.stringify(next));
  } catch {
    /* The in-memory list lasts until reload. */
  }
}

export function forgetPromptHistory(key: string) {
  memory.delete(key);
  try {
    localStorage.removeItem(prefix + key);
  } catch {
    /* Nothing stored. */
  }
}
