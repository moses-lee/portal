import type { ShellCommand } from "./shell-types";

/** Same-origin only: Portal's existing trust boundary is its private host/network. */
export function checkSameOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }
  if (origin) {
    try {
      if (new URL(origin).host !== (req.headers.get("host") ?? new URL(req.url).host)) throw new Error();
    } catch {
      return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
    }
  }
  return null;
}

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
