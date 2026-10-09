import { expect, test, type Locator } from "@playwright/test";
import { roomState, setupPortal } from "./fixtures";
import { pane, tab, workspaceOf } from "./workspace-fixtures";

/** The scene's summary for tests (docs/PALACE.md, Tests): `{ scene, weather, renderer, source, still }`. */
const summary = async (room: Locator) => JSON.parse((await room.getAttribute("data-room")) ?? "{}") as Record<string, unknown>;

test("the room's canvas mounts behind Portal and reports day or night from the sun at its location", async ({ page }, info) => {
  // Noon in New York, where the fixture's room is; an overcast sky.
  await page.clock.install({ time: new Date(Date.UTC(2026, 9, 4, 16, 0, 0)) });
  await setupPortal(page, { webgl: true, room: roomState({ code: 3, condition: "overcast", cloudCover: 100 }) });
  await page.goto("/");
  const room = page.locator(".room-scene");
  await expect(room).toHaveAttribute("data-scene", "day");
  await expect(room).toHaveAttribute("data-renderer", "webgl");
  await expect(room.locator("canvas")).toHaveCount(1);
  await expect.poll(async () => (await summary(room)).weather).toBe("overcast");
  expect(await summary(room)).toMatchObject({ scene: "day", renderer: "webgl", source: "config" });
  await page.screenshot({ path: info.outputPath("room-noon.png") });
});

test("at night the scene says so, and without WebGL the gradient sky stands in", async ({ page }, info) => {
  // 11pm in New York.
  await page.clock.install({ time: new Date(Date.UTC(2026, 9, 5, 3, 0, 0)) });
  // The fixture refuses WebGL unless asked, as a browser without it would.
  await setupPortal(page);
  await page.goto("/");
  const room = page.locator(".room-scene");
  await expect(room).toHaveAttribute("data-scene", "night");
  await expect(room).toHaveAttribute("data-renderer", "fallback");
  await expect(room.locator("canvas")).toHaveCount(0);
  const background = await room.evaluate((node) => getComputedStyle(node).backgroundImage);
  expect(background).toContain("linear-gradient");
  await page.screenshot({ path: info.outputPath("room-fallback-night.png") });
});

test("the Palace page is the room alone: a sidebar entry, no header text, no tracked panel, no composer", async ({ page }, info) => {
  await setupPortal(page, { webgl: true });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Portal", exact: true });
  const labels = (await nav.getByRole("button").allInnerTexts()).map((text) => text.trim());
  expect(labels.indexOf("Palace")).toBe(labels.indexOf("System") + 1);
  await nav.getByRole("button", { name: "Palace", exact: true }).click();
  await expect(page).toHaveURL(/\/palace$/);
  await expect(page).toHaveTitle("Palace");
  const main = page.getByRole("main");
  await expect(main.locator("header")).toHaveText("");
  await expect(main.getByRole("heading")).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Tracked sessions" })).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.locator(".room-scene")).toHaveAttribute("data-scene", /^(day|night)$/);
  await page.screenshot({ path: info.outputPath("palace.png") });
  // A direct load lands there too.
  await page.reload();
  await expect(page).toHaveTitle("Palace");
  await expect(page.getByRole("main").getByRole("heading")).toHaveCount(0);
});

/** A CSS colour's alpha (0..1), resolved by the browser through a 2D canvas so any syntax (oklch, hex, rgb) works. */
const alphaOf = (locator: Locator) =>
  locator.evaluate((node) => {
    const context = document.createElement("canvas").getContext("2d")!;
    context.fillStyle = getComputedStyle(node).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3] / 255;
  });
const backdropOf = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).backdropFilter);

test("panels over the room are frosted by the canvas, not CSS, while an open dialog keeps its CSS blur", async ({ page }, info) => {
  await page.clock.install({ time: new Date(Date.UTC(2026, 9, 4, 16, 0, 0)) });
  await setupPortal(page, { webgl: true });
  await page.goto("/");
  const sidebar = page.locator(".sidebar-shell");
  const composer = page.locator(".composer");
  await expect(sidebar).toHaveClass(/\bfrost-subtle\b/);
  await expect(composer).toHaveClass(/\bfrost\b/);
  expect(await backdropOf(sidebar)).toBe("none");
  expect(await backdropOf(composer)).toBe("none");
  // The canvas draws the frost under them: its last frame counted the panels (the sidebar, the composer, the item card).
  const canvas = page.locator(".room-scene canvas");
  await expect.poll(async () => Number(await canvas.getAttribute("data-frost"))).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: info.outputPath("frost.png") });

  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/\bglass\b/);
  expect(await backdropOf(dialog)).toContain("blur");
});

test("under reduced transparency the panels are solid and the room draws no frost", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  await setupPortal(page, { webgl: true });
  await page.goto("/");
  const sidebar = page.locator(".sidebar-shell");
  const composer = page.locator(".composer");
  await expect(composer).toBeVisible();
  expect(await alphaOf(sidebar)).toBe(1);
  expect(await alphaOf(composer)).toBe(1);
  // The room is the still gradient, so nothing is frosted behind the panels.
  await expect(page.locator(".room-scene")).toHaveAttribute("data-renderer", "fallback");
  await expect(page.locator(".room-scene canvas")).toHaveCount(0);
});

test("without WebGL the frost panels keep their tint over the gradient", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  const composer = page.locator(".composer");
  await expect(composer).toBeVisible();
  const alpha = await alphaOf(composer);
  expect(alpha).toBeGreaterThan(0.8);
  expect(alpha).toBeLessThan(1);
  expect(await backdropOf(composer)).toBe("none");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the room strip above the pane opens the Palace page", async ({ page }, info) => {
    await setupPortal(page, { webgl: true, workspace: workspaceOf([tab("t1", pane("p1", "s1"))]) });
    await page.goto("/tabs/t1");
    const strip = page.getByRole("link", { name: "Open the Palace" });
    await expect(strip).toBeVisible();
    const box = (await strip.boundingBox())!;
    expect(box.height).toBe(72);
    expect(box.y).toBe(0);
    await page.screenshot({ path: info.outputPath("phone-strip.png") });
    await strip.click();
    await expect(page).toHaveURL(/\/palace$/);
    await expect(page.getByRole("main").getByRole("heading")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open the Palace" })).toHaveCount(0);
  });
});
