import { expect, test } from "@playwright/test";
import { firstTitle, setupPortal } from "./fixtures";
import { pane, split, tab, workspaceOf } from "./workspace-fixtures";
import { enterPalace, showPage } from "./surfaces";

// Overlays must preserve the actual workspace instances, not recreate the same route on close.
test("pages cover tabs while preserving split panes, drafts, terminal state, and URL", async ({ page }) => {
  const fixture = await setupPortal(page, { workspace: workspaceOf([tab("t1", split("x1", "row", [pane("p1", "s1"), pane("p2", "s2")]))]) });
  await page.goto("/tabs/t1?pane=p2");
  const first = page.locator('[data-pane="p1"]');
  const second = page.locator('[data-pane="p2"]');
  const draft = second.getByRole("combobox", { name: "Message Codex", exact: true });
  await first.getByRole("button", { name: "Show terminal" }).click();
  const terminal = first.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal).toBeVisible();
  await draft.fill("Keep this draft in this exact pane");
  const url = page.url();
  const draftNode = await draft.elementHandle();
  const terminalNode = await terminal.elementHandle();
  const reads = fixture.requests.filter((request) => request.path === "/api/sessions/s2/events").length;
  const strip = page.getByRole("tablist", { name: "Workspace tabs" });
  for (const view of ["watches", "activity", "memory", "system", "attention"] as const) {
    await showPage(page, view);
    await expect(strip).toBeHidden();
    await expect(draft).toBeHidden();
    await expect(page).toHaveURL(url);
    await expect(page.locator("[data-workspace-layer]")).toHaveAttribute("inert", "");
    expect(await draftNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await terminalNode!.evaluate((node) => node.isConnected)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-page-overlay]")).toHaveCount(0);
  await expect(strip).toBeVisible();
  await expect(draft).toHaveValue("Keep this draft in this exact pane");
  await expect(terminal).toBeVisible();
  await expect(page.locator('[data-pane-frame="p2"]')).toHaveAttribute("data-focused", "true");
  await expect(page).toHaveURL(url);
  expect(fixture.requests.filter((request) => request.path === "/api/sessions/s2/events")).toHaveLength(reads);
});

test("a page opened from Palace mode leaves it, and closing the page shows the workspace as it was", async ({ page }) => {
  await setupPortal(page, { workspace: workspaceOf([tab("t1", pane("p1", "s1"))]) });
  await page.goto("/tabs/t1");
  await enterPalace(page);
  // What a room object (the mail tray) asks for.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("portal:navigate", { detail: "/attention" })));
  await expect(page.getByRole("heading", { name: "Needs your attention", level: 1 })).toBeVisible();
  await expect(page.locator(".portal-shell")).not.toHaveAttribute("data-palace-mode");
  await page.getByRole("button", { name: "Close page", exact: true }).click();
  await expect(page.getByRole("tab", { name: firstTitle, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/tabs\/t1$/);
});

test("a covered focused tab accrues unread updates until the page closes", async ({ page }) => {
  await setupPortal(page, { workspace: workspaceOf([tab("t1", pane("p1", "s1"))]) });
  await page.goto("/tabs/t1");
  await showPage(page, "watches");
  await page.evaluate(() => window.__portalEmit("/api/sessions/stream", { type: "updated", id: "s1", patch: { turnEndedAt: Date.now() } }, "message"));
  await expect(page.locator('[data-tab-trigger="t1"] [data-unread]')).toHaveCount(1);
  await page.getByRole("button", { name: "Close page", exact: true }).click();
  await expect(page.getByRole("tab", { name: firstTitle, exact: true })).toBeVisible();
  await expect(page.locator('[data-tab-trigger="t1"] [data-unread]')).toHaveCount(0);
});

test("retired page URLs no longer serve standalone screens", async ({ page }) => {
  await setupPortal(page);
  for (const path of ["/watches", "/memory/e-global", "/chat", "/terminal"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("main", { name: "Agent", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-page-overlay]")).toHaveCount(0);
  }
});


test("a slow session resolver can finish underneath an open page without dismissing it", async ({ page }) => {
  await setupPortal(page);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/workspace/ops", async (route) => {
    started();
    await paused;
    await route.fallback();
  });
  await page.goto("/sessions/s1");
  await inFlight;
  await showPage(page, "watches");
  release();
  await expect(page).toHaveURL(/\/tabs\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "Watches", level: 1 })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toBeHidden();
  await page.getByRole("button", { name: "Close page", exact: true }).click();
  await expect(page.locator('[data-pane][data-session="s1"]')).toBeVisible();
});
