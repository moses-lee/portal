/** Runs the probes' commands. */
import { execFile } from "node:child_process";

/** What one command printed. `ok` is false for a non-zero exit, a timeout, or a missing program; `stdout` may still hold output. */
export type RunResult = { ok: boolean; stdout: string };

/** Runs a command with a C locale and a timeout; never throws. */
export function run(command: string, args: string[], { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      resolve({ ok: !error, stdout: typeof stdout === "string" ? stdout : "" });
    });
  });
}
