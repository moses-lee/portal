import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Inspect the host shell itself; never infer directories from command text or output. */
export async function readShellCwd(pid: number): Promise<string> {
  if (process.platform === "linux") return readlink(`/proc/${pid}/cwd`);
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", [
      "-a", "-p", String(pid), "-d", "cwd", "-Fn0",
    ], { timeout: 2000, maxBuffer: 64 * 1024 });
    const name = stdout.split("\0").find((field) => field.startsWith("n/"));
    if (name) return name.slice(1);
    throw new Error("The shell's working directory could not be read.");
  }
  throw new Error("Shell directory tracking requires macOS or Linux.");
}
