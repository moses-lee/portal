"use client";

// Files picked, pasted or dropped into a composer, waiting for its send (docs/FILES.md, decisions
// 7 to 9). They are held as `File`s, keyed like drafts (see `./drafts`), so every view of a session
// shares them and the start page can hand its files to the session it creates; unlike drafts they
// live in memory only and do not survive a reload. A send uploads them one at a time (resizing big
// images first), marking each chip with its progress or failure, and then sends their stored paths.
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, type Attachment } from "@portal/contracts/files";

export type PendingAttachment = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /** The picked file; null for one uploaded earlier (a queued prompt's, shown while it is edited). */
  file: File | null;
  /** The stored copy once uploaded; a retried send does not upload it again. */
  uploaded: Attachment | null;
  /** A thumbnail's URL for an image: a local object URL, or the stored copy's raw URL. */
  previewUrl: string | null;
  status: "ready" | "uploading" | "uploaded" | "failed";
  /** Upload progress, 0 to 1. */
  progress: number;
  error: string | null;
};

/** What a composer shows and does with its attachments (see `ChatComposer`). */
export type ComposerAttachments = {
  items: PendingAttachment[];
  /** Add picked, pasted or dropped files; absent while adding is off (a queued prompt is being edited). */
  add?: (files: File[]) => void;
  remove: (id: string) => void;
  /** Why the last add was refused, in part or whole (too many, too large); null when it was not. */
  notice: string | null;
};

/**
 * Images over this, or with an edge longer than `MAX_IMAGE_EDGE`, are re-encoded to JPEG before upload.
 * Matches the server's `MAX_PROMPT_IMAGE_BYTES`: the Claude API's 5 MB cap applies after base64, and a
 * larger image would reach the agent only as a link.
 */
export const RESIZE_IMAGE_BYTES = Math.floor((5 * 1024 * 1024) / 4) * 3;
export const MAX_IMAGE_EDGE = 2576;
/** Image types a browser can decode and that are worth re-encoding; GIFs (animation) and SVGs are left alone. */
const RESIZABLE = /^image\/(jpeg|png|webp|heic|heif|avif|bmp)$/;

export const rawFileUrl = (path: string) => `/api/files/raw?path=${encodeURIComponent(path)}`;

export const isImage = (mimeType: string) => mimeType.startsWith("image/");

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Which of `files` fit beside `held` attachments: at most MAX_ATTACHMENTS in all, none over
 * MAX_UPLOAD_BYTES. `notice` says what was left out, or is null.
 */
export function acceptFiles<T extends { size: number; name: string }>(
  held: number,
  files: readonly T[],
): { accepted: T[]; notice: string | null } {
  const tooLarge = files.filter((file) => file.size > MAX_UPLOAD_BYTES);
  const fitting = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
  const room = Math.max(0, MAX_ATTACHMENTS - held);
  const accepted = fitting.slice(0, room);
  const notes: string[] = [];
  if (tooLarge.length)
    notes.push(
      tooLarge.length === 1
        ? `${tooLarge[0].name} is over the ${formatBytes(MAX_UPLOAD_BYTES)} limit.`
        : `${tooLarge.length} files are over the ${formatBytes(MAX_UPLOAD_BYTES)} limit.`,
    );
  if (fitting.length > room) notes.push(`A message takes at most ${MAX_ATTACHMENTS} files.`);
  return { accepted, notice: notes.length ? notes.join(" ") : null };
}

/** Whether an image this big must be re-encoded before upload (decision 9). */
export const needsResize = (bytes: number, width: number, height: number) =>
  bytes > RESIZE_IMAGE_BYTES || Math.max(width, height) > MAX_IMAGE_EDGE;

// The store: pending attachments by draft key, each list replaced on change.
const pending = new Map<string, PendingAttachment[]>();
/** Paths removed from a queued prompt while it is edited, by `editKey`. */
const editRemovals = new Map<string, string[]>();
const listeners = new Set<() => void>();
const none: PendingAttachment[] = [];
const noPaths: string[] = [];
let nextId = 0;

const notify = () => {
  for (const listener of listeners) listener();
};

export function subscribeAttachments(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const readAttachments = (key: string): PendingAttachment[] => pending.get(key) ?? none;

function write(key: string, items: PendingAttachment[]) {
  if (items.length) pending.set(key, items);
  else pending.delete(key);
  notify();
}

function update(key: string, id: string, patch: Partial<PendingAttachment>) {
  const items = readAttachments(key);
  if (!items.some((item) => item.id === id)) return;
  write(key, items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
}

const release = (item: PendingAttachment) => {
  if (item.file && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
};

/** Add files to `key`'s composer, within the limits; answers the notice for any left out. */
export function addAttachments(key: string, files: readonly File[]): string | null {
  const held = readAttachments(key);
  const { accepted, notice } = acceptFiles(held.length, files);
  if (accepted.length)
    write(key, [
      ...held,
      ...accepted.map((file): PendingAttachment => {
        const mimeType = file.type || "application/octet-stream";
        return {
          id: `attachment-${nextId++}`,
          name: file.name || "file",
          size: file.size,
          mimeType,
          file,
          uploaded: null,
          previewUrl: isImage(mimeType) ? URL.createObjectURL(file) : null,
          status: "ready",
          progress: 0,
          error: null,
        };
      }),
    ]);
  return notice;
}

export function removeAttachment(key: string, id: string) {
  const items = readAttachments(key);
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  release(item);
  write(key, items.filter((entry) => entry !== item));
}

/** Drop the attachments that went out with a send; any added meanwhile stay. */
export function clearAttachments(key: string, ids: readonly string[]) {
  const sent = new Set(ids);
  const items = readAttachments(key);
  for (const item of items) if (sent.has(item.id)) release(item);
  write(key, items.filter((item) => !sent.has(item.id)));
}

/** Move `from`'s attachments to the end of `to`'s (the start page handing its files to the session it created). */
export function moveAttachments(from: string, to: string) {
  const items = readAttachments(from);
  if (!items.length || from === to) return;
  pending.delete(from);
  write(to, [...readAttachments(to), ...items]);
}

// A queued prompt being edited: its attachments can be removed, not added (kept simple, docs/FILES.md).
export const editKey = (sessionId: string, itemId: string) => `${sessionId}:${itemId}`;
export const readEditRemovals = (key: string): string[] => editRemovals.get(key) ?? noPaths;
export function removeFromEdit(key: string, path: string) {
  editRemovals.set(key, [...readEditRemovals(key), path]);
  notify();
}
export function clearEditRemovals(key: string) {
  if (editRemovals.delete(key)) notify();
}

/** A queued prompt's attachments as chips: already uploaded, previewed from their stored copies. */
export function storedAttachmentItems(attachments: readonly Attachment[]): PendingAttachment[] {
  return attachments.map((attachment) => ({
    id: attachment.path,
    name: attachment.name,
    size: attachment.size,
    mimeType: attachment.mimeType,
    file: null,
    uploaded: attachment,
    previewUrl: isImage(attachment.mimeType) ? rawFileUrl(attachment.path) : null,
    status: "uploaded",
    progress: 1,
    error: null,
  }));
}

/**
 * Put already-uploaded attachments back into `key`'s composer (a queued prompt dropped by Stop),
 * up to MAX_ATTACHMENTS in all; one already there is not added twice.
 */
export function restoreAttachments(key: string, attachments: readonly Attachment[]) {
  const held = readAttachments(key);
  const paths = new Set(held.map((item) => item.uploaded?.path));
  const fresh = storedAttachmentItems(attachments.filter((attachment) => !paths.has(attachment.path)))
    .slice(0, Math.max(0, MAX_ATTACHMENTS - held.length))
    .map((item) => ({ ...item, id: `attachment-${nextId++}` }));
  if (fresh.length) write(key, [...held, ...fresh]);
}

/**
 * Re-encode a big image to JPEG (decision 9): longest edge at most MAX_IMAGE_EDGE, at most
 * RESIZE_IMAGE_BYTES. Anything else, or an image the browser cannot decode, goes as it is.
 */
export async function prepareForUpload(file: File): Promise<File> {
  if (!RESIZABLE.test(file.type) || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const { width, height } = bitmap;
    if (!needsResize(file.size, width, height)) return file;
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    for (let attempt = 0; attempt < 4; attempt++) {
      const blob = await encodeJpeg(bitmap, Math.round(width * scale), Math.round(height * scale));
      if (blob && blob.size <= RESIZE_IMAGE_BYTES)
        return new File([blob], file.name.replace(/\.[^./]*$/, "") + ".jpg", {
          type: "image/jpeg",
          lastModified: file.lastModified,
        });
      scale *= 0.75;
    }
    return file;
  } finally {
    bitmap.close();
  }
}

function encodeJpeg(bitmap: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  // JPEG has no transparency; a transparent PNG would otherwise turn black.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

/**
 * `POST /api/sessions/:id/uploads?name=` with the raw bytes (decision 8). XMLHttpRequest rather
 * than fetch, for upload progress.
 */
function uploadFile(
  sessionId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/uploads?name=${encodeURIComponent(file.name)}`,
    );
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      let body: { attachment?: Attachment; error?: string } = {};
      try {
        body = JSON.parse(request.responseText);
      } catch {
        /* An unreadable answer is a failure below. */
      }
      if (request.status >= 200 && request.status < 300 && body.attachment) resolve(body.attachment);
      else if (request.status === 413) reject(new Error(`Over the ${formatBytes(MAX_UPLOAD_BYTES)} limit.`));
      else reject(new Error(body.error ?? "Upload failed."));
    };
    request.onerror = () => reject(new Error("Could not reach the server."));
    request.send(file);
  });
}

/** Uploads in flight by attachment id: a second send of the same chip (two views of one composer) waits for the first. */
const uploads = new Map<string, Promise<Attachment>>();

/** Upload one chip, its progress and outcome shown on it; shared with any send already uploading it. */
function uploadOnce(key: string, id: string, file: File, sessionId: string): Promise<Attachment> {
  const running = uploads.get(id);
  if (running) return running;
  const upload = (async () => {
    update(key, id, { status: "uploading", progress: 0, error: null });
    try {
      const attachment = await uploadFile(sessionId, await prepareForUpload(file), (progress) => update(key, id, { progress }));
      update(key, id, { status: "uploaded", progress: 1, uploaded: attachment });
      return attachment;
    } catch (error) {
      update(key, id, {
        status: "failed",
        progress: 0,
        error: error instanceof Error ? error.message : "Upload failed.",
      });
      throw error;
    } finally {
      uploads.delete(id);
    }
  })();
  uploads.set(id, upload);
  return upload;
}

/**
 * Upload `key`'s attachments to `sessionId`, one at a time, each chip following its progress.
 * Answers the stored attachments (in the composer's order) with the ids they came from, for
 * `clearAttachments` once the prompt is sent. A failed upload marks its chip, the rest still go,
 * and the whole send then fails; a retry uploads only what has not gone yet.
 */
export async function uploadAttachments(
  key: string,
  sessionId: string,
): Promise<{ attachments: Attachment[]; ids: string[] }> {
  const items = readAttachments(key);
  const attachments: Attachment[] = [];
  let failed = 0;
  for (const item of items) {
    if (item.uploaded) {
      attachments.push(item.uploaded);
      continue;
    }
    if (!item.file) continue;
    try {
      attachments.push(await uploadOnce(key, item.id, item.file, sessionId));
    } catch {
      failed++;
    }
  }
  if (failed)
    throw new Error(
      failed === 1
        ? "A file could not be uploaded. Remove it or send again to retry."
        : `${failed} files could not be uploaded. Remove them or send again to retry.`,
    );
  return { attachments, ids: items.map((item) => item.id) };
}

/** A composer's pending attachments under draft key `key`, with add (within the limits) and remove. */
export function useComposerAttachments(key: string): ComposerAttachments {
  const items = useSyncExternalStore(
    subscribeAttachments,
    () => readAttachments(key),
    () => none,
  );
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const add = useCallback(
    (files: File[]) => {
      const text = addAttachments(key, files);
      setNotice(text ? { key, text } : null);
    },
    [key],
  );
  const remove = useCallback(
    (id: string) => {
      removeAttachment(key, id);
      setNotice(null);
    },
    [key],
  );
  const shown = notice?.key === key ? notice.text : null;
  return useMemo(() => ({ items, add, remove, notice: shown }), [items, add, remove, shown]);
}
