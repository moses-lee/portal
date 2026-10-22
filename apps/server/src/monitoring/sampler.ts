/**
 * The system sampler (docs/MONITORING.md): a system sample every 60 s into an in-memory ring of
 * 24 h, whether or not a browser is open (a handful of `sysctl`/`statfs` calls). Lost on restart and
 * never written to the database. Each sample is handed to `onSample`, which feeds the portal stream.
 */
import { stat, statfs } from "node:fs/promises";
import type { MonitoringVolume, SystemSample } from "@portal/contracts/monitoring";
import type { MonitoringProbe } from "./probe/index.ts";

export const SAMPLE_EVERY_MS = 60_000;
/** 24 hours of one-a-minute samples. */
export const HISTORY_LENGTH = 24 * 60;

export type SamplerOptions = {
  probe: MonitoringProbe;
  /** The folders whose volumes are sampled, Portal's home first; a volume is listed once, under the first folder on it. */
  folders(): Promise<string[]>;
  now?: () => number;
  /** 0 leaves the timer off (tests sample by hand). */
  everyMs?: number;
  onSample?(sample: SystemSample): void;
  onError?(err: unknown): void;
};

export interface Sampler {
  latest(): SystemSample | null;
  /** The ring, oldest first. */
  history(): readonly SystemSample[];
  /** Takes a sample now and adds it to the ring; null when the probe failed. */
  sample(): Promise<SystemSample | null>;
  dispose(): void;
}

/** Free and total space of the volumes holding `folders`, each volume once; folders that cannot be read are skipped. */
export async function readVolumes(folders: string[]): Promise<MonitoringVolume[]> {
  const volumes: MonitoringVolume[] = [];
  const devices = new Set<number>();
  for (const folder of folders) {
    const [info, fs] = await Promise.all([stat(folder).catch(() => null), statfs(folder).catch(() => null)]);
    if (!info || !fs || devices.has(info.dev)) continue;
    devices.add(info.dev);
    volumes.push({ path: folder, totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize });
  }
  return volumes;
}

export function createSampler({ probe, folders, now = Date.now, everyMs = SAMPLE_EVERY_MS, onSample, onError }: SamplerOptions): Sampler {
  const ring: SystemSample[] = [];
  let taking: Promise<SystemSample | null> | null = null;
  let disposed = false;

  async function take(): Promise<SystemSample | null> {
    try {
      const [system, volumes] = await Promise.all([probe.system(), folders().then(readVolumes)]);
      if (disposed) return null;
      const sample: SystemSample = { at: now(), ...system, volumes };
      ring.push(sample);
      if (ring.length > HISTORY_LENGTH) ring.splice(0, ring.length - HISTORY_LENGTH);
      onSample?.(sample);
      return sample;
    } catch (err) {
      onError?.(err);
      return null;
    }
  }

  function sample(): Promise<SystemSample | null> {
    taking ??= take().finally(() => { taking = null; });
    return taking;
  }

  const timer = everyMs > 0 ? setInterval(() => void sample(), everyMs) : null;
  timer?.unref();
  if (timer) void sample();

  return {
    latest: () => ring.at(-1) ?? null,
    history: () => ring,
    sample,
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
    },
  };
}
