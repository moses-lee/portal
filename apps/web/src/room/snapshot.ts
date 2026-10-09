/**
 * The snapshot (docs/PALACE.md, Revision 2, Before the room draws): the last frame this browser
 * drew, without the frost, kept in IndexedDB and shown at once on the next visit until the canvas
 * draws.
 *
 * - The capture (`armSnapshots`, browser only): armed by the canvas once it has drawn; it takes a
 *   frame when the document turns hidden, once 10 s after arming (so a visit whose tab is killed
 *   still leaves one) and on `pagehide` (best effort), at most once a minute. The canvas's
 *   `capture()` renders a frame with the frost off, copies it (`copyFrame`) and renders a frosted
 *   one, all in one task, since without `preserveDrawingBuffer` the drawing buffer is readable only
 *   until that task ends; then, asynchronously, a JPEG and one IndexedDB `put`.
 * - The read: started as this module evaluates on the client (`snapshotRead`), so it has usually
 *   answered by hydration. A record from another `LAYOUT_VERSION` is deleted.
 * - The pure parts, unit-tested: `snapshotEligibility` (layout version, age, scene, aspect),
 *   `snapshotPlacement` (where the stored frame lands for another viewport and view offset) and
 *   `captureSize`.
 */
import { LAYOUT_VERSION } from "@portal/shared/room";
import { framePose, interestPoint, layoutOffset, readLayout } from "./layout.ts";

/** A snapshot older than this is not shown. */
export const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** A snapshot is shown only when its aspect is within this fraction of the viewport's. */
export const SNAPSHOT_ASPECT_TOLERANCE = 0.05;
/** The stored frame's long side at most, in pixels. */
export const SNAPSHOT_LONG_SIDE = 1600;
/** The JPEG's quality. */
export const SNAPSHOT_QUALITY = 0.72;
/** At most one capture this often. */
export const SNAPSHOT_EVERY_MS = 60_000;
/** The backstop: a capture this long after the first drawn frame. */
export const SNAPSHOT_BACKSTOP_MS = 10_000;
/** How long after hydration the background waits for the read before it settles for the sketch. */
export const SNAPSHOT_READ_WAIT_MS = 150;

export const SNAPSHOT_DATABASE = "portal-room";
export const SNAPSHOT_STORE = "snapshot";
export const SNAPSHOT_KEY = "last";

export type SnapshotScene = "day" | "night";

/** A point or a translation in CSS pixels. */
export type Pixels = { x: number; y: number };

/** The record under `"last"`, without its image. */
export type SnapshotMeta = {
  layoutVersion: number;
  /** The viewport in CSS pixels at the capture. */
  width: number;
  height: number;
  aspect: number;
  /** `interestPoint(readLayout())` at the capture. */
  interest: Pixels;
  /** The camera's view offset at the capture (`layoutOffset`'s `x` and `y`, the strip's anchor included). */
  offset: Pixels;
  scene: SnapshotScene;
  /** Epoch ms. */
  at: number;
};

export type SnapshotRecord = SnapshotMeta & { blob: Blob };

export type SnapshotEligibility = "eligible" | "layout" | "stale" | "scene" | "aspect";

/**
 * Whether a stored snapshot may stand in for the room now: the same `LAYOUT_VERSION`, under
 * `SNAPSHOT_MAX_AGE_MS` old (a record from the future, after the clock moved back, is not), the
 * current scene, and an aspect within `SNAPSHOT_ASPECT_TOLERANCE` of the viewport's (at the edge,
 * still eligible). Otherwise the first rule it fails.
 */
export function snapshotEligibility(
  record: Pick<SnapshotMeta, "layoutVersion" | "at" | "scene" | "aspect">,
  now: { layoutVersion: number; at: number; scene: string; aspect: number },
): SnapshotEligibility {
  if (record.layoutVersion !== now.layoutVersion) return "layout";
  const age = now.at - record.at;
  if (!(age >= 0 && age < SNAPSHOT_MAX_AGE_MS)) return "stale";
  if (record.scene !== now.scene) return "scene";
  if (!(Math.abs(record.aspect / now.aspect - 1) <= SNAPSHOT_ASPECT_TOLERANCE + 1e-12)) return "aspect";
  return "eligible";
}

/** A viewport and the camera's view offset in it, in CSS pixels. */
export type SnapshotView = { width: number; height: number; offset: Pixels };

/** The stored frame's box on screen: its size, and the translation of its top left corner. */
export type SnapshotBox = { width: number; height: number; x: number; y: number };

/**
 * Where the stored frame goes so what it shows lands where the camera will draw it. The vertical
 * field of view is fixed, so the room scales with the viewport's height: the frame is drawn at its
 * stored size times `s` = current height / stored height. A screen pixel p shows the fitted frame's
 * point p + offset − centre (centre-relative, so it holds when the aspects differ a little), and
 * the same frame point is s times as far from the centre now; so the frame's top left goes to
 * s × (stored offset − stored centre) − (current offset − current centre): the difference of the
 * view offsets, the stored one scaled. At one aspect the centre terms cancel.
 */
export function snapshotPlacement(stored: SnapshotView, current: SnapshotView): SnapshotBox {
  const scale = current.height / stored.height;
  return {
    width: stored.width * scale,
    height: stored.height * scale,
    x: scale * (stored.offset.x - stored.width / 2) - (current.offset.x - current.width / 2),
    y: scale * (stored.offset.y - stored.height / 2) - (current.offset.y - current.height / 2),
  };
}

/** The stored frame's size for a drawing buffer of `width` × `height`: at most `SNAPSHOT_LONG_SIDE` on its long side, never enlarged. */
export function captureSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, SNAPSHOT_LONG_SIDE / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// ---------------------------------------------------------------------------------------------
// Storage (browser only)
// ---------------------------------------------------------------------------------------------

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const open = indexedDB.open(SNAPSHOT_DATABASE, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(SNAPSHOT_STORE)) open.result.createObjectStore(SNAPSHOT_STORE);
  };
  return request(open);
}

/** Runs `operation` on the store in one transaction and closes the database after it. */
async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(SNAPSHOT_STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const [result] = await Promise.all([request(operation(transaction.objectStore(SNAPSHOT_STORE))), done]);
    return result;
  } finally {
    db.close();
  }
}

const isPixels = (value: unknown): value is Pixels =>
  typeof value === "object" && value !== null && Number.isFinite((value as Pixels).x) && Number.isFinite((value as Pixels).y);

/** A stored value as a record, or null when it is not one (an older shape, a damaged entry). */
function asRecord(value: unknown): SnapshotRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as SnapshotRecord;
  const numbers = [record.layoutVersion, record.width, record.height, record.aspect, record.at];
  if (!numbers.every((each) => typeof each === "number" && Number.isFinite(each))) return null;
  if (record.width <= 0 || record.height <= 0 || !isPixels(record.interest) || !isPixels(record.offset)) return null;
  if (record.scene !== "day" && record.scene !== "night") return null;
  if (typeof Blob === "undefined" || !(record.blob instanceof Blob)) return null;
  return record;
}

/** The stored record, if any; one from another layout version is deleted and not returned. */
async function readLast(): Promise<SnapshotRecord | null> {
  const stored = await withStore("readonly", (store) => store.get(SNAPSHOT_KEY));
  if (stored === undefined) return null;
  const version = (stored as { layoutVersion?: unknown } | null)?.layoutVersion;
  if (version !== LAYOUT_VERSION) {
    await withStore("readwrite", (store) => store.delete(SNAPSHOT_KEY));
    return null;
  }
  return asRecord(stored);
}

let answered: SnapshotRecord | null | undefined;

/**
 * The read, started once as the module evaluates on the client; resolves to null on the server,
 * without IndexedDB, and on any failure.
 */
const read: Promise<SnapshotRecord | null> =
  typeof window === "undefined" || typeof indexedDB === "undefined"
    ? Promise.resolve(null)
    : readLast().catch((error: unknown) => {
        console.warn("The room's snapshot could not be read.", error);
        return null;
      });
void read.then((record) => {
  answered = record;
});

/** The stored record (eligibility not checked: that needs the viewport and the scene). */
export function snapshotRead(): Promise<SnapshotRecord | null> {
  return read;
}

/** The read's answer if it has come, else undefined. */
export function peekSnapshot(): SnapshotRecord | null | undefined {
  return answered;
}

// ---------------------------------------------------------------------------------------------
// The capture (browser only)
// ---------------------------------------------------------------------------------------------

/** The canvas's drawing buffer copied, scaled down to `captureSize`, onto a new 2D canvas; null if it cannot be. */
export function copyFrame(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const size = captureSize(source.width, source.height);
  const copy = document.createElement("canvas");
  copy.width = size.width;
  copy.height = size.height;
  const context = copy.getContext("2d");
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, size.width, size.height);
  return copy;
}

/** When the last capture was taken (epoch ms), across canvases in the page load. */
let lastCapture = -Infinity;

/**
 * Starts taking snapshots of a canvas that has drawn (docs/PALACE.md, The snapshot); returns the
 * stop. `capture` renders a frame without the frost, copies it with `copyFrame` and renders a
 * frosted one, in one task, returning the copy (null when the context is lost or it failed).
 * `scene` is the room's scene now. Nothing is taken under reduced transparency.
 */
export function armSnapshots(options: { capture: () => HTMLCanvasElement | null; scene: () => SnapshotScene }): () => void {
  if (typeof indexedDB === "undefined" || window.matchMedia("(prefers-reduced-transparency: reduce)").matches) return () => {};
  let stopped = false;
  const take = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastCapture < SNAPSHOT_EVERY_MS) return;
    const layout = readLayout();
    if (layout.width <= 0 || layout.height <= 0) return;
    const pose = framePose(layout.width / layout.height);
    const offset = layoutOffset(layout, pose);
    const frame = options.capture();
    if (!frame) return;
    lastCapture = now;
    const meta: SnapshotMeta = {
      layoutVersion: LAYOUT_VERSION,
      width: layout.width,
      height: layout.height,
      aspect: layout.width / layout.height,
      interest: interestPoint(layout),
      offset: { x: offset.x, y: offset.y },
      scene: options.scene(),
      at: now,
    };
    frame.toBlob(
      (blob) => {
        if (!blob) return;
        withStore("readwrite", (store) => store.put({ ...meta, blob } satisfies SnapshotRecord, SNAPSHOT_KEY)).catch((error: unknown) => {
          console.warn("The room's snapshot could not be stored.", error);
        });
      },
      "image/jpeg",
      SNAPSHOT_QUALITY,
    );
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") take();
  };
  const timer = setTimeout(take, SNAPSHOT_BACKSTOP_MS);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", take);
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", take);
  };
}
