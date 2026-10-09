import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

/**
 * A minimal DOM for `pointer.ts`: elements with tag names, attributes, classes, text, a parent chain
 * and `matches`/`closest` over simple selectors (`tag`, `.class`, `[attr]`, `[attr=value]`, and
 * compounds of them); a document that keeps its listeners and answers `elementFromPoint` from a
 * function the test sets.
 */
class FakeText {
  nodeType = 3;
  nextSibling = null;
  constructor(text) {
    this.textContent = text;
  }
}

class FakeElement {
  nodeType = 1;
  parentElement = null;
  firstChild = null;
  nextSibling = null;
  style = {};
  constructor(tag, attributes = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    let previous = null;
    for (const child of children) {
      const node = typeof child === "string" ? new FakeText(child) : child;
      if (node instanceof FakeElement) node.parentElement = this;
      if (previous) previous.nextSibling = node;
      else this.firstChild = node;
      previous = node;
    }
  }
  matchesOne(selector) {
    const parts = selector.trim().match(/^[a-z0-9]+|\.[\w-]+|\[[^\]]+\]/gi) ?? [];
    return parts.every((part) => {
      if (part.startsWith(".")) return (this.attributes.get("class") ?? "").split(/\s+/).includes(part.slice(1));
      if (part.startsWith("[")) {
        const [name, value] = part.slice(1, -1).split("=");
        return value === undefined ? this.attributes.has(name) : this.attributes.get(name) === value;
      }
      return this.tagName === part.toUpperCase();
    });
  }
  matches(selectors) {
    return selectors.split(",").some((selector) => this.matchesOne(selector));
  }
  closest(selectors) {
    if (this.matches(selectors)) return this;
    return this.parentElement?.closest(selectors) ?? null;
  }
}

const el = (tag, attributes, children) => new FakeElement(tag, attributes, children);

const listeners = new Map();
let elementAt = () => null;
globalThis.Node = { TEXT_NODE: 3 };
globalThis.document = {
  addEventListener: (type, listener) => listeners.set(type, listener),
  removeEventListener: (type) => listeners.delete(type),
  elementFromPoint: (x, y) => elementAt(x, y),
};
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { passthroughAt, readCard, hideCard, setRoomPicker, startRoomPointer } = await import("../src/room/pointer.ts");

const fire = (type, event) => listeners.get(type)?.({ timeStamp: performance.now(), relatedTarget: null, target: null, ...event });
const mouse = (type, x, y) => fire(type, { clientX: x, clientY: y, pointerType: "mouse" });
const touch = (type, x, y) => fire(type, { clientX: x, clientY: y, pointerType: "touch" });
/** A full mouse click: down at the first point, up and click at the second. */
const click = (from, to = from) => {
  mouse("pointerdown", ...from);
  mouse("pointerup", ...to);
  mouse("click", ...to);
};

/** A see-through viewport with an empty spacer in it: the room shows anywhere over it. */
const viewport = el("div", { "data-room-passthrough": "" }, [el("div")]);
const spacer = viewport.firstChild;
const MAIL = { kind: "mail", id: "mail" };

let activated;
let stop;
beforeEach(() => {
  activated = [];
  elementAt = () => spacer;
  setRoomPicker(() => MAIL);
  stop = startRoomPointer({ onActivate: (hit) => activated.push(hit.kind) });
});
afterEach(() => {
  stop();
  setRoomPicker(null);
  hideCard();
});

test("the room shows through an empty part of a see-through element, and not through UI over it", () => {
  assert.equal(passthroughAt(1, 1), viewport);
  // Each blocker sits in its own see-through element, the hit on an empty child of it.
  const blockers = [
    ["p"],
    ["button"],
    ["section"],
    ["div", { role: "separator" }],
    ["div", { role: "tabpanel" }],
    ["div", { "data-room-block": "" }],
    ["div", { class: "frost rounded" }],
    ["span", {}, "some text"],
  ];
  for (const [tag, attributes = {}, text] of blockers) {
    const inner = el("div");
    el("div", { "data-room-passthrough": "" }, [el(tag, attributes, text ? [inner, text] : [inner])]);
    elementAt = () => inner;
    assert.equal(passthroughAt(1, 1), null, `${tag} ${JSON.stringify(attributes)}`);
  }
  // A terminal's empty rows: the section blocks, however deep the hit.
  const row = el("div");
  el("div", { "data-room-passthrough": "" }, [el("section", { "aria-label": "Terminal" }, [el("div", { class: "xterm" }, [el("div", { class: "xterm-rows" }, [row])])])]);
  elementAt = () => row;
  assert.equal(passthroughAt(1, 1), null);
  // No see-through ancestor at all: never the room.
  elementAt = () => el("div");
  assert.equal(passthroughAt(1, 1), null);
  elementAt = () => null;
  assert.equal(passthroughAt(1, 1), null);
});

test("a click on an object activates it; one over UI, or with no object under it, does not", () => {
  click([100, 100]);
  assert.deepEqual(activated, ["mail"]);
  elementAt = () => el("button");
  click([100, 100]);
  setRoomPicker(() => null);
  elementAt = () => spacer;
  click([100, 100]);
  assert.deepEqual(activated, ["mail"]);
});

test("a press that moved past the click slop is a drag: no click, even released over an object", () => {
  // Six pixels is still a click.
  click([100, 100], [106, 100]);
  assert.deepEqual(activated, ["mail"]);
  click([100, 100], [140, 100]);
  assert.deepEqual(activated, ["mail"]);
});

test("a tap pins the object's card instead of opening it; a moved or long touch is not a tap", () => {
  touch("pointerdown", 50, 60);
  touch("pointerup", 50, 60);
  // The click the browser synthesises for the tap is not a second press.
  mouse("click", 50, 60);
  assert.deepEqual(activated, []);
  assert.deepEqual(readCard(), { target: { kind: "mail", id: "mail" }, x: 50, y: 60, pinned: true });
  hideCard();
  touch("pointerdown", 50, 60);
  touch("pointerup", 50, 90);
  assert.equal(readCard(), null);
  fire("pointerdown", { clientX: 50, clientY: 60, pointerType: "touch", timeStamp: 0 });
  fire("pointerup", { clientX: 50, clientY: 60, pointerType: "touch", timeStamp: 900 });
  assert.equal(readCard(), null);
});

test("a click on the UI puts a pinned card away", () => {
  touch("pointerdown", 50, 60);
  touch("pointerup", 50, 60);
  assert.equal(readCard()?.pinned, true);
  // Past the tap's synthesised click.
  mock.method(performance, "now", () => Number.MAX_SAFE_INTEGER);
  elementAt = () => el("button");
  click([10, 10]);
  mock.restoreAll();
  assert.equal(readCard(), null);
  assert.deepEqual(activated, []);
});
