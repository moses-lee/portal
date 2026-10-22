/**
 * The macOS probe: `vm_stat` and `sysctl` for memory, swap and pressure; footprint from `top`
 * (what Activity Monitor and jetsam use: RSS undercounts idle agents, which macOS compresses);
 * `lsof` for working folders and listeners.
 */
import os from "node:os";
import { darwinPressureLevel } from "@portal/shared/monitoring";
import type { ProcessTable } from "../../lib/process-probe.ts";
import type { MonitoringProbe } from "./index.ts";
import { run } from "./run.ts";
import { parseLsofCwd, parseLsofNames, parseLsofPids, parseSwapUsage, parseTopMemory, parseVmStat, sysctlValue } from "./parse.ts";

/** The container runtimes whose VM can be told apart, and how each shows in a command line. */
export type ContainerRuntime = "docker" | "lima" | "orbstack" | "podman";
const RUNTIME_COMMANDS: [ContainerRuntime, RegExp][] = [
  ["docker", /Docker\.app\/|\bcom\.docker\./],
  ["lima", /\blimactl\b|\bcolima\b|\/\.colima\/|\/\.lima\//],
  ["orbstack", /OrbStack/],
  ["podman", /\bpodman\b|\bgvproxy\b|\bvfkit\b|\bkrunkit\b/],
];
/** Files only that runtime's VM holds open (its disk images), for a Virtualization.framework VM, which runs under launchd and names nothing. */
const RUNTIME_FILES: Record<ContainerRuntime, RegExp> = {
  docker: /\/com\.docker\.docker\/|\/Docker\.raw$|\/\.docker\//,
  lima: /\/\.colima\/|\/\.lima\//,
  orbstack: /\/\.orbstack\/|\/OrbStack\//,
  podman: /\/containers\/podman\/|podman-machine/,
};
/** A Virtualization.framework VM (Docker Desktop, Colima/Lima with `vz`, Podman, but also any other app's VM). */
const VZ_VM = /com\.apple\.Virtualization\.VirtualMachine/;
/** VM processes that a runtime starts as its own child, or that name it. */
const RUNTIME_VM = /com\.docker\.hyperkit|\bqemu-system-\w+|\bvfkit\b|\bkrunkit\b|OrbStack Helper/;

/** The container runtime `pid` belongs to, from its own command line or an ancestor's; null when none is known. */
export function containerRuntimeOf(table: ProcessTable, pid: number): ContainerRuntime | null {
  const seen = new Set<number>();
  for (let row = table.rows.get(pid); row && row.pid > 1 && !seen.has(row.pid); row = table.rows.get(row.ppid)) {
    seen.add(row.pid);
    const match = RUNTIME_COMMANDS.find(([, pattern]) => pattern.test(row!.command));
    if (match) return match[0];
  }
  return null;
}

/**
 * The VM processes of the container runtime that serves the database port: the runtime is the one
 * the port's listener belongs to (its command line or an ancestor's), and a VM counts only when it
 * is that runtime's: by its own command line or ancestors, or, for a Virtualization.framework VM,
 * by the runtime's disk images among its open files (`openFiles`). Another app's VM, or any VM when
 * the listener is not a known runtime's, is not Portal's.
 */
export async function containerVmPids(
  table: ProcessTable,
  listenerPids: number[],
  openFiles: (pids: number[]) => Promise<Map<number, string[]>>,
): Promise<number[]> {
  const runtime = listenerPids.map((pid) => containerRuntimeOf(table, pid)).find((found) => found !== null) ?? null;
  if (!runtime) return [];
  const pids: number[] = [];
  const unnamed: number[] = [];
  for (const row of table.rows.values()) {
    const vz = VZ_VM.test(row.command);
    if (!vz && !RUNTIME_VM.test(row.command)) continue;
    const owner = containerRuntimeOf(table, row.pid);
    if (owner === runtime) pids.push(row.pid);
    else if (owner === null && vz) unnamed.push(row.pid);
  }
  if (unnamed.length > 0) {
    const files = await openFiles(unnamed).catch(() => new Map<number, string[]>());
    for (const pid of unnamed) if (files.get(pid)?.some((name) => RUNTIME_FILES[runtime].test(name))) pids.push(pid);
  }
  return pids;
}

/** lsof is given this many pids per call, well under the argument limit. */
const LSOF_BATCH = 500;

export function createDarwinProbe(): MonitoringProbe {
  return {
    platform: "darwin",

    async system() {
      const [vm, ctl] = await Promise.all([run("vm_stat", []), run("sysctl", ["vm.swapusage", "kern.memorystatus_vm_pressure_level"])]);
      const memory = parseVmStat(vm.stdout, os.totalmem());
      if (!memory) throw new Error("vm_stat could not be read.");
      const swapText = sysctlValue(ctl.stdout, "vm.swapusage");
      const swap = (swapText ? parseSwapUsage(swapText) : null) ?? { totalBytes: 0, usedBytes: 0 };
      const raw = sysctlValue(ctl.stdout, "kern.memorystatus_vm_pressure_level") ?? "";
      return { memory, swap, pressure: { level: darwinPressureLevel(Number(raw)), raw } };
    },

    async processMemory() {
      const top = await run("top", ["-l", "1", "-stats", "pid,mem"], { timeoutMs: 15_000 });
      const memory = parseTopMemory(top.stdout);
      return memory && memory.size > 0 ? memory : null;
    },

    async workingFolders(pids) {
      const folders = new Map<number, string>();
      for (let i = 0; i < pids.length; i += LSOF_BATCH) {
        const batch = pids.slice(i, i + LSOF_BATCH);
        const { stdout } = await run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", batch.join(",")]);
        for (const [pid, folder] of parseLsofCwd(stdout)) folders.set(pid, folder);
      }
      return folders;
    },

    async listeningPids(port) {
      const { stdout } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
      return parseLsofPids(stdout);
    },

    async containerPids(table: ProcessTable, _port: number, listenerPids: number[]) {
      return containerVmPids(table, listenerPids, async (pids) => {
        const { stdout } = await run("lsof", ["-Fpn", "-p", pids.join(",")]);
        return parseLsofNames(stdout);
      });
    },
  };
}
