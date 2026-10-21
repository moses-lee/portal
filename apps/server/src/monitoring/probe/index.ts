/**
 * The probe (docs/MONITORING.md, Probe): one interface, a macOS and a Linux implementation chosen
 * by `process.platform`, and null on every other OS (the view then says "Not supported on this OS").
 * What is the same on both (the process table from `ps`, free disk from `statfs`) is not here: see
 * `lib/process-probe.ts` and `sampler.ts`.
 */
import type { SystemSample } from "@portal/contracts/monitoring";
import type { ProcessTable } from "../../lib/process-probe.ts";
import { createDarwinProbe } from "./darwin.ts";
import { createLinuxProbe } from "./linux.ts";

export interface MonitoringProbe {
  platform: "darwin" | "linux";
  /** Memory, swap and pressure now. Throws when the OS would not say. */
  system(): Promise<Pick<SystemSample, "memory" | "swap" | "pressure">>;
  /** Memory by pid where the OS measures better than `ps`'s RSS (footprint on macOS); null to use RSS. */
  processMemory(): Promise<Map<number, number> | null>;
  /** Working folders of `pids`; a process whose folder cannot be read is left out. */
  workingFolders(pids: number[]): Promise<Map<number, string>>;
  /** Processes listening on TCP `port` on this host. */
  listeningPids(port: number): Promise<number[]>;
  /**
   * The host processes that run a container publishing `port`, beyond the listener: on macOS the VM
   * of the container runtime the listener (`listenerPids`) belongs to (every container runs inside
   * it); on Linux the container's own processes, found through `docker` whether or not a listener
   * was seen (a root-owned `docker-proxy` is not shown to `ss`). Empty when none.
   */
  containerPids(table: ProcessTable, port: number, listenerPids: number[]): Promise<number[]>;
}

export function createProbe(platform: NodeJS.Platform = process.platform): MonitoringProbe | null {
  if (platform === "darwin") return createDarwinProbe();
  if (platform === "linux") return createLinuxProbe();
  return null;
}
