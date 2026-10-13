import type { ToolCallUpdate } from "@agentclientprotocol/sdk";

/** Codex's negotiated terminal output channel carries appends, including repeated equal chunks. */
export function terminalOutputDelta(update: ToolCallUpdate): string | null {
  const chunk = update._meta?.terminal_output_delta;
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return null;
  return "terminal_id" in chunk && chunk.terminal_id === update.toolCallId
    && "data" in chunk && typeof chunk.data === "string" ? chunk.data : null;
}
