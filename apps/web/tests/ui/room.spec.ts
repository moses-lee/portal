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
