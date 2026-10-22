import assert from "node:assert/strict";
import test from "node:test";
import {
  dirtyPaneIds,
  displayFilePath,
  forgetClosedPanes,
  formatBytes,
  normalizePath,
  paneDraft,
  parentPath,
  parseFileInput,
  rawUrl,
  resolveLocally,
  setPaneDirty,
  subscribeDirty,
} from "../src/lib/files.ts";

test("parseFileInput drops file:// and a line suffix, keeping the line", () => {
  assert.deepEqual(parseFileInput("/tmp/a.ts:42"), { path: "/tmp/a.ts", line: 42 });
  assert.deepEqual(parseFileInput("/tmp/a.ts:42:7"), { path: "/tmp/a.ts", line: 42 });
  assert.deepEqual(parseFileInput("docs/PLAN.md#L12"), { path: "docs/PLAN.md", line: 12 });
  assert.deepEqual(parseFileInput("file:///tmp/my%20notes.md"), { path: "/tmp/my notes.md", line: null });
  assert.deepEqual(parseFileInput("~/x"), { path: "~/x", line: null });
});

test("resolveLocally makes a path absolute from cwd and home, or says it cannot", () => {
  assert.equal(resolveLocally("/a/./b/../c/", null, null), "/a/c");
  assert.equal(resolveLocally("docs/PLAN.md", "/repo", null), "/repo/docs/PLAN.md");
  assert.equal(resolveLocally("../x", "/repo/sub", null), "/repo/x");
  assert.equal(resolveLocally("~/notes", null, "/Users/me"), "/Users/me/notes");
  assert.equal(resolveLocally("x", "~/repo", "/Users/me"), "/Users/me/repo/x");
  assert.equal(resolveLocally("~/notes", null, null), null);
  assert.equal(resolveLocally("x", null, "/Users/me"), null);
});

test("paths: parent, normalisation, home shown as ~, sizes, raw URLs", () => {
  assert.equal(parentPath("/a/b"), "/a");
  assert.equal(parentPath("/a"), "/");
  assert.equal(parentPath("/"), null);
  assert.equal(normalizePath("//a//b/"), "/a/b");
  assert.equal(displayFilePath("/Users/me/x", "/Users/me"), "~/x");
  assert.equal(displayFilePath("/Users/me", "/Users/me"), "~");
  assert.equal(displayFilePath("/Users/meow", "/Users/me"), "/Users/meow");
  assert.equal(displayFilePath("/x", null), "/x");
  assert.equal(formatBytes(12), "12 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2 MB");
  assert.equal(rawUrl("/a b", { download: true }), "/api/files/raw?path=%2Fa+b&download=1");
  assert.equal(rawUrl("/a", { version: "1-2" }), "/api/files/raw?path=%2Fa&v=1-2");
});

test("unsaved edits outlive a pane's remount, by pane and path, until saved or the pane closes", () => {
  let changes = 0;
  const unsubscribe = subscribeDirty(() => changes++);
  let text = "one";
  setPaneDirty("p1", { path: "/r/a.md", text: () => text, version: () => "v1" });
  assert.deepEqual([...dirtyPaneIds()], ["p1"]);
  // Read when taken back, not when recorded: the latest typing comes back.
  text = "one two";
  assert.deepEqual(paneDraft("p1", "/r/a.md"), { text: "one two", version: "v1" });
  // Another path in the same pane (it navigated) has none.
  assert.equal(paneDraft("p1", "/r/b.md"), null);
  // A remounted pane records its own readers: same pane, same path, no change to the set.
  setPaneDirty("p1", { path: "/r/a.md", text: () => "three", version: () => "v1" });
  assert.equal(changes, 1);
  assert.equal(paneDraft("p1", "/r/a.md").text, "three");
  setPaneDirty("p2", { path: "/r/c.md", text: () => "c", version: () => "v9" });
  forgetClosedPanes(new Set(["p1"]));
  assert.deepEqual([...dirtyPaneIds()], ["p1"]);
  setPaneDirty("p1", null);
  assert.equal(paneDraft("p1", "/r/a.md"), null);
  assert.equal(dirtyPaneIds().size, 0);
  unsubscribe();
});
