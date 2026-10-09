/**
 * What the canvas reports about itself for tests and measurement, merged into the `.room-scene`
 * element's `data-room` summary by `RoomBackground`: the camera's pose and frame (`camera`) and the screen
 * points of the interactive objects (`points`). A key is written only when its value changed, and
 * the merge goes straight to the DOM, so a report never re-renders React.
 */

let report: Record<string, unknown> = {};
const last = new Map<string, string>();
let writer: ((report: Record<string, unknown>) => void) | null = null;

/** Set `key` in the report; a value equal (as JSON) to the last one is a no-op. */
export function reportRoom(key: string, value: unknown) {
  const json = JSON.stringify(value);
  if (last.get(key) === json) return;
  last.set(key, json);
  report = { ...report, [key]: value };
  writer?.(report);
}

/** The current report; `RoomBackground` merges it into `data-room` on its own renders too. */
export function readRoomReport(): Record<string, unknown> {
  return report;
}

/** Hear every change (one writer: the mounted background); returns the unsubscribe. */
export function onRoomReport(write: (report: Record<string, unknown>) => void): () => void {
  writer = write;
  return () => {
    if (writer === write) writer = null;
  };
}

/** Forget everything reported (the canvas unmounted). */
export function clearRoomReport() {
  report = {};
  last.clear();
  writer?.(report);
}
