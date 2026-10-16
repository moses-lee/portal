import assert from "node:assert/strict";
import test from "node:test";
import { EDITABLE_SELECTOR, palaceEscapeToggles, POPUP_SELECTOR } from "../src/lib/palace-mode.ts";

/** A plain Escape on `target`. */
const escape = (target = null, extra = {}) => ({
  key: "Escape",
  defaultPrevented: false,
  repeat: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  target,
  ...extra,
});
const desktop = { desktop: true, popupOpen: false, overlayOpen: false };

/** A target whose `closest` finds `found` for selectors matching `pattern`, nothing otherwise. */
const inside = (pattern, found) => ({ closest: (selector) => (pattern.test(selector) ? found : null) });

test("a plain Esc on desktop toggles Palace mode", () => {
  assert.equal(palaceEscapeToggles(escape(), desktop), true);
  assert.equal(palaceEscapeToggles(escape({ closest: () => null }), desktop), true);
  // A button, a pane, the document: nothing that wants the key.
  assert.equal(palaceEscapeToggles(escape({}), desktop), true);
});

test("phones have no Esc for it", () => {
  assert.equal(palaceEscapeToggles(escape(), { ...desktop, desktop: false }), false);
});

test("another key, a key another handler took, a repeat or a modifier does not toggle", () => {
  assert.equal(palaceEscapeToggles(escape(null, { key: "Enter" }), desktop), false);
  assert.equal(palaceEscapeToggles(escape(null, { defaultPrevented: true }), desktop), false);
  assert.equal(palaceEscapeToggles(escape(null, { repeat: true }), desktop), false);
  for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) assert.equal(palaceEscapeToggles(escape(null, { [modifier]: true }), desktop), false, modifier);
});

test("an open dialog, menu, listbox or popover, or a page overlay, keeps the key", () => {
  assert.equal(palaceEscapeToggles(escape(), { ...desktop, popupOpen: true }), false);
  assert.equal(palaceEscapeToggles(escape(), { ...desktop, overlayOpen: true }), false);
  for (const role of ["dialog", "alertdialog", "menu", "listbox"]) assert.match(POPUP_SELECTOR, new RegExp(`\\[role=${role}\\]`));
  assert.match(POPUP_SELECTOR, /\[data-state=open\]/);
});

test("a terminal keeps the key", () => {
  assert.equal(palaceEscapeToggles(escape(inside(/\.xterm/, {})), desktop), false);
  assert.equal(palaceEscapeToggles(escape(inside(/\[data-terminal\]/, {})), desktop), false);
});

test("a text field keeps the key while it holds text; an empty one does not", () => {
  const editable = /textarea, \[contenteditable\]/;
  assert.equal(palaceEscapeToggles(escape(inside(editable, { value: "draft" })), desktop), false);
  assert.equal(palaceEscapeToggles(escape(inside(editable, { value: "" })), desktop), true);
  assert.equal(palaceEscapeToggles(escape(inside(editable, { textContent: "note" })), desktop), false);
  assert.equal(palaceEscapeToggles(escape(inside(editable, { textContent: "" })), desktop), true);
});

test("an IME composing keeps the key", () => {
  assert.equal(palaceEscapeToggles(escape(null, { isComposing: true }), desktop), false);
  // Safari reports the composition's Esc as keyCode 229 with isComposing false.
  assert.equal(palaceEscapeToggles(escape(null, { keyCode: 229 }), desktop), false);
  assert.equal(palaceEscapeToggles(escape(null, { keyCode: 27 }), desktop), true);
});

test("a pointer drag under way keeps the key", () => {
  assert.equal(palaceEscapeToggles(escape(), { ...desktop, dragging: true }), false);
});

test("a room card counts as a popup, hovered or pinned", () => {
  assert.match(POPUP_SELECTOR, /(^|, )\[data-room-card\]($|,)/);
});

test("only text-like fields keep the key: checkboxes, radios and ranges do not", () => {
  for (const kind of ["text", "search", "url", "email", "password", "tel", "number"]) assert.match(EDITABLE_SELECTOR, new RegExp(`\\[type=${kind}\\]`), kind);
  assert.match(EDITABLE_SELECTOR, /input:is\(:not\(\[type\]\)/);
  for (const kind of ["checkbox", "radio", "range", "button"]) assert.doesNotMatch(EDITABLE_SELECTOR, new RegExp(kind), kind);
  assert.match(EDITABLE_SELECTOR, /textarea/);
  assert.match(EDITABLE_SELECTOR, /\[contenteditable\]/);
});
