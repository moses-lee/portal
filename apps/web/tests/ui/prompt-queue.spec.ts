import { expect, test } from "@playwright/test";
import { emit, sessions, setupPortal } from "./fixtures";

const queued = (id: string, text: string, editing = false) => ({ id, text, queuedAt: 1, editing });

test("a message sent while the agent works is queued, listed, and can be edited in place or removed", async ({ page }) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await expect(composer).toBeVisible();
  await emit(page, { busy: true });
  // Both buttons: Stop, and the arrow, which now queues.
  await expect(page.getByRole("button", { name: "Stop agent" })).toBeVisible();
  const queue = page.getByRole("button", { name: "Queue message", exact: true });
  await expect(queue).toBeVisible();
  await composer.fill("then run the tests");
  await composer.press("Enter");
  await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith("/prompt")).map((r) => r.body)).toEqual([
    { text: "then run the tests", queue: true },
  ]);
  await expect(composer).toHaveValue("");

  // The server's meta carries the queue; the list shows it above the composer, first to go out first.
  await emit(page, { busy: true, queue: [queued("q1", "then run the tests"), queued("q2", "and open a PR")] });
  const list = page.getByRole("region", { name: "Queued prompts" });
  await expect(list).toContainText("Queued · 2 of 10");
  const items = list.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("then run the tests");
  await expect(items.nth(1)).toContainText("and open a PR");
  // Working: no held note.
  await expect(list).not.toContainText("waiting;");

  // Edit keeps the prompt in its slot, marks it, pauses the queue, and puts its text into the composer ahead of the draft.
  await composer.fill("draft in progress");
  await items.nth(1).getByRole("button", { name: "Edit queued prompt" }).click();
  await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith("/queue/q2/edit")).map((r) => r.method)).toEqual(["POST"]);
  await expect(composer).toHaveValue("and open a PR\ndraft in progress");
  await expect(page.getByText("Editing queued prompt 2")).toBeVisible();
  await emit(page, { queue: [queued("q1", "then run the tests"), queued("q2", "and open a PR", true)] });
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toContainText("editing");
  await expect(items.nth(1)).not.toContainText("another tab");
  await expect(list).toContainText("paused while a prompt is edited");

  // Enter saves the text into the same slot (PATCH, not a new prompt) and ends the edit; the composer clears.
  await composer.fill("and open a draft PR");
  await page.getByRole("button", { name: "Save queued prompt", exact: true }).click();
  await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith("/queue/q2")).map((r) => [r.method, r.body])).toEqual([
    ["PATCH", { text: "and open a draft PR" }],
  ]);
  expect(fixture.requests.filter((r) => r.path.endsWith("/prompt"))).toHaveLength(1);
  await expect(composer).toHaveValue("");
  await expect(page.getByText("Editing queued prompt 2")).toHaveCount(0);
  await emit(page, { queue: [queued("q1", "then run the tests"), queued("q2", "and open a draft PR")] });
  await expect(items.nth(1)).toContainText("and open a draft PR");
  await expect(items.nth(1)).not.toContainText("editing");
  await expect(list).not.toContainText("paused");

  // Remove just drops it.
  await items.nth(0).getByRole("button", { name: "Remove queued prompt" }).click();
  await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith("/queue/q1")).map((r) => r.method)).toEqual(["DELETE"]);
  await emit(page, { queue: [queued("q2", "and open a draft PR")] });
  await expect(items).toHaveCount(1);

  // Idle with prompts still queued: the queue is held after an error, and the header says so.
  await emit(page, { busy: false, queue: [queued("q3", "retry me")] });
  await expect(list).toContainText("waiting; send, edit, or remove a prompt");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
});

test("cancelling an edit keeps the prompt's original text in its slot and the composer's text in the composer", async ({ page }) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await expect(composer).toBeVisible();
  await emit(page, { busy: true, queue: [queued("q1", "first"), queued("q2", "second")] });
  const list = page.getByRole("region", { name: "Queued prompts" });
  await list.getByRole("button", { name: "Edit queued prompt 1" }).click();
  await expect(composer).toHaveValue("first");
  await expect(page.getByText("Editing queued prompt 1")).toBeVisible();
  await emit(page, { busy: true, queue: [queued("q1", "first", true), queued("q2", "second")] });
  await composer.fill("first, changed my mind");
  await page.getByRole("button", { name: "Cancel edit" }).click();
  await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith("/queue/q1/edit")).map((r) => r.method)).toEqual(["POST", "DELETE"]);
  await expect(page.getByText("Editing queued prompt 1")).toHaveCount(0);
  await expect(composer).toHaveValue("first, changed my mind");
  expect(fixture.requests.filter((r) => r.path.endsWith("/queue/q1"))).toHaveLength(0);
  await emit(page, { busy: true, queue: [queued("q1", "first"), queued("q2", "second")] });
  await expect(list.getByRole("listitem").nth(0)).toContainText("first");
  await expect(list).not.toContainText("paused");
  // Back to queueing: Enter now queues a new prompt, as before the edit.
  await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeVisible();
});

test("an edit survives a reload, and ends when the prompt leaves the queue", async ({ page }) => {
  // The list entry seeds the queue before the stream's first meta, and the fixture's meta mirrors it.
  await setupPortal(page, {
    sessions: sessions.map((session) => (session.id === "s1" ? { ...session, queue: [queued("q1", "keep editing me")] } : session)),
  });
  await page.goto("/sessions/s1");
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await expect(composer).toBeVisible();
  const list = page.getByRole("region", { name: "Queued prompts" });
  await list.getByRole("button", { name: "Edit queued prompt 1" }).click();
  await expect(composer).toHaveValue("keep editing me");
  await composer.fill("keep editing me, please");
  await expect(page.getByText("Editing queued prompt 1")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Message Claude Code", { exact: true })).toHaveValue("keep editing me, please");
  await expect(page.getByText("Editing queued prompt 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save queued prompt", exact: true })).toBeVisible();

  // Removed elsewhere (or sent, or dropped by Stop): the edit ends; the text stays.
  await emit(page, { queue: [] });
  await expect(page.getByText("Editing queued prompt 1")).toHaveCount(0);
  await expect(page.getByLabel("Message Claude Code", { exact: true })).toHaveValue("keep editing me, please");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
});

test("a prompt being edited in another tab is marked, and pauses the queue without a held note", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  await expect(page.getByLabel("Message Claude Code", { exact: true })).toBeVisible();
  await emit(page, { busy: false, queue: [queued("q1", "first"), queued("q2", "second", true)] });
  const list = page.getByRole("region", { name: "Queued prompts" });
  const items = list.getByRole("listitem");
  await expect(items.nth(1)).toContainText("editing in another tab");
  await expect(items.nth(0)).not.toContainText("editing");
  await expect(list).toContainText("paused while a prompt is edited");
  // Idle and paused is expected, so the held note stays away past its usual delay.
  await page.waitForTimeout(2000);
  await expect(list).not.toContainText("waiting;");
  // This view's composer is not editing.
  await expect(page.getByText(/Editing queued prompt/)).toHaveCount(0);
  // The pencil still works on it: this view takes the edit over.
  await items.nth(1).getByRole("button", { name: "Edit queued prompt 2" }).click();
  await expect(page.getByText("Editing queued prompt 2")).toBeVisible();
  await expect(items.nth(1)).toContainText("editing");
  await expect(items.nth(1)).not.toContainText("another tab");
});

test("moving the edit to another prompt marks the new one before the old edit ends, so the queue never unpauses", async ({ page }) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await expect(composer).toBeVisible();
  await emit(page, { busy: false, queue: [queued("q1", "first"), queued("q2", "second")] });
  const list = page.getByRole("region", { name: "Queued prompts" });
  await list.getByRole("button", { name: "Edit queued prompt 2" }).click();
  await expect(page.getByText("Editing queued prompt 2")).toBeVisible();
  await emit(page, { busy: false, queue: [queued("q1", "first"), queued("q2", "second", true)] });
  await list.getByRole("button", { name: "Edit queued prompt 1" }).click();
  await expect(page.getByText("Editing queued prompt 1")).toBeVisible();
  await expect.poll(() => fixture.requests.filter((r) => r.path.includes("/queue/")).map((r) => `${r.method} ${r.path.split("/queue/")[1]}`)).toEqual([
    "POST q2/edit",
    "POST q1/edit",
    "DELETE q2/edit",
  ]);
  // Both texts are in the composer: the first edit's text stays, the new prompt goes ahead of it.
  await expect(composer).toHaveValue("first\nsecond");
});

test("saving an edit of a prompt that has gone meanwhile ends the edit and keeps the text", async ({ page }) => {
  const fixture = await setupPortal(page, { queueSaveMissing: true });
  await page.goto("/sessions/s1");
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await expect(composer).toBeVisible();
  await emit(page, { busy: true, queue: [queued("q1", "going out")] });
  await page.getByRole("region", { name: "Queued prompts" }).getByRole("button", { name: "Edit queued prompt 1" }).click();
  await expect(composer).toHaveValue("going out");
  await composer.press("Enter");
  await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith("/queue/q1")).map((r) => r.method)).toEqual(["PATCH"]);
  await expect(page.getByRole("alert").filter({ hasText: "no longer in the queue" })).toContainText(
    "That queued prompt is no longer in the queue.",
  );
  await expect(page.getByText("Editing queued prompt 1")).toHaveCount(0);
  await expect(composer).toHaveValue("going out");
  expect(fixture.requests.filter((r) => r.path.endsWith("/prompt"))).toHaveLength(0);
});

test("Stop hands the dropped queue back to the composer", async ({ page }) => {
  await setupPortal(page, { cancelQueued: [queued("q1", "first follow-up"), queued("q2", "second follow-up")] });
  await page.goto("/sessions/s1");
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await expect(composer).toBeVisible();
  await emit(page, { busy: true, queue: [queued("q1", "first follow-up"), queued("q2", "second follow-up")] });
  await composer.fill("typing this");
  await page.getByRole("button", { name: "Stop agent" }).click();
  await expect(composer).toHaveValue("first follow-up\nsecond follow-up\ntyping this");
  await emit(page, { queue: [] });
  await emit(page, { type: "turn_end", stopReason: "cancelled" }, "message", 104);
  await expect(page.getByRole("region", { name: "Queued prompts" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
});

test("Stop while editing hands the other prompts back and ends the edit; the edited text is not doubled", async ({ page }) => {
  await setupPortal(page, { cancelQueued: [queued("q1", "first follow-up", true), queued("q2", "second follow-up")] });
  await page.goto("/sessions/s1");
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await expect(composer).toBeVisible();
  await emit(page, { busy: true, queue: [queued("q1", "first follow-up"), queued("q2", "second follow-up")] });
  await page.getByRole("region", { name: "Queued prompts" }).getByRole("button", { name: "Edit queued prompt 1" }).click();
  await expect(composer).toHaveValue("first follow-up");
  await emit(page, { busy: true, queue: [queued("q1", "first follow-up", true), queued("q2", "second follow-up")] });
  await composer.fill("first follow-up, reworded");
  await page.getByRole("button", { name: "Stop agent" }).click();
  // The edited prompt is already in the composer, so only the other one comes back.
  await expect(composer).toHaveValue("second follow-up\nfirst follow-up, reworded");
  await emit(page, { queue: [] });
  await expect(page.getByText("Editing queued prompt 1")).toHaveCount(0);
  await expect(page.getByText("Editing a queued prompt")).toHaveCount(0);
  await emit(page, { type: "turn_end", stopReason: "cancelled" }, "message", 104);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
});

test("the tracked panel's composer queues too", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: { tracked: [{ sessionId: "s2", trackedAt: 1, trackedBy: "user" }] } });
  await page.goto("/?session=s2");
  const composer = page.getByLabel("Message Codex", { exact: true });
  await expect(composer).toBeVisible();
  await page.evaluate(() => window.__portalEmit("/api/sessions/s2/stream", { busy: true, queue: [{ id: "q1", text: "queued in panel", queuedAt: 1, editing: false }] }, "meta", 100));
  await expect(page.getByRole("region", { name: "Queued prompts" })).toContainText("queued in panel");
  await composer.fill("one more");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  await expect.poll(() => fixture.requests.filter((r) => r.path === "/api/sessions/s2/prompt").map((r) => r.body)).toEqual([{ text: "one more", queue: true }]);
});

test("editing a prompt that already went out restores nothing, so it never runs twice", async ({ page }) => {
  const fixture = await setupPortal(page, { queueEditMissing: true });
  await page.goto("/sessions/s1");
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await expect(composer).toBeVisible();
  await emit(page, { busy: true, queue: [queued("q1", "already running")] });
  const list = page.getByRole("region", { name: "Queued prompts" });
  await list.getByRole("button", { name: "Edit queued prompt 1" }).click();
  await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith("/queue/q1/edit")).map((r) => r.method)).toEqual(["POST"]);
  await expect(page.getByText("That queued prompt is no longer in the queue.")).toBeVisible();
  await emit(page, { queue: [] });
  await expect(list).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(page.getByText(/Editing queued prompt/)).toHaveCount(0);
});

test("a take-back during a send in flight waits, so the sent text is cleared and not sent again", async ({ page }) => {
  const fixture = await setupPortal(page, { cancelQueued: [queued("q1", "taken back")] });
  fixture.delaySend(1500);
  await page.goto("/sessions/s1");
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await expect(composer).toBeVisible();
  await emit(page, { busy: true, queue: [queued("q1", "taken back")] });
  await composer.fill("in flight");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Sending message" })).toBeVisible();
  await page.getByRole("button", { name: "Stop agent" }).click();
  // Until the send resolves the draft keeps the in-flight text only.
  await expect(composer).toHaveValue("in flight");
  await expect(composer).toHaveValue("taken back", { timeout: 5000 });
  expect(fixture.requests.filter((r) => r.path.endsWith("/prompt"))).toHaveLength(1);
});
