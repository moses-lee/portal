/**
 * The shell's side of the room loop's motion boost (docs/GLASS.md, Loop): while a panel slides or
 * fades (the sidebar collapsing, a sheet, Palace mode coming and going) `data-room-motion` is on the
 * root element, which is always mounted, so the loop's observer sees it at once and draws at 60 fps:
 * the glass under a moving panel keeps up instead of stepping at 24 fps.
 *
 * Holds are counted, so overlapping animations keep the attribute until the last one ends. Each hold
 * returns its release, which is safe to call more than once; a hold never released (an animation
 * whose end event never came) lets go by itself after `MAX_HOLD_MS`.
 */

/** The loop's attribute (`room/loop.ts`, `MOTION_ATTRIBUTE`); not imported, so this stays out of the room's chunk. */
const ATTRIBUTE = "data-room-motion";
/** Longer than any shell animation. */
export const MAX_HOLD_MS = 2_000;

let holds = 0;

/** Turn the boost on until the returned release is called (or `MAX_HOLD_MS` passes). Browser only. */
export function holdRoomMotion(): () => void {
  holds += 1;
  document.documentElement.setAttribute(ATTRIBUTE, "");
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    clearTimeout(timer);
    holds -= 1;
    if (holds === 0) document.documentElement.removeAttribute(ATTRIBUTE);
  };
  const timer = setTimeout(release, MAX_HOLD_MS);
  return release;
}

/** True while some shell animation holds the boost: a terminal waits for the end before refitting. */
export function roomMotionHeld(): boolean {
  return holds > 0;
}
