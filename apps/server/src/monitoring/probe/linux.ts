/**
 * The Linux probe: `/proc/meminfo` and `/proc/pressure/memory` for memory, swap and pressure; RSS
 * from `ps` for process memory; `/proc/<pid>/cwd` for working folders; `ss` for listeners and
 * `docker` for a container's processes. Written from the documented formats and not yet run on
 * Linux (docs/MONITORING.md, decision 11).
 */
import { readFile, readlink } from "node:fs/promises";
import { linuxPressureLevel } from "@portal/shared/monitoring";
import { descendants } from "../../lib/process-probe.ts";
import type { MonitoringProbe } from "./index.ts";
import { run } from "./run.ts";
import { parseMeminfo, parsePsi, parseSsPids } from "./parse.ts";

export function createLinuxProbe(): MonitoringProbe {
  return {
    platform: "linux",

    async system() {
      const [meminfoText, psiText] = await Promise.all([
        readFile("/proc/meminfo", "utf8"),
        // A kernel without PSI (before 4.20, or booted with psi=0) is judged on available memory alone.
        readFile("/proc/pressure/memory", "utf8").catch(() => ""),
      ]);
      const meminfo = parseMeminfo(meminfoText);
      if (!meminfo) throw new Error("/proc/meminfo could not be read.");
      const psi = parsePsi(psiText);
      const { totalBytes, availableBytes } = meminfo;
      return {
        memory: { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes },
        swap: { totalBytes: meminfo.swapTotalBytes, usedBytes: Math.max(0, meminfo.swapTotalBytes - meminfo.swapFreeBytes) },
        pressure: {
          level: linuxPressureLevel({ ...psi, availableBytes, totalBytes }),
          raw: psiText.trim().split("\n").join("; "),
        },
      };
    },

    async processMemory() {
      return null;
    },

    async workingFolders(pids) {
      const folders = new Map<number, string>();
      await Promise.all(pids.map(async (pid) => {
        const folder = await readlink(`/proc/${pid}/cwd`).catch(() => null);
        if (folder) folders.set(pid, folder);
      }));
      return folders;
    },

    async listeningPids(port) {
      const { stdout } = await run("ss", ["-Hltnp", `sport = :${port}`]);
      return parseSsPids(stdout);
    },

    async containerPids(table, port) {
      const ids = await run("docker", ["ps", "-q", "--filter", `publish=${port}`]);
      const pids: number[] = [];
      for (const id of ids.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
        const inspect = await run("docker", ["inspect", "-f", "{{.State.Pid}}", id]);
        const pid = Number(inspect.stdout.trim());
        if (!Number.isInteger(pid) || pid <= 0) continue;
        pids.push(pid, ...descendants(table, pid).map((row) => row.pid));
      }
      return pids;
    },
  };
}
