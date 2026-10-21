import { isToolUIPart } from "ai";
import type { OrchestratorMessage } from "./types";

/** Text stays together until a tool call separates it. Tool-first replies never create empty bubbles. */
export function messageBubbles(parts: OrchestratorMessage["parts"]): { key: number; text: string }[] {
  const bubbles: { key: number; text: string }[] = [];
  let current: { key: number; text: string } | null = null;
  for (const [index, part] of parts.entries()) {
    if (isToolUIPart(part)) current = null;
    if (part.type !== "text" || !part.text.trim()) continue;
    if (current) current.text += `\n\n${part.text}`;
    else {
      current = { key: index, text: part.text };
      bubbles.push(current);
    }
  }
  return bubbles;
}
