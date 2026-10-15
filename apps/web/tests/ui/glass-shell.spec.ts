import { expect, test, type Locator } from "@playwright/test";
import { setupPortal } from "./fixtures";

/** The glass shell (docs/GLASS.md): floating panels. */

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
const recordMotion = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __motion: string[] }).__motion = seen;
    new MutationObserver(() => seen.push(document.documentElement.hasAttribute("data-room-motion") ? "on" : "off")).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-room-motion"],
    });
  });
const motionSeen = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as { __motion: string[] }).__motion);

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
