import { expect, test } from "@playwright/test";
import { emit, setupPortal } from "./fixtures";

const queued = (id: string, text: string) => ({ id, text, queuedAt: 1 });

test("a message sent while the agent works is queued, listed, and can be edited back into the composer or removed", async ({ page }) => {
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

  // Edit takes the prompt out of the queue and into the composer, ahead of the draft.
  await composer.fill("draft in progress");
  await items.nth(1).getByRole("button", { name: "Edit queued prompt" }).click();
  await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith("/queue/q2")).map((r) => r.method)).toEqual(["DELETE"]);
  await expect(composer).toHaveValue("and open a PR\ndraft in progress");
  await emit(page, { queue: [queued("q1", "then run the tests")] });
  await expect(items).toHaveCount(1);

  // Remove just drops it.
  await items.nth(0).getByRole("button", { name: "Remove queued prompt" }).click();
  await expect.poll(() => fixture.requests.filter((r) => r.path.endsWith("/queue/q1")).map((r) => r.method)).toEqual(["DELETE"]);
  await emit(page, { queue: [] });
  await expect(list).toHaveCount(0);

  // Idle with prompts still queued: the queue is held after an error, and the header says so.
  await emit(page, { busy: false, queue: [queued("q3", "retry me")] });
  await expect(list).toContainText("waiting; send, edit, or remove a prompt");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
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

test("the tracked panel's composer queues too", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: { tracked: [{ sessionId: "s2", trackedAt: 1, trackedBy: "user" }] } });
  await page.goto("/?session=s2");
  const composer = page.getByLabel("Message Codex", { exact: true });
  await expect(composer).toBeVisible();
  await page.evaluate(() => window.__portalEmit("/api/sessions/s2/stream", { busy: true, queue: [{ id: "q1", text: "queued in panel", queuedAt: 1 }] }, "meta", 100));
  await expect(page.getByRole("region", { name: "Queued prompts" })).toContainText("queued in panel");
  await composer.fill("one more");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  await expect.poll(() => fixture.requests.filter((r) => r.path === "/api/sessions/s2/prompt").map((r) => r.body)).toEqual([{ text: "one more", queue: true }]);
});

test("editing a prompt that already went out restores nothing, so it never runs twice", async ({ page }) => {
  await setupPortal(page, { queueRemoved: false });
  await page.goto("/sessions/s1");
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await expect(composer).toBeVisible();
  await emit(page, { busy: true, queue: [queued("q1", "already running")] });
  const list = page.getByRole("region", { name: "Queued prompts" });
  await list.getByRole("button", { name: "Edit queued prompt 1" }).click();
  await emit(page, { queue: [] });
  await expect(list).toHaveCount(0);
  await expect(composer).toHaveValue("");
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
