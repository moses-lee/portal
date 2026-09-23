import { expect, test } from "@playwright/test";
import { emitPortal, portalItem, setupPortal } from "./fixtures";
import { activityEntries, mainThread, octoEntity, reviewThread } from "./orchestrator-fixtures";

test("Activity shows the log newest first with its links, and filters by kind prefix", async ({ page }, info) => {
  await setupPortal(page, {
    portal: { threads: [mainThread, reviewThread], activity: activityEntries(), entities: [octoEntity] },
  });
  const searches: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/portal/activity")) searches.push(new URL(request.url()).search);
  });
  await page.goto("/portal/activity");
  const log = page.getByRole("list", { name: "Activity log" });
  const rows = log.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Proposed: octocat prefers squash merges.");
  await expect(rows.nth(1)).toContainText("Scheduled a check of example/portal#42 every 2 minutes.");
  await expect(rows.nth(1).getByRole("button", { name: reviewThread.title })).toBeVisible();
  await expect(rows.nth(1).getByRole("link", { name: /example\/portal#42/ })).toHaveAttribute("href", "https://github.com/example/portal/pull/42");
  await rows.nth(1).getByRole("button", { name: "Show details" }).click();
  await expect(rows.nth(1).getByText('"everyMs": 120000')).toBeVisible();
  await page.screenshot({ animations: "disabled", path: info.outputPath("activity.png") });

  await page.getByRole("group", { name: "Filter by kind" }).getByRole("button", { name: "Memory" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Proposed: octocat");
  expect(searches.at(-1)).toBe("?limit=50&kind=memory.");
});

test("live entries are prepended when they match the filter, and Load older pages with before", async ({ page }) => {
  await setupPortal(page, { portal: { activity: activityEntries(55) } });
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/portal/activity")) urls.push(new URL(request.url()).search);
  });
  await page.goto("/portal/activity");
  const rows = page.getByRole("list", { name: "Activity log" }).getByRole("listitem");
  await expect(rows).toHaveCount(50);
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(rows).toHaveCount(55);
  expect(urls).toContain("?limit=50");
  expect(urls.some((search) => /before=54\b/.test(search))).toBe(true);
  await expect(page.getByRole("button", { name: "Load older" })).toHaveCount(0);

  await emitPortal(page, {
    type: "activity",
    entry: { id: 200, at: Date.now(), actor: "agent", kind: "intent.created", summary: "Now watching #42 until it merges.", refs: {}, detail: null },
  });
  await expect(rows.nth(0)).toContainText("Now watching #42 until it merges.");

  // With a filter on, a live entry of another kind stays out.
  await page.getByRole("group", { name: "Filter by kind" }).getByRole("button", { name: "Tools" }).click();
  await expect(rows.first()).toContainText("Ran get_tick_digest");
  await emitPortal(page, {
    type: "activity",
    entry: { id: 201, at: Date.now(), actor: "user", kind: "item.dismissed", summary: "Dismissed a stale item.", refs: {}, detail: null },
  });
  await expect(page.getByText("Dismissed a stale item.")).toHaveCount(0);
  expect(urls.some((search) => search.includes("kind=tool."))).toBe(true);
});

test("activity links open the thread, the item, the session, and memory", async ({ page }) => {
  await setupPortal(page, {
    portal: { threads: [mainThread, reviewThread], activity: activityEntries(), entities: [octoEntity] },
  });
  await page.goto("/portal/activity");
  const rows = page.getByRole("list", { name: "Activity log" }).getByRole("listitem");

  await rows.nth(2).getByRole("button", { name: "Item" }).click();
  const dialog = page.getByRole("dialog", { name: "Item" });
  await expect(dialog.getByRole("article", { name: portalItem.title })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await rows.nth(0).getByRole("button", { name: "Memory record" }).click();
  await expect(page).toHaveURL(/\/portal\/memory\/e-octo$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/portal\/activity$/);

  await rows.nth(1).getByRole("button", { name: reviewThread.title }).click();
  await expect(page).toHaveURL(/\/portal\/threads\/t-review$/);
  await page.goBack();

  await rows.nth(2).getByRole("button", { name: "Session" }).click();
  await expect(page).toHaveURL(/\/sessions\/s1$/);
});
