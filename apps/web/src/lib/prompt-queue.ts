/**
 * Prompts taken back out of a session's queue (edited, or dropped by Stop) go into the composer,
 * as Codex's TUI restores them: each on its own line, ahead of whatever was being typed.
 */
export function restoreToDraft(texts: readonly string[], draft: string): string {
  const taken = texts.map((text) => text.trim()).filter(Boolean);
  if (taken.length === 0) return draft;
  return draft.trim() ? `${taken.join("\n")}\n${draft}` : taken.join("\n");
}
