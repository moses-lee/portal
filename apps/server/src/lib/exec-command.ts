/**
 * Run a user's command through the shell with bounded output. Shared by the orchestrator's
 * run_command tool and by user scripts (script-runner.ts).
 */
import { spawn } from "node:child_process";
import { childEnv } from "./child-env.ts";

export type ExecResult = {
  /** Exit code; null when the process was killed (timeout) or could not start. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/**
 * Collects a stream into at most `maxBytes`: the first half is kept as it arrives, the last half
 * rolls, and the amount dropped in between is noted in the text. Memory stays bounded however much
 * a command prints.
 */
class BoundedOutput {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private omitted = 0;
  private readonly half: number;

  constructor(maxBytes: number) {
    this.half = Math.max(1, Math.floor(maxBytes / 2));
  }

  push(chunk: Buffer) {
    if (this.headBytes < this.half) {
      const take = chunk.subarray(0, this.half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
      if (chunk.length === 0) return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.half && this.tail.length > 0) {
      const first = this.tail[0];
      const excess = this.tailBytes - this.half;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.omitted += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.omitted += excess;
      }
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    return this.omitted > 0 ? `${head}\n[... ${this.omitted} bytes omitted ...]\n${tail}` : head + tail;
  }
}

/**
 * Run `command` through the shell (`/bin/sh` unless `shell` names another) in `cwd` with the
 * user's environment (not the dev server's), plus `env` when given.
 * The child leads its own process group so a timeout kills everything it started, not just the
 * shell. Never rejects: a timeout or a start failure is reported in the result.
 */
export function execCommand(command: string, { cwd, timeoutMs, maxBytes, env, shell = true }: { cwd: string; timeoutMs: number; maxBytes: number; env?: Record<string, string>; shell?: string | true }): Promise<ExecResult> {
  return new Promise((resolve) => {
    const stdout = new BoundedOutput(maxBytes);
    const stderr = new BoundedOutput(maxBytes);
    let timedOut = false;
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, { shell, detached: true, cwd, env: { ...childEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      // Never started (bad cwd, no shell): the message is all there is to report.
      killGroup();
      finish({ code: null, stdout: stdout.text(), stderr: [stderr.text(), err.message].filter(Boolean).join("\n"), timedOut });
    });
    child.on("close", (code) => {
      finish({ code: timedOut ? null : code, stdout: stdout.text(), stderr: stderr.text(), timedOut });
    });
  });
}
