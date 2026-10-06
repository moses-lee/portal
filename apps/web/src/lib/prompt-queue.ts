/**
 * Prompts taken back out of a session's queue (edited, or dropped by Stop) go into the composer,
 * as Codex's TUI restores them: each on its own line, ahead of whatever was being typed.
 */
export function restoreToDraft(texts: readonly string[], draft: string): string {
  const taken = texts.map((text) => text.trim()).filter(Boolean);
  if (taken.length === 0) return draft;
  return draft.trim() ? `${taken.join("\n")}\n${draft}` : taken.join("\n");
}

/**
 * The composer's line while a queued prompt is being edited, by its place in the queue (as the
 * list numbers it). Until the stream's queue has the prompt (just after a reload), its place is
 * not known.
 */
export function queueEditLabel(queue: readonly { id: string }[], editingId: string): string {
  const index = queue.findIndex((item) => item.id === editingId);
  return index === -1 ? "Editing a queued prompt" : `Editing queued prompt ${index + 1}`;
}
