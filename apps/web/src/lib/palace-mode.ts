/**
 * Palace mode's Esc (docs/GLASS.md, Palace mode → Entering and leaving): on desktop, Esc enters and
 * leaves it, unless something else is the key's business. `palaceEscapeToggles` is the pure rule
 * over the key event and what the document held when the key went down; `palaceKeyState` reads the
 * document (browser only).
 */

/** The parts of a `KeyboardEvent` the rule reads; of its target, `closest` and an editable's text. */
export type PalaceKey = {
  key: string;
  defaultPrevented: boolean;
  repeat: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: unknown;
};

type KeyTarget = { closest?: (selector: string) => unknown } | null;

/** What the document held when the key went down. */
export type PalaceKeyState = {
  /** 768 px and up: phones have no Esc for it. */
  desktop: boolean;
  /** A dialog, alert dialog, menu, listbox or popover is open (or a room object's pinned card). */
  popupOpen: boolean;
  /** A page overlay is open: its own Esc closes it first. */
  overlayOpen: boolean;
};

/** Open popups: Radix marks its open dialogs, menus, listboxes and popovers with `data-state=open`. */
export const POPUP_SELECTOR =
  ":is([role=dialog], [role=alertdialog], [role=menu], [role=listbox])[data-state=open], [data-room-card][role=dialog]";
const TERMINAL_SELECTOR = ".xterm, [data-terminal]";
const EDITABLE_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

/** The text in an editable element: an input's or textarea's value, else its text content. */
function textOf(editable: unknown): string {
  if (typeof editable !== "object" || editable === null) return "";
  if ("value" in editable && typeof editable.value === "string") return editable.value;
  if ("textContent" in editable && typeof editable.textContent === "string") return editable.textContent;
  return "";
}

/**
 * Whether this key toggles Palace mode: a plain, first press of Escape on desktop that nothing else
 * took (`defaultPrevented`: the composer's slash menu, rename fields, Radix's dismissals, a drag's
 * cancel), with no popup or page overlay open, not typed into a terminal, and not in a text field
 * holding text (an empty composer counts as empty).
 */
export function palaceEscapeToggles(event: PalaceKey, state: PalaceKeyState): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.repeat) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (!state.desktop || state.popupOpen || state.overlayOpen) return false;
  const target = event.target as KeyTarget;
  if (typeof target?.closest !== "function") return true;
  if (target.closest(TERMINAL_SELECTOR)) return false;
  const editable = target.closest(EDITABLE_SELECTOR);
  return !editable || textOf(editable).length === 0;
}

/** The document's side of the rule, read when the key goes down (before any handler closes a popup). Browser only. */
export function palaceKeyState(desktop: boolean): PalaceKeyState {
  return {
    desktop,
    popupOpen: document.querySelector(POPUP_SELECTOR) !== null,
    overlayOpen: document.querySelector("[data-page-overlay]") !== null,
  };
}
