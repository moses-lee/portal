import { expect, test, type Locator, type Page } from "@playwright/test";
import { setupPortal } from "./fixtures";
import { pane, tab, workspaceOf } from "./workspace-fixtures";
import { enterPalace, showPage } from "./surfaces";

/** The glass shell (docs/GLASS.md): floating panels, the sidebar's collapse, Palace mode. */

const radiusOf = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).borderTopLeftRadius);

test("the sidebar, the centre and the inspector float inset from the window, rounded, with the room between them", async ({ page }, info) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  const { width, height } = page.viewportSize()!;
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  await expect(sidebar).toHaveClass(/\bliquid\b/);
  const box = (await sidebar.boundingBox())!;
  expect(box.x).toBe(10);
  expect(box.y).toBe(10);
  expect(height - (box.y + box.height)).toBe(10);
  expect(await radiusOf(sidebar)).toBe("18px");
  const centre = page.locator("[data-shell-centre]");
  const centreBox = (await centre.boundingBox())!;
  expect(centreBox.x - (box.x + box.width)).toBe(10);
  expect(await radiusOf(centre)).toBe("18px");
  expect(await centre.evaluate((node) => getComputedStyle(node).overflow)).toBe("hidden");
  // The inspector is the shell's third panel, not part of the centre.
  await page.getByRole("button", { name: "Open GitHub inspector" }).first().click();
  const inspector = page.getByRole("complementary", { name: "GitHub inspector" });
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveClass(/\bliquid\b/);
  expect(await inspector.evaluate((node) => node.closest("[data-shell-centre]") === null && node.parentElement?.classList.contains("portal-shell"))).toBe(true);
  // Once its slide-in has settled.
  await expect.poll(async () => { const b = (await inspector.boundingBox())!; return width - (b.x + b.width); }).toBe(10);
  const inspectorBox = (await inspector.boundingBox())!;
  expect(inspectorBox.x - (centreBox.x + (await centre.boundingBox())!.width)).toBe(10);
  expect(await radiusOf(inspector)).toBe("18px");
  await page.screenshot({ path: info.outputPath("floating-panels.png") });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the logo in the sheet closes it and enters Palace mode; the pinned logo leaves", async ({ page }) => {
    await setupPortal(page);
    await page.goto("/sessions/s1");
    await page.getByRole("button", { name: "Toggle sidebar" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Your workspace" });
    await sheet.getByRole("button", { name: "Show the room" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(shell(page)).toHaveAttribute("data-palace-mode", "away");
    await expect(pinned(page)).toBeFocused();
    expect(await awayOf(page.locator("[data-shell-centre]"))).toBe(true);
    const box = (await pinned(page).boundingBox())!;
    expect([box.x, box.y]).toEqual([12, 12]);
    await pinned(page).click();
    await expect(shell(page)).not.toHaveAttribute("data-palace-mode");
    await expect(page.locator(".composer")).toBeVisible();
    // Esc is a desktop key only.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    await expect(shell(page)).not.toHaveAttribute("data-palace-mode");
  });

  test("the centre is full-bleed and the sidebar sheet floats inset and rounded over an unblurred dim", async ({ page }, info) => {
    await setupPortal(page);
    await page.goto("/sessions/s1");
    const centre = (await page.locator("[data-shell-centre]").boundingBox())!;
    expect(centre.x).toBe(0);
    expect(centre.width).toBe(390);
    await page.getByRole("button", { name: "Toggle sidebar" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Your workspace" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveClass(/\bliquid\b/);
    // Settled after its slide.
    await expect.poll(async () => (await sheet.boundingBox())!.x).toBe(8);
    const box = (await sheet.boundingBox())!;
    expect(box.y).toBe(8);
    expect(844 - (box.y + box.height)).toBe(8);
    expect(await radiusOf(sheet)).toBe("22px");
    const overlay = page.locator('[data-slot="sheet-overlay"]');
    expect(await overlay.evaluate((node) => getComputedStyle(node).backdropFilter)).toBe("none");
    await page.screenshot({ path: info.outputPath("phone-sheet.png") });
  });
});

/** Records every change of the root's `data-room-motion` (the room loop's motion boost) from now on, as "on"/"off". */
const recordMotion = (page: Page) =>
  page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __motion: string[] }).__motion = seen;
    new MutationObserver(() => seen.push(document.documentElement.hasAttribute("data-room-motion") ? "on" : "off")).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-room-motion"],
    });
  });
const motionSeen = (page: Page) => page.evaluate(() => (window as unknown as { __motion: string[] }).__motion);

test("the sidebar slides out and back in, boosting the room while it moves, and ends in the right state", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  const centre = page.locator("[data-shell-centre]");
  await expect(sidebar).toBeVisible();
  const width = (await sidebar.boundingBox())!.width;
  await recordMotion(page);
  await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
  // Still mounted while it slides.
  expect(await page.locator(".sidebar-shell").count()).toBe(1);
  await expect(page.locator(".sidebar-shell")).toHaveCount(0);
  await expect.poll(async () => (await centre.boundingBox())!.x).toBe(10);
  await expect(page.locator("html")).not.toHaveAttribute("data-room-motion");
  expect(await motionSeen(page)).toEqual(["on", "off"]);

  await page.getByRole("button", { name: "Toggle sidebar" }).first().click();
  await expect(sidebar).toBeVisible();
  await expect.poll(async () => (await centre.boundingBox())!.x).toBe(10 + width + 10);
  expect((await sidebar.boundingBox())!.x).toBe(10);
  await expect(page.locator("html")).not.toHaveAttribute("data-room-motion");
  expect(await motionSeen(page)).toEqual(["on", "off", "on", "off"]);
});

test("under reduced motion the sidebar collapses and expands at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setupPortal(page);
  await page.goto("/sessions/s1");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  await expect(sidebar).toBeVisible();
  await recordMotion(page);
  await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
  // Gone in the click's own render, with no slide and no boost.
  expect(await page.locator(".sidebar-shell").count()).toBe(0);
  expect((await page.locator("[data-shell-centre]").boundingBox())!.x).toBe(10);
  await page.getByRole("button", { name: "Toggle sidebar" }).first().click();
  expect(await page.locator(".sidebar-shell").count()).toBe(1);
  expect((await sidebar.boundingBox())!.x).toBe(10);
  expect(await motionSeen(page)).toEqual([]);
});

const shell = (page: Page) => page.locator(".portal-shell");
const pinned = (page: Page) => page.getByRole("button", { name: "Back to workspace" });
/** Whether the element is hidden and inert, as the panels are once Palace mode has sent them out. */
const awayOf = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).visibility === "hidden" && node.closest("[inert]") !== null);
/** The sidebar's shortcut hint renders once the page has hydrated, and the key listeners with it. */
const hydrated = (page: Page) => expect(page.getByText(/^(⌘K|Ctrl K)$/)).toBeVisible();

test("the logo enters Palace mode: the panels slide out, hidden and inert, and the pinned logo takes focus and brings them back", async ({ page }, info) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  await page.getByRole("button", { name: "Open GitHub inspector" }).first().click();
  const sidebar = page.locator(".sidebar-slot");
  const centre = page.locator("[data-shell-centre]");
  const inspector = page.locator(".shell-inspector");
  await expect(inspector).toBeVisible();
  await recordMotion(page);
  const logo = page.getByRole("complementary", { name: "Workspace sidebar" }).getByRole("button", { name: "Show the room" });
  await logo.click();
  await expect(pinned(page)).toBeFocused();
  // Out past the window's edges; the centre faded and a little smaller.
  await expect(shell(page)).toHaveAttribute("data-palace-mode", "away");
  expect((await sidebar.boundingBox())!.x + (await sidebar.boundingBox())!.width).toBeLessThanOrEqual(0);
  expect((await inspector.boundingBox())!.x).toBeGreaterThanOrEqual(page.viewportSize()!.width);
  expect(await centre.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");
  for (const panel of [sidebar, centre, inspector]) expect(await awayOf(panel)).toBe(true);
  await expect(page.locator(".room-scene")).toHaveAttribute("data-view", "palace");
  await expect(pinned(page)).toHaveClass(/\bliquid\b/);
  // The pinned logo sits where the sidebar's was.
  const mark = (await pinned(page).locator("img").boundingBox())!;
  expect(Math.round(mark.x + mark.width / 2)).toBe(44);
  expect(Math.round(mark.y + mark.height / 2)).toBe(44);
  await page.screenshot({ path: info.outputPath("palace-mode.png") });
  await expect(page.locator("html")).not.toHaveAttribute("data-room-motion");
  expect(await motionSeen(page)).toEqual(["on", "off"]);

  await pinned(page).click();
  await expect(pinned(page)).toHaveCount(0);
  await expect(shell(page)).not.toHaveAttribute("data-palace-mode");
  await expect(logo).toBeFocused();
  await expect(page.locator(".room-scene")).not.toHaveAttribute("data-view");
  for (const panel of [sidebar, centre, inspector]) expect(await awayOf(panel)).toBe(false);
  await expect.poll(async () => (await sidebar.boundingBox())!.x).toBe(10);
  expect(await motionSeen(page)).toEqual(["on", "off", "on", "off"]);
});

test("Esc enters and leaves Palace mode, but not from a terminal, a composer with text, an open menu or the Agent dialog", async ({ page }) => {
  await setupPortal(page, { workspace: workspaceOf([tab("t1", pane("p1", "s1"))]) });
  await page.goto("/tabs/t1");
  await hydrated(page);
  const composer = page.getByRole("combobox", { name: "Message Claude Code", exact: true });
  await composer.fill("A draft");
  await composer.press("Escape");
  await expect(composer).toBeFocused();
  await expect(shell(page)).not.toHaveAttribute("data-palace-mode");
  // An empty composer counts as empty.
  await composer.fill("");
  await composer.press("Escape");
  await expect(pinned(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pinned(page)).toHaveCount(0);
  await expect(composer).toBeFocused();

  // A menu takes its own Esc.
  await page.getByRole("button", { name: "Actions for project portal" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(shell(page)).not.toHaveAttribute("data-palace-mode");

  // So does the Agent dialog.
  await page.keyboard.press("ControlOrMeta+k");
  const agent = page.getByRole("dialog", { name: "Agent", exact: true });
  await expect(agent).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(agent).toHaveCount(0);
  await expect(shell(page)).not.toHaveAttribute("data-palace-mode");

  // And a terminal: Esc is the shell's. The mocked server starts no shell, so xterm's own input
  // element stands in, as xterm mounts it (an empty textarea inside `.xterm`).
  await page.locator('[data-pane="p1"]').evaluate((node) => {
    const xterm = Object.assign(document.createElement("div"), { className: "xterm" });
    xterm.append(Object.assign(document.createElement("textarea"), { className: "xterm-helper-textarea" }));
    node.append(xterm);
  });
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(shell(page)).not.toHaveAttribute("data-palace-mode");

  // Anywhere else it enters.
  await page.locator("body").click({ position: { x: 700, y: 300 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(pinned(page)).toBeFocused();
});

test("with a page overlay open, the first Esc closes it and the second enters Palace mode", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  await hydrated(page);
  await showPage(page, "watches");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-page-overlay]")).toHaveCount(0);
  await expect(shell(page)).not.toHaveAttribute("data-palace-mode");
  await page.keyboard.press("Escape");
  await expect(pinned(page)).toBeFocused();
});

test("entering Palace mode closes a page overlay; a stored / or /palace link enters it", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  await hydrated(page);
  for (const link of ["/", "/palace"]) {
    await showPage(page, "watches");
    await page.evaluate((path) => window.dispatchEvent(new CustomEvent("portal:navigate", { detail: path })), link);
    await expect(pinned(page)).toBeFocused();
    await expect(page.locator("[data-page-overlay]")).toHaveCount(0);
    await pinned(page).click();
    await expect(shell(page)).not.toHaveAttribute("data-palace-mode");
  }
});

test("home is the start page with no project picked; the Palace entry is gone from the sidebar", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle("Portal");
  await expect(page.getByRole("heading", { name: "What would you like to work on?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Choose a project/ })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Portal", exact: true });
  await expect(nav.getByRole("button")).toHaveText(["Watches", "Activity", "Memory", "System", "Terminal"]);
  await expect(page.locator("[data-palace]")).toHaveCount(0);
});

test("under reduced motion Palace mode crossfades without moving anything", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setupPortal(page);
  await page.goto("/sessions/s1");
  const sidebar = page.locator(".sidebar-slot");
  await enterPalace(page);
  expect(await sidebar.evaluate((node) => getComputedStyle(node).transform)).toBe("none");
  expect(await sidebar.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");
  expect(await page.locator("[data-shell-centre]").evaluate((node) => getComputedStyle(node).transform)).toBe("none");
  await pinned(page).click();
  await expect(shell(page)).not.toHaveAttribute("data-palace-mode");
  await expect.poll(() => sidebar.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
});
