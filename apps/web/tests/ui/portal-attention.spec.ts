import { expect, test, type Page } from "@playwright/test";
import { emitPortal, portalItem, setupPortal } from "./fixtures";
import type { Item, ItemKind } from "../../src/lib/orchestrator/types";

const min = 60_000;

/** An item of `kind`, last touched `ago` ms back; everything else is `portalItem`'s. */
function makeItem(id: string, kind: ItemKind, title: string, ago: number, extra: Partial<Item> = {}): Item {
  const at = Date.now() - ago;
  return { ...portalItem, id, kind, title, fingerprint: `${kind}:${id}`, actions: [], createdAt: at, updatedAt: at, ...extra };
}

const checks1 = makeItem("c1", "pr_checks_failing", "Checks are failing on example/portal#41", 2 * min);
const checks2 = makeItem("c2", "pr_checks_failing", "Checks are failing on example/portal#42", 20 * min);
const watch = makeItem("w1", "intent_update", "#40 merged", 5 * min);
// The oldest of all, yet its group comes first: approvals block work.
const approvalItem = makeItem("a1", "approval_needed", "Removing a worktree waits on you", 60 * min, { links: { approvalId: "gone" } });
const items = [checks1, checks2, watch, approvalItem];

const navOf = (page: Page) =>
  page.getByRole("complementary", { name: "Workspace sidebar" }).getByRole("navigation", { name: "Portal", exact: true });
/** The foyer card at the top of the sidebar: it names what waits and opens the Needs-your-attention page. */
const foyerOf = (page: Page) =>
  page.getByRole("complementary", { name: "Workspace sidebar" }).getByRole("button", { name: /Needs your attention|All caught up|Work in progress/ });
const viewOf = (page: Page) => page.getByRole("region", { name: "Needs your attention" });
const bulkRequests = (requests: { path: string; method: string; body: unknown }[]) =>
  requests.filter((r) => r.path === "/api/portal/items/bulk" && r.method === "POST");

test("the foyer card counts what waits and opens the page; no sidebar entry carries it", async ({ page }) => {
  await setupPortal(page, { portal: { items } });
  await page.goto("/");
  const nav = navOf(page);
  await expect(nav.getByRole("button")).toHaveText(["Chat", "Watches", "Activity", "Memory", "System", "Projects", "Terminal"]);
  await expect(nav.getByRole("button", { name: "Chat", exact: true })).toHaveText(/^Chat$/);
  const foyer = foyerOf(page);
  await expect(foyer).toContainText("4 items need you");
  await expect(foyer).not.toHaveAttribute("aria-current", "page");
  // The chat shows no item cards at all.
  await expect(page.getByRole("article")).toHaveCount(0);

  await foyer.click();
  await expect(page).toHaveURL(/\/attention$/);
  await expect(page.getByRole("heading", { name: "Needs your attention", level: 1 })).toBeVisible();
  await expect(foyer).toHaveAttribute("aria-current", "page");
  // No Portal entry is current: the page has none.
  await expect(nav.getByRole("button", { name: "Chat", exact: true })).not.toHaveAttribute("aria-current", "page");
});

test("with nothing waiting the foyer card still opens the page", async ({ page }) => {
  await setupPortal(page, { portal: { items: [] } });
  await page.goto("/");
  const foyer = foyerOf(page);
  await expect(foyer).toContainText("Everything is in place");
  await foyer.click();
  await expect(page).toHaveURL(/\/attention$/);
  await expect(viewOf(page).getByText(/^Nothing needs you\./)).toBeVisible();
});

test("Needs you groups the items by kind, approvals first, newest first inside a group", async ({ page }, info) => {
  await setupPortal(page, { portal: { items } });
  await page.goto("/attention");
  await expect(page.getByRole("heading", { name: "Needs your attention", level: 1 })).toBeVisible();
  const view = viewOf(page);
  await expect(view.getByRole("heading", { level: 2 })).toHaveText([
    /^Needs you\s*4$/,
    /^Needs approval\s*1$/,
    /^Checks failing\s*2$/,
    /^Watch update\s*1$/,
  ]);
  const checks = view.getByRole("region", { name: /^Checks failing/ });
  await expect(checks.getByRole("article")).toHaveText([new RegExp(checks1.title), new RegExp(checks2.title)]);
  await expect(view.getByRole("region", { name: /^Needs approval/ }).getByRole("article", { name: approvalItem.title })).toBeVisible();
  await expect(view.getByRole("region", { name: /^Watch update/ }).getByRole("article", { name: watch.title })).toBeVisible();
  // A card's header opens its menu on right-click, as the … button does.
  await view.getByRole("heading", { name: watch.title }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Snooze 1h" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ animations: "disabled", fullPage: true, path: info.outputPath("attention.png") });
});

test("a group's Resolve asks once more, then resolves exactly that group in one request", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: { items } });
  await page.goto("/attention");
  const view = viewOf(page);
  const checks = view.getByRole("region", { name: /^Checks failing/ });
  await checks.getByRole("button", { name: "Resolve checks failing" }).click();
  // The first click only arms the button.
  await expect(checks.getByRole("button", { name: "Resolve 2 items" })).toBeVisible();
  expect(bulkRequests(fixture.requests)).toHaveLength(0);
  await checks.getByRole("button", { name: "Resolve 2 items" }).click();

  await expect(view.getByRole("region", { name: /^Checks failing/ })).toHaveCount(0);
  await expect(view.getByRole("article", { name: checks1.title })).toHaveCount(0);
  await expect(view.getByRole("article", { name: checks2.title })).toHaveCount(0);
  await expect(view.getByRole("article")).toHaveCount(2);
  await expect(foyerOf(page)).toContainText("2 items need you");
  const sent = bulkRequests(fixture.requests);
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toEqual({ ids: [checks1.id, checks2.id], status: "resolved" });
  expect(fixture.portalLive.items.filter((row) => row.status === "resolved").map((row) => row.id).sort()).toEqual(["c1", "c2"]);
});

test("Dismiss all asks once more, then dismisses every item on the page and leaves the empty state", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: { items } });
  await page.goto("/attention");
  const view = viewOf(page);
  await view.getByRole("button", { name: "Dismiss all" }).click();
  await expect(view.getByRole("button", { name: "Dismiss 4 items" })).toBeVisible();
  expect(bulkRequests(fixture.requests)).toHaveLength(0);
  await view.getByRole("button", { name: "Dismiss 4 items" }).click();

  await expect(view.getByText(/^Nothing needs you\./)).toBeVisible();
  await expect(view.getByRole("article")).toHaveCount(0);
  await expect(foyerOf(page)).toContainText("Everything is in place");
  const sent = bulkRequests(fixture.requests);
  expect(sent).toHaveLength(1);
  const body = sent[0].body as { ids: string[]; status: string };
  expect(body.status).toBe("dismissed");
  expect([...body.ids].sort()).toEqual(items.map((item) => item.id).sort());
});

test("items snoozed for later wait folded away and do not count; a lapsed snooze counts again", async ({ page }) => {
  const later = makeItem("s-later", "pr_conflicts", "Merge conflicts on example/portal#43", 3 * min, {
    status: "snoozed",
    snoozedUntil: Date.now() + 3 * 60 * min,
  });
  const lapsed = makeItem("s-lapsed", "pr_review_requested", "Review requested on example/portal#44", 4 * min, {
    status: "snoozed",
    snoozedUntil: Date.now() - min,
  });
  await setupPortal(page, { portal: { items: [checks1, later, lapsed] } });
  await page.goto("/attention");
  const view = viewOf(page);
  await expect(foyerOf(page)).toContainText("2 items need you");
  await expect(view.getByRole("heading", { level: 2, name: /^Needs you/ })).toHaveText(/^Needs you\s*2$/);
  await expect(view.getByRole("region", { name: /^Review requested/ }).getByRole("article", { name: lapsed.title })).toBeVisible();

  // The future snooze sits under a closed Snoozed section.
  await expect(view.getByRole("article", { name: later.title })).toHaveCount(0);
  const snoozed = view.getByRole("button", { name: /^Snoozed\s*1$/ });
  await expect(snoozed).toHaveAttribute("aria-expanded", "false");
  await snoozed.click();
  await expect(snoozed).toHaveAttribute("aria-expanded", "true");
  await expect(view.getByRole("article", { name: later.title })).toBeVisible();
  await expect(view.getByText(/^Back in/)).toBeVisible();
});

test("with nothing waiting the page says so and offers no bulk actions", async ({ page }) => {
  await setupPortal(page, { portal: { items: [] } });
  await page.goto("/attention");
  const view = viewOf(page);
  await expect(view.getByText(/^Nothing needs you\./)).toBeVisible();
  await expect(view.getByRole("button", { name: /^(Resolve|Dismiss)/ })).toHaveCount(0);
  await expect(view.getByRole("button", { name: /^Snoozed/ })).toHaveCount(0);
  await expect(foyerOf(page)).toContainText("Everything is in place");
});

test("an items event adds to the page and the foyer card live", async ({ page }) => {
  await setupPortal(page, { portal: { items: [checks1] } });
  await page.goto("/attention");
  const view = viewOf(page);
  const badge = foyerOf(page);
  await expect(badge).toContainText("1 item needs you");
  await emitPortal(page, { type: "items", items: [checks1, watch] });
  await expect(view.getByRole("region", { name: /^Watch update/ }).getByRole("article", { name: watch.title })).toBeVisible();
  await expect(badge).toContainText("2 items need you");
});
