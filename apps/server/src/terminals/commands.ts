import type { ShellCommand } from "../lib/shell-types.ts";

/** Validates one Socket.IO `command` payload; throws with a message the viewer shows. */
export function parseShellCommand(value: unknown): ShellCommand {
  const command = value as Record<string, unknown> | null;
  if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("Invalid shell command.");
  if (command.action === "start" && (command.id === null || typeof command.id === "string")) {
    return { action: "start", id: command.id };
  }
  if (typeof command.id !== "string") throw new Error("Missing shell ID.");
  if (command.action === "input" && typeof command.data === "string" && command.data.length <= 16 * 1024) {
    return { action: "input", id: command.id, data: command.data };
  }
  if (command.action === "resize" && Number.isInteger(command.cols) && Number.isInteger(command.rows)
    && Number(command.cols) >= 2 && Number(command.cols) <= 500
    && Number(command.rows) >= 1 && Number(command.rows) <= 200) {
    return { action: "resize", id: command.id, cols: Number(command.cols), rows: Number(command.rows) };
  }
  throw new Error("Invalid shell command.");
}
