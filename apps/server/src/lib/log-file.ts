/**
 * The server's log file (docs/MONITORING.md, "Log file"): everything the server prints to stdout
 * and stderr (the Fastify log, `console.*`, the adapters' stderr) also goes to
 * `<portalHome>/logs/server.log`, rotated at 10 MB with 5 files kept in all (`server.log` and
 * `server.log.1` to `.4`, oldest last). No dependency: one synchronous append per write, like the
 * terminal output it copies.
 *
 * The log must never take the server down, least of all when the disk is full: a failed write is
 * dropped, and the file is not tried again for a minute.
 */
import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const LOG_FILES_KEPT = 5;
const RETRY_AFTER_MS = 60_000;

export type RotatingLog = {
  write(chunk: string | Uint8Array): void;
  close(): void;
};

/** An append-only file that moves to `<file>.1` (and older ones up by one) when the next write would pass `maxBytes`. */
export function createRotatingLog(file: string, { maxBytes = LOG_ROTATE_BYTES, keep = LOG_FILES_KEPT, now = Date.now }: { maxBytes?: number; keep?: number; now?: () => number } = {}): RotatingLog {
  let fd: number | null = null;
  let size = 0;
  let failedAt: number | null = null;

  const open = (): number | null => {
    if (fd !== null) return fd;
    if (failedAt !== null && now() - failedAt < RETRY_AFTER_MS) return null;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      fd = openSync(file, "a");
      size = fstatSync(fd).size;
      failedAt = null;
      return fd;
    } catch {
      failedAt = now();
      return null;
    }
  };

  const shut = () => {
    if (fd === null) return;
    try {
      closeSync(fd);
    } catch {
      // Already gone; nothing to keep.
    }
    fd = null;
  };

  const rotate = () => {
    shut();
    rmSync(`${file}.${keep - 1}`, { force: true });
    for (let n = keep - 2; n >= 1; n--) {
      try {
        renameSync(`${file}.${n}`, `${file}.${n + 1}`);
      } catch {
        // That generation does not exist yet.
      }
    }
    if (keep > 1) renameSync(file, `${file}.1`);
    else rmSync(file, { force: true });
  };

  return {
    write(chunk) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (bytes.length === 0 || open() === null) return;
      try {
        if (size > 0 && size + bytes.length > maxBytes) {
          rotate();
          if (open() === null) return;
        }
        writeSync(fd!, bytes);
        size += bytes.length;
      } catch {
        shut();
        failedAt = now();
      }
    },
    close: shut,
  };
}

/**
 * Copy everything written to stdout and stderr into `log` as well. Returns the function that puts
 * the streams back. The terminal still gets every write first-hand.
 */
export function teeProcessOutput(log: RotatingLog, streams: NodeJS.WriteStream[] = [process.stdout, process.stderr]): () => void {
  const restores = streams.map((stream) => {
    const original = stream.write;
    stream.write = function write(this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
      if (typeof chunk === "string") {
        const encoding = typeof rest[0] === "string" ? rest[0] as BufferEncoding : "utf8";
        log.write(encoding === "utf8" ? chunk : Buffer.from(chunk, encoding));
      } else if (chunk instanceof Uint8Array) {
        log.write(chunk);
      }
      return (original as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
    } as NodeJS.WriteStream["write"];
    return () => { stream.write = original; };
  });
  return () => {
    for (const restore of restores) restore();
  };
}
