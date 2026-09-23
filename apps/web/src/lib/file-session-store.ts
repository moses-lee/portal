/**
 * File-backed session store: `<dir>/index.json` holds every session's metadata (rewritten
 * atomically like `projects.json`), and `<dir>/logs/<id>.jsonl` holds that session's events, one
 * JSON line each, appended as they happen. Pages are read backwards from the end in fixed-size
 * chunks, so serving "the latest page" never reads the whole log.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSessionRecord, isStoredEvent, type SessionRecord, type SessionStore, type TailQuery, type TailResult } from "./session-store.ts";
import type { StoredEvent } from "./types.ts";

export function defaultSessionsDir() {
  return path.join(process.env.PORTAL_HOME || path.join(os.homedir(), ".portal"), "sessions");
}

type IndexFile = { version: 1; sessions: SessionRecord[] };

function parseIndex(text: string): SessionRecord[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const file = parsed as Partial<IndexFile> | null;
  if (!file || typeof file !== "object" || file.version !== 1 || !Array.isArray(file.sessions)) return null;
  return file.sessions.every(isSessionRecord) ? file.sessions : null;
}

const NEWLINE = 0x0a;

/** Per-session log state, created on first use. */
type Log = {
  file: string;
  /** Resolves with the next seq after the file has been inspected (and a torn tail trimmed). */
  opened: Promise<number>;
  /** One past the highest seq on disk. */
  count: number;
  handle: FileHandle | null;
  /** One chain per log so appends land in order. */
  queue: Promise<unknown>;
  /** Byte offset of the line holding a given seq, for the seqs pages have started at. */
  offsets: Map<number, number>;
  /** Set once the log is deleted or the store disposed; later appends are rejected instead of hitting a closed handle. */
  closed: boolean;
};

export function createFileSessionStore({ dir = defaultSessionsDir(), chunkSize = 64 * 1024 }: { dir?: string; chunkSize?: number } = {}): SessionStore {
  const indexFile = path.join(dir, "index.json");
  const logsDir = path.join(dir, "logs");
  let sessions = new Map<string, SessionRecord>();
  let corrupt = false;
  const logs = new Map<string, Log>();

  async function load() {
    let text: string;
    try {
      text = await readFile(indexFile, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return;
      throw err;
    }
    const loaded = parseIndex(text);
    if (!loaded) {
      console.warn(`Ignoring unreadable sessions index ${indexFile}; it will be backed up on the next change.`);
      corrupt = true;
      return;
    }
    sessions = new Map(loaded.map((record) => [record.id, record]));
  }
  const ready = load();

  async function saveIndex(next: Map<string, SessionRecord>) {
    await mkdir(dir, { recursive: true });
    if (corrupt) {
      await rename(indexFile, `${indexFile}.bad-${Date.now()}`).catch(() => {});
      corrupt = false;
    }
    const tmp = `${indexFile}.tmp-${randomUUID().slice(0, 8)}`;
    const body: IndexFile = { version: 1, sessions: [...next.values()] };
    try {
      await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, indexFile);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    sessions = next;
  }

  let indexQueue: Promise<unknown> = ready;
  function mutateIndex<T>(fn: () => Promise<T>): Promise<T> {
    const run = indexQueue.then(fn);
    indexQueue = run.catch(() => {});
    return run;
  }

  /**
   * Walk a file backwards from `from` in chunks, handing each complete line (newest first) and its
   * byte offset to `visit` until it returns false or the file start is reached.
   */
  async function scanBackwards(handle: FileHandle, from: number, visit: (line: Buffer, offset: number) => boolean) {
    let position = from;
    let carry = Buffer.alloc(0); // The incomplete line at the start of the region read so far.
    let more = true;
    while (position > 0 && more) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      const buffer = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let lineEnd = buffer.length;
      for (let i = buffer.length - 1; i >= 0 && more; i--) {
        if (buffer[i] !== NEWLINE) continue;
        // Bytes between this newline and the previous line boundary form one line; the region's
        // trailing newline yields an empty span, which is skipped.
        if (i + 1 < lineEnd) more = visit(buffer.subarray(i + 1, lineEnd), position + i + 1);
        lineEnd = i;
      }
      carry = buffer.subarray(0, lineEnd);
    }
    if (position === 0 && more && carry.length > 0) visit(carry, 0);
  }

  /**
   * Find the seq the next event should get: one past the last readable event. Also drops a torn
   * last line (a crash mid-append leaves no trailing newline).
   */
  async function inspect(file: string): Promise<number> {
    let handle: FileHandle;
    try {
      handle = await open(file, "r+");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return 0;
      throw err;
    }
    try {
      let { size } = await handle.stat();
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== NEWLINE) {
          let cut = 0;
          await scanBackwards(handle, size, (_line, offset) => {
            cut = offset;
            return false;
          });
          console.warn(`Dropping a torn last line from ${file}.`);
          await handle.truncate(cut);
          size = cut;
        }
      }
      let next = 0;
      await scanBackwards(handle, size, (line) => {
        const event = parseLine(file, line);
        if (!event) return true;
        next = event.seq + 1;
        return false;
      });
      return next;
    } finally {
      await handle.close();
    }
  }

  function log(id: string): Log {
    let entry = logs.get(id);
    if (!entry) {
      const file = path.join(logsDir, `${id}.jsonl`);
      entry = { file, opened: Promise.resolve(0), count: 0, handle: null, queue: Promise.resolve(), offsets: new Map(), closed: false };
      const created = entry;
      created.opened = inspect(file).then((count) => {
        created.count = count;
        return count;
      });
      logs.set(id, created);
    }
    return entry;
  }

  function parseLine(file: string, line: Buffer): StoredEvent | null {
    try {
      const parsed: unknown = JSON.parse(line.toString("utf8"));
      if (isStoredEvent(parsed)) return parsed;
    } catch {
      // Fall through to the warning.
    }
    console.warn(`Skipping an unreadable line in ${file}.`);
    return null;
  }

  async function readTail(id: string, { beforeSeq, limit }: TailQuery): Promise<TailResult> {
    const entry = log(id);
    await entry.opened;
    await entry.queue;
    const count = entry.count;
    const end = Math.min(beforeSeq ?? count, count);
    if (end <= 0 || limit <= 0) return { events: [], hasMore: end > 0 };
    let handle: FileHandle;
    try {
      handle = await open(entry.file, "r");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return { events: [], hasMore: false };
      throw err;
    }
    try {
      // Read backwards from just past the last wanted line: the known start of the line holding
      // `end` (where an earlier page began) or, failing that, the end of the file.
      const from = entry.offsets.get(end) ?? (await handle.stat()).size;
      const collected: StoredEvent[] = []; // Newest first while collecting.
      let oldestOffset = from;
      await scanBackwards(handle, from, (line, offset) => {
        const event = parseLine(entry.file, line);
        if (event && event.seq < end) {
          collected.push(event);
          oldestOffset = offset;
        }
        return collected.length < limit;
      });
      const oldest = collected.at(-1);
      if (oldest) entry.offsets.set(oldest.seq, oldestOffset);
      collected.reverse();
      // Reaching the start of the file without a readable event means nothing older is left, even
      // if unreadable lines remain; reporting "more" would send callers in circles.
      return { events: collected, hasMore: oldest ? oldest.seq > 0 : false };
    } finally {
      await handle.close();
    }
  }

  async function appendEvent(id: string, event: StoredEvent): Promise<void> {
    const entry = log(id);
    const run = entry.queue.then(async () => {
      await entry.opened;
      if (entry.closed) throw new Error(`Log for session ${id} is closed`);
      // Sequence numbers must move forward. A gap is allowed so one failed write (disk full, a
      // closed handle) loses only its own event rather than every event after it.
      if (event.seq < entry.count) {
        throw new Error(`Out-of-order append to ${id}: log already holds seq ${event.seq} (next is ${entry.count})`);
      }
      if (!entry.handle) {
        await mkdir(logsDir, { recursive: true });
        entry.handle = await open(entry.file, "a", 0o600);
      }
      await entry.handle.write(JSON.stringify(event) + "\n");
      entry.count = event.seq + 1;
    });
    entry.queue = run.catch(() => {});
    return run;
  }

  return {
    ready,
    async listSessions() {
      await ready;
      return [...sessions.values()];
    },
    async getSession(id) {
      await ready;
      return sessions.get(id);
    },
    putSession(record) {
      return mutateIndex(() => saveIndex(new Map(sessions).set(record.id, record)));
    },
    deleteSession(id) {
      return mutateIndex(async () => {
        // Forget the session first so a failed log removal cannot leave a listed session with no log.
        if (sessions.has(id)) {
          const next = new Map(sessions);
          next.delete(id);
          await saveIndex(next);
        }
        const entry = logs.get(id);
        if (entry) {
          await entry.queue;
          entry.closed = true;
          const handle = entry.handle;
          entry.handle = null;
          await handle?.close().catch(() => {});
          logs.delete(id);
        }
        await rm(path.join(logsDir, `${id}.jsonl`), { force: true });
      });
    },
    appendEvent,
    readTail,
    async eventCount(id) {
      const entry = log(id);
      await entry.opened;
      await entry.queue;
      return entry.count;
    },
    async dispose() {
      // Appends still queued behind us are rejected; later use of the store starts from a fresh
      // inspection of each log (a restarted runtime may hand the same store object on).
      for (const [id, entry] of [...logs]) {
        await entry.queue;
        entry.closed = true;
        const handle = entry.handle;
        entry.handle = null;
        await handle?.close().catch(() => {});
        if (logs.get(id) === entry) logs.delete(id);
      }
    },
  };
}
