/**
 * Pointing at the room (docs/PALACE.md, Hover and click). The canvas sits behind the UI with no
 * pointer events of its own, so one document-level listener does the work: over a see-through part
 * of the page (an element marked `data-room-passthrough`, with no panel, control or text between it
 * and the pointer) it asks the canvas's picker which object is under the pointer, at most once per
 * frame of the room's loop, and drives the hover card's store and the cursor. A click activates the
 * object (the caller navigates); a tap on a touch screen pins the card with a button instead. Nothing
 * here moves the camera (docs/PALACE.md, Revision 2): a drag is neither a click nor a look-around.
 *
 * No three.js here: the canvas (loaded on its own) registers the picker that raycasts its scene.
 */
import { DEFAULT_FPS } from "./loop.ts";
import type { RoomTarget } from "./live.ts";

/** An object under the pointer. */
export type RoomHit = RoomTarget;

type Picker = (clientX: number, clientY: number) => RoomHit | null;

let picker: Picker | null = null;

/** The canvas's raycast, while it is mounted. */
export function setRoomPicker(next: Picker | null) {
  picker = next;
}

// ---------------------------------------------------------------------------------------------
// The card's store
// ---------------------------------------------------------------------------------------------

/** The card on screen: hovering (follows the pointer, no pointer events) or pinned (a tap, the window, a robot's wave). */
export type RoomCardState = { target: RoomTarget; x: number; y: number; pinned: boolean } | null;

let card: RoomCardState = null;
const cardListeners = new Set<() => void>();

function setCard(next: RoomCardState) {
  if (
    card === next ||
    (card && next && card.target.kind === next.target.kind && card.target.id === next.target.id && card.x === next.x && card.y === next.y && card.pinned === next.pinned)
  )
    return;
  card = next;
  for (const listener of [...cardListeners]) listener();
}

export function subscribeCard(listener: () => void): () => void {
  cardListeners.add(listener);
  return () => {
    cardListeners.delete(listener);
  };
}

export const readCard = (): RoomCardState => card;

/** Pin the card for `target` at (`x`, `y`): it stays until a click elsewhere or Escape. */
export function pinCard(target: RoomTarget, x: number, y: number) {
  setCard({ target: { kind: target.kind, id: target.id }, x, y, pinned: true });
}

export function hideCard() {
  setCard(null);
}

// ---------------------------------------------------------------------------------------------
// Robot waves (the Palace page)
// ---------------------------------------------------------------------------------------------

const waves = new Map<string, number>();
export const WAVE_MS = 600;

/** A robot raises its arm (the Palace page's answer to a click), from `performance.now()`. */
export function waveRobot(id: string) {
  waves.set(id, performance.now());
}

/** When the robot's wave started, if it is still waving. */
export function waveStartedAt(id: string, now: number): number | null {
  const start = waves.get(id);
  if (start === undefined) return null;
  if (now - start > WAVE_MS) {
    waves.delete(id);
    return null;
  }
  return start;
}

// ---------------------------------------------------------------------------------------------
// Passthrough
// ---------------------------------------------------------------------------------------------

export const PASSTHROUGH = "[data-room-passthrough]";

/**
 * Elements that are UI, not room: panels, controls, text, media, the message column, the card, and
 * any section, tab panel or separator (a terminal, a pane, a resize handle) or `data-room-block`.
 */
const BLOCKING = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "label",
  "summary",
  "header",
  "nav",
  "aside",
  "form",
  "img",
  "svg",
  "video",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "pre",
  "code",
  "table",
  "section",
  "[role=button]",
  "[role=link]",
  "[role=dialog]",
  "[role=menu]",
  "[role=listbox]",
  "[role=tab]",
  "[role=tablist]",
  "[role=log]",
  "[role=tabpanel]",
  "[role=separator]",
  "[contenteditable=true]",
  ".conversation-content",
  ".frost",
  ".frost-subtle",
  ".glass",
  "[data-room-card]",
  "[data-room-block]",
].join(",");

/** True when the element shows text of its own (not only through children). */
function ownsText(element: Element): boolean {
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true;
  }
  return false;
}

/**
 * The passthrough element the room shows through at (`x`, `y`), or null when a panel, a control,
 * or text sits there (or no passthrough element is under the point at all).
 */
export function passthroughAt(x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y);
  const through = hit?.closest<HTMLElement>(PASSTHROUGH);
  if (!hit || !through) return null;
  for (let element: Element | null = hit; element && element !== through; element = element.parentElement) {
    if (element.matches(BLOCKING) || ownsText(element)) return null;
  }
  return through;
}

// ---------------------------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------------------------

export type RoomPointerHandlers = {
  /** A click on an object (a mouse or pen; taps pin the card instead). */
  onActivate: (hit: RoomHit, at: { x: number; y: number }) => void;
};

/** A press that moved further than this (CSS pixels) is a drag, not a click. */
const CLICK_SLOP = 6;
const TAP_SLOP = 10;
const TAP_MS = 500;

/**
 * Starts listening on the document; returns the stop. One listener for the page: the mounted room
 * background starts it while the canvas draws.
 */
export function startRoomPointer(handlers: RoomPointerHandlers): () => void {
  const frameMs = 1000 / DEFAULT_FPS;
  let pending: { x: number; y: number } | null = null;
  let raf = 0;
  let lastPick = -Infinity;
  let cursorOn: HTMLElement | null = null;
  let down: { x: number; y: number; at: number; touch: boolean } | null = null;
  let lastTouchAt = -Infinity;

  const setCursor = (element: HTMLElement | null) => {
    if (cursorOn === element) return;
    if (cursorOn) cursorOn.style.cursor = "";
    cursorOn = element;
    if (element) element.style.cursor = "pointer";
  };

  const pick = (x: number, y: number): { through: HTMLElement | null; hit: RoomHit | null } => {
    const through = passthroughAt(x, y);
    return { through, hit: through && picker ? picker(x, y) : null };
  };

  const hover = (x: number, y: number) => {
    const { through, hit } = pick(x, y);
    setCursor(hit ? through : null);
    if (card?.pinned) return;
    if (hit) setCard({ target: { kind: hit.kind, id: hit.id }, x, y, pinned: false });
    else setCard(null);
  };

  const run = (time: number) => {
    raf = 0;
    if (!pending) return;
    // At most one raycast per frame of the room's loop.
    if (time - lastPick < frameMs - 0.5) {
      raf = requestAnimationFrame(run);
      return;
    }
    lastPick = time;
    const { x, y } = pending;
    pending = null;
    hover(x, y);
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    pending = { x: event.clientX, y: event.clientY };
    if (!raf) raf = requestAnimationFrame(run);
  };

  const onLeave = (event: PointerEvent) => {
    if (event.relatedTarget !== null || event.pointerType === "touch") return;
    pending = null;
    setCursor(null);
    if (!card?.pinned) setCard(null);
  };

  const onDown = (event: PointerEvent) => {
    down = { x: event.clientX, y: event.clientY, at: event.timeStamp, touch: event.pointerType === "touch" };
  };

  /** A click or tap on the room at (`x`, `y`): `act` is what a single one does to an object. */
  const press = (x: number, y: number, act: (hit: RoomHit) => void) => {
    const { through, hit } = pick(x, y);
    if (!through) return;
    if (!hit) return hideCard();
    act(hit);
  };

  const onUp = (event: PointerEvent) => {
    const start = down;
    // A mouse or pen press stays recorded for the click that follows, which measures the drag against it.
    if (!start?.touch || event.pointerType !== "touch") return;
    down = null;
    lastTouchAt = performance.now();
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP || event.timeStamp - start.at > TAP_MS) return;
    if ((event.target as Element | null)?.closest?.("[data-room-card]")) return;
    const x = event.clientX;
    const y = event.clientY;
    press(x, y, (hit) => pinCard(hit, x, y));
  };

  const onClick = (event: MouseEvent) => {
    // Taps were handled on pointerup; the click a tap synthesises is not a second press.
    if ((event as PointerEvent).pointerType === "touch" || performance.now() - lastTouchAt < 800) return;
    const start = down;
    down = null;
    // A press that moved is a drag, not a click.
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;
    if ((event.target as Element | null)?.closest?.("[data-room-card]")) return;
    const x = event.clientX;
    const y = event.clientY;
    if (card?.pinned && !passthroughAt(x, y)) {
      // A click on the UI elsewhere puts a pinned card away.
      hideCard();
      return;
    }
    press(x, y, (hit) => handlers.onActivate(hit, { x, y }));
  };

  const onKey = (event: KeyboardEvent) => {
    // Escape puts the card away.
    if (event.key === "Escape" && card) hideCard();
  };

  const onScroll = () => {
    if (card && !card.pinned) setCard(null);
  };

  document.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerout", onLeave);
  document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
  document.addEventListener("pointerup", onUp, { capture: true, passive: true });
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    if (raf) cancelAnimationFrame(raf);
    setCursor(null);
    setCard(null);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerout", onLeave);
    document.removeEventListener("pointerdown", onDown, { capture: true });
    document.removeEventListener("pointerup", onUp, { capture: true });
    document.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("scroll", onScroll, { capture: true });
  };
}
