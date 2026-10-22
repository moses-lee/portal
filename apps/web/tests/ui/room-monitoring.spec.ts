import { expect, test, type Locator, type Page } from "@playwright/test";
import type { MonitoringSummary } from "@portal/contracts/monitoring";
import { emitPortal, setupPortal } from "./fixtures";
import { enterPalace } from "./surfaces";

/** Noon in New York, where the fixture's room is: the room in daylight for the screenshots. */
const NOON = Date.UTC(2026, 9, 4, 16, 0, 0);
const GIB = 2 ** 30;

/** The portal stream's `monitoring` event (docs/MONITORING.md): 16 GB of RAM, a 460 GB disk. */
function reading(overrides: Partial<MonitoringSummary> = {}): MonitoringSummary {
  return {
    at: NOON,
    pressure: "normal",
    memory: { usedBytes: 11.25 * GIB, totalBytes: 16 * GIB },
    swap: { usedBytes: 2.5 * GIB, totalBytes: 4 * GIB },
    disk: { path: "/Users/moses/.portal", freeBytes: 120e9, totalBytes: 460e9, level: "normal" },
    largest: [
      { label: "monorepo-a", path: "/w/a", bytes: 88e9 },
      { label: "monorepo-b", path: "/w/b", bytes: 41.2e9 },
      { label: "Database", path: null, bytes: 3.4e9 },
      { label: "/Users/moses/.codex", path: "/Users/moses/.codex", bytes: 2.1e9 },
      { label: "Portal images", path: "/p/blobs", bytes: 60e6 },
    ],
    surveyedAt: NOON - 4 * 60_000,
    ...overrides,
  };
}

const critical = reading({
  pressure: "critical",
  memory: { usedBytes: 15.6 * GIB, totalBytes: 16 * GIB },
  swap: { usedBytes: 9.5 * GIB, totalBytes: 10 * GIB },
  disk: { path: "/Users/moses/.portal", freeBytes: 9e9, totalBytes: 460e9, level: "critical" },
});
const warning = reading({
  pressure: "warning",
  disk: { path: "/Users/moses/.portal", freeBytes: 24e9, totalBytes: 460e9, level: "warning" },
});

type Summary = {
  barometer?: string | null;
  jar?: { fill: number | null; lid: string | null };
  points?: Record<string, [number, number]>;
};
const summary = async (room: Locator) => JSON.parse((await room.getAttribute("data-room")) ?? "{}") as Summary;

/** Where the canvas last drew an object (CSS pixels), once it has reported it. */
async function pointOf(room: Locator, key: string): Promise<[number, number]> {
  await expect.poll(async () => (await summary(room)).points?.[key] ?? null, { timeout: 20_000 }).not.toBeNull();
  return (await summary(room)).points![key];
}

/** The room drawn, with the barometer and the jar at rest (no reading yet). */
async function openRoom(page: Page): Promise<Locator> {
  const room = page.locator(".room-scene");
  await expect(room).toHaveAttribute("data-drawn", "", { timeout: 20_000 });
  await expect.poll(async () => (await summary(room)).barometer).toBeNull();
  expect((await summary(room)).jar).toEqual({ fill: null, lid: null });
  return room;
}

/** Long enough for the needle's swing to settle before a screenshot. */
const SETTLE_MS = 1_800;

test("the barometer and the jar rest until the first reading, then follow the stream's monitoring event; a click opens Monitoring", async ({ page }) => {
  await page.clock.install({ time: new Date(NOON) });
  await setupPortal(page, { webgl: true });
  await page.goto("/");
  await enterPalace(page);
  const room = await openRoom(page);
  const tooltip = page.getByRole("tooltip");

  // At rest the cards say there is no reading yet.
  const [bx, by] = await pointOf(room, "barometer:barometer");
  await page.mouse.move(bx, by);
  await expect(tooltip).toContainText("Barometer");
  await expect(tooltip).toContainText("No reading yet");
  await page.screenshot({ path: "/tmp/room-monitoring-desktop-rest.png" });

  await emitPortal(page, { type: "monitoring", summary: reading() });
  await expect.poll(async () => (await summary(room)).barometer).toBe("normal");
  expect((await summary(room)).jar).toEqual({ fill: 0.74, lid: "normal" });
  await page.mouse.move(bx + 1, by);
  await expect(tooltip).toContainText("Memory: 11 GB used of 16 GB");
  await expect(tooltip).toContainText("Swap: 2.5 GB used of 4 GB");
  await expect(tooltip).toContainText("Pressure: normal");
  await expect(tooltip).toContainText("Click to open Monitoring");

  const [jx, jy] = await pointOf(room, "jar:jar");
  await page.mouse.move(jx, jy);
  await expect(tooltip).toContainText("Jar");
  await expect(tooltip).toContainText("120 GB free of 460 GB (74% used)");
  await expect(tooltip).toContainText("monorepo-a: 88 GB");
  await expect(tooltip).toContainText("Portal images: 60 MB");
  await expect(tooltip).toContainText("Sizes measured 4 min ago");
  await page.mouse.move(10, 500);
  await expect(tooltip).toHaveCount(0);
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: "/tmp/room-monitoring-desktop-normal.png" });

  await emitPortal(page, { type: "monitoring", summary: warning });
  await expect.poll(async () => (await summary(room)).barometer).toBe("warning");
  expect((await summary(room)).jar).toEqual({ fill: 0.95, lid: "warning" });
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: "/tmp/room-monitoring-desktop-warning.png" });

  await emitPortal(page, { type: "monitoring", summary: critical });
  await expect.poll(async () => (await summary(room)).barometer).toBe("critical");
  expect((await summary(room)).jar).toEqual({ fill: 0.98, lid: "critical" });
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: "/tmp/room-monitoring-desktop-critical.png" });

  await page.mouse.move(jx, jy);
  await expect(tooltip).toContainText("Below the critical level");
  await page.mouse.click(jx, jy);
  await expect(page.getByRole("heading", { name: "Monitoring", level: 1 })).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the barometer and the jar are in the phone's frame", async ({ page }) => {
    await page.clock.install({ time: new Date(NOON) });
    await setupPortal(page, { webgl: true });
    await page.goto("/sessions/s1");
    await page.getByRole("button", { name: "Toggle sidebar" }).first().click();
    await page.getByRole("dialog", { name: "Your workspace" }).getByRole("button", { name: "Show the room" }).click();
    const room = await openRoom(page);

    await emitPortal(page, { type: "monitoring", summary: reading() });
    await expect.poll(async () => (await summary(room)).barometer).toBe("normal");
    for (const key of ["barometer:barometer", "jar:jar"]) {
      const [x, y] = await pointOf(room, key);
      expect(x).toBeGreaterThan(20);
      expect(x).toBeLessThan(370);
      expect(y).toBeGreaterThan(20);
      expect(y).toBeLessThan(824);
    }
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: "/tmp/room-monitoring-phone-normal.png" });

    await emitPortal(page, { type: "monitoring", summary: critical });
    await expect.poll(async () => (await summary(room)).jar).toEqual({ fill: 0.98, lid: "critical" });
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: "/tmp/room-monitoring-phone-critical.png" });
  });
});
