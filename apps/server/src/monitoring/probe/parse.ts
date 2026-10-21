/**
 * Parsers for what the probes read (docs/MONITORING.md, Probe). Pure, so the tests feed them
 * captured output: macOS's `vm_stat`, `sysctl`, `top -l 1 -stats pid,mem`, `lsof -F`, and Linux's
 * `/proc/meminfo`, `/proc/pressure/memory` and `ss -ltnp`. Each skips what it cannot read rather
 * than throwing, and says null when nothing usable was there.
 */

const UNIT_BYTES: Record<string, number> = { "": 1, B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** Bytes from a size such as `2048.00M`, `3360K`, `1.2G` or `512`; NaN for anything else. */
export function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)([BKMGT]?)$/i.exec(text.trim());
  if (!match) return NaN;
  return Math.round(Number(match[1]) * UNIT_BYTES[match[2].toUpperCase()]);
}

/**
 * macOS memory from `vm_stat`: available is free + inactive + speculative + purgeable pages, at the
 * page size `vm_stat` names in its header; used is the rest of `totalBytes`. Null when a count is missing.
 */
export function parseVmStat(text: string, totalBytes: number): { totalBytes: number; availableBytes: number; usedBytes: number } | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!pageSize) return null;
  const pages = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (match) pages.set(match[1].trim().toLowerCase(), Number(match[2]));
  }
  const counts = ["pages free", "pages inactive", "pages speculative", "pages purgeable"].map((name) => pages.get(name));
  if (counts.some((count) => count === undefined)) return null;
  const availableBytes = Math.min(totalBytes, counts.reduce<number>((sum, count) => sum + count!, 0) * pageSize);
  return { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes };
}

/** One `sysctl` value by name from `name: value` lines (as `sysctl a b` prints them); null when absent. */
export function sysctlValue(text: string, name: string): string | null {
  for (const line of text.split("\n")) {
    const index = line.indexOf(":");
    if (index > 0 && line.slice(0, index).trim() === name) return line.slice(index + 1).trim();
  }
  return null;
}

/** macOS swap from `vm.swapusage` (`total = 2048.00M  used = 504.81M  free = …`); null when unreadable. */
export function parseSwapUsage(value: string): { totalBytes: number; usedBytes: number } | null {
  const total = /total\s*=\s*(\S+)/.exec(value)?.[1];
  const used = /used\s*=\s*(\S+)/.exec(value)?.[1];
  if (!total || !used) return null;
  const totalBytes = parseSize(total);
  const usedBytes = parseSize(used);
  return Number.isFinite(totalBytes) && Number.isFinite(usedBytes) ? { totalBytes, usedBytes } : null;
}

/**
 * Footprint by pid from `top -l 1 -stats pid,mem`: the rows after the `PID MEM` header, each a pid
 * and a size with an optional unit and a trailing `+`/`-` (top's trend marker). Null when there is no header.
 */
export function parseTopMemory(text: string): Map<number, number> | null {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => /^\s*PID\s+MEM\s*$/.test(line));
  if (header < 0) return null;
  const memory = new Map<number, number>();
  for (const line of lines.slice(header + 1)) {
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?[BKMGT]?)[+-]?\s*$/i.exec(line);
    if (!match) continue;
    const bytes = parseSize(match[2]);
    if (Number.isFinite(bytes)) memory.set(Number(match[1]), bytes);
  }
  return memory;
}

/**
 * Working folders by pid from `lsof -a -d cwd -Fpn`: a `p<pid>` line opens each process and its
 * `n<path>` line names the folder. lsof exits non-zero when it could not read some of the
 * processes (another user's), so callers parse whatever it printed.
 */
export function parseLsofCwd(text: string): Map<number, string> {
  const folders = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || null;
    else if (line.startsWith("n") && pid !== null && !folders.has(pid)) folders.set(pid, line.slice(1));
  }
  return folders;
}

/** Every name (`n<path>` line) by pid from `lsof -Fpn` output: the files, folders and sockets each process holds. */
export function parseLsofNames(text: string): Map<number, string[]> {
  const names = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || null;
    else if (line.startsWith("n") && pid !== null) names.set(pid, [...(names.get(pid) ?? []), line.slice(1)]);
  }
  return names;
}

/** Pids from `lsof -Fp` output (`p<pid>` lines), without repeats. */
export function parseLsofPids(text: string): number[] {
  const pids = new Set<number>();
  for (const line of text.split("\n")) {
    const pid = line.startsWith("p") ? Number(line.slice(1)) : NaN;
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Pids from `ss -Hltnp` output (`users:(("postgres",pid=123,fd=5))`), without repeats. */
export function parseSsPids(text: string): number[] {
  const pids = new Set<number>();
  for (const match of text.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
  return [...pids];
}

export type Meminfo = { totalBytes: number; availableBytes: number; swapTotalBytes: number; swapFreeBytes: number };

/**
 * Linux memory from `/proc/meminfo` (values in kB). `MemAvailable` is used where the kernel has it
 * (3.14 on); older kernels get free + buffers + cached. Null without `MemTotal`.
 */
export function parseMeminfo(text: string): Meminfo | null {
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?\s*$/.exec(line.trim());
    if (match) fields.set(match[1], Number(match[2]) * 1024);
  }
  const totalBytes = fields.get("MemTotal");
  if (totalBytes === undefined) return null;
  const availableBytes = fields.get("MemAvailable")
    ?? (fields.get("MemFree") ?? 0) + (fields.get("Buffers") ?? 0) + (fields.get("Cached") ?? 0);
  return {
    totalBytes,
    availableBytes: Math.min(totalBytes, availableBytes),
    swapTotalBytes: fields.get("SwapTotal") ?? 0,
    swapFreeBytes: fields.get("SwapFree") ?? 0,
  };
}

/**
 * The 10-second averages from `/proc/pressure/memory`:
 *   some avg10=0.00 avg60=0.00 avg300=0.00 total=0
 *   full avg10=0.00 avg60=0.00 avg300=0.00 total=0
 * A missing line reads as null.
 */
export function parsePsi(text: string): { someAvg10: number | null; fullAvg10: number | null } {
  const avg10 = (kind: string) => {
    const value = new RegExp(`^${kind}\\s.*\\bavg10=(\\d+(?:\\.\\d+)?)`, "m").exec(text)?.[1];
    return value === undefined ? null : Number(value);
  };
  return { someAvg10: avg10("some"), fullAvg10: avg10("full") };
}
