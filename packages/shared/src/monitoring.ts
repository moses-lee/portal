/**
 * Monitoring's pure logic (docs/MONITORING.md), shared by the server (the probes, the stream
 * summary) and the web (the view's tiles, the room's barometer and jar): one pressure scale across
 * operating systems, and the level of a disk reading. The levels here are fixed in code; only the
 * disk levels are the user's (`monitoring.disk` in settings.ts).
 */
import type { MonitoringLevel } from "@portal/contracts/monitoring";

/** Disk levels are set in GB, decimal as macOS's Finder counts them. */
export const BYTES_PER_GB = 1e9;

/**
 * "16 GB", "9.8 GB", "350 MB", "12 KB", "—" for null. Memory counts in binary units, as Activity
 * Monitor does (a 16 GB Mac reads 16 GB); disk in decimal ones, as Finder and the disk levels do.
 * The one formatter for every place a size is shown (the Monitoring view, the room's cards), so
 * they read the same.
 */
export function formatBytes(bytes: number | null | undefined, kind: "memory" | "disk" = "disk"): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const step = kind === "memory" ? 1024 : 1000;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= step && unit < units.length - 1) {
    value /= step;
    unit++;
  }
  // Below 10 one decimal says something; above it the decimal is noise.
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[unit]}`;
}

/**
 * macOS's `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. Anything else
 * (an older kernel, a read that failed) reads as normal, so a broken read never paints the view red.
 */
export function darwinPressureLevel(value: number): MonitoringLevel {
  if (value === 4) return "critical";
  if (value === 2) return "warning";
  return "normal";
}

/** What the Linux mapping reads: PSI averages from `/proc/pressure/memory` (null on a kernel without PSI) and `/proc/meminfo`. */
export type LinuxPressureInput = {
  someAvg10: number | null;
  fullAvg10: number | null;
  availableBytes: number;
  totalBytes: number;
};

/**
 * Linux pressure on the shared scale: critical when `full avg10` is at least 10 or less than 5 %
 * of memory is available; warning when `some avg10` is at least 10 or less than 10 % is
 * available; normal otherwise. A kernel without PSI is judged on available memory alone.
 */
export function linuxPressureLevel({ someAvg10, fullAvg10, availableBytes, totalBytes }: LinuxPressureInput): MonitoringLevel {
  const available = totalBytes > 0 ? availableBytes / totalBytes : 1;
  if ((fullAvg10 ?? 0) >= 10 || available < 0.05) return "critical";
  if ((someAvg10 ?? 0) >= 10 || available < 0.1) return "warning";
  return "normal";
}

/** The disk levels as settings hold them. */
export type DiskLevels = { warnFreeGb: number; criticalFreeGb: number };

/** The level of a volume with `freeBytes` free: critical below the critical level, warning below the warning one. */
export function diskLevel(freeBytes: number, { warnFreeGb, criticalFreeGb }: DiskLevels): MonitoringLevel {
  if (freeBytes < criticalFreeGb * BYTES_PER_GB) return "critical";
  if (freeBytes < warnFreeGb * BYTES_PER_GB) return "warning";
  return "normal";
}

/** `~` or a leading `~/` replaced by `home`; any other path as given. */
export function expandHome(folder: string, home: string): string {
  if (folder === "~") return home;
  if (folder.startsWith("~/")) return home.replace(/\/+$/, "") + folder.slice(1);
  return folder;
}
