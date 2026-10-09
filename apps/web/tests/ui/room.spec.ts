import { expect, test, type Locator } from "@playwright/test";
import { firstTitle, makeSession, milestone, roomState, secondTitle, setupPortal, tabUrl, thirdTitle } from "./fixtures";
import { pane, split, tab, workspaceOf } from "./workspace-fixtures";

/** The scene's summary for tests (docs/PALACE.md, Tests): `{ scene, weather, renderer, source, still }`. */
const summary = async (room: Locator) => JSON.parse((await room.getAttribute("data-room")) ?? "{}") as Record<string, unknown>;

test("the room's canvas mounts behind Portal and reports day or night from the sun at its location", async ({ page }, info) => {
  // Noon in New York, where the fixture's room is; an overcast sky.
  await page.clock.install({ time: new Date(Date.UTC(2026, 9, 4, 16, 0, 0)) });
  await setupPortal(page, { webgl: true, room: roomState({ code: 3, condition: "overcast", cloudCover: 100 }) });
  // The canvas loads the furniture kit (a meshopt GLB) as it starts.
  const kit = page.waitForResponse((response) => new URL(response.url()).pathname === "/room/kit.glb");
  await page.goto("/");
  expect((await kit).ok()).toBe(true);
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
  await expect(nav.getByRole("button", { name: "Palace", exact: true })).toHaveAttribute("aria-current", "page");
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

test("under reduced motion the canvas draws a still, and draws again only when the room changes", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date(Date.UTC(2026, 9, 4, 16, 0, 0)) });
  await setupPortal(page, { webgl: true, sessions: [approvalSession, finishedSession] });
  await page.goto("/palace");
  const scene = page.locator(".room-scene");
  await expect.poll(async () => (await summary(scene)).still).toBe(true);
  await pointOf(scene, "robot:s1");
  // Nothing moves: no drift, no flicker, no weather, no walking; two frames a while apart are the same picture.
  const canvas = scene.locator("canvas");
  const first = await canvas.screenshot();
  await page.waitForTimeout(1200);
  expect((await canvas.screenshot()).equals(first)).toBe(true);
  // A session starting work asks for a frame: its robot is drawn at the bench at once.
  await page.evaluate(() => window.__portalEmit("/api/sessions/stream", { type: "updated", id: "s3", patch: { busy: true, liveness: "busy" } }, "message"));
  await pointOf(scene, "robot:s3");
  expect((await live(scene)).robots).toContainEqual({ id: "s3", state: "working", place: "bench" });
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

/** A session's list entry waiting on approval, working, or finished (no robot). */
const approvalSession = { ...makeSession("s1", firstTitle), awaitingPermission: true, liveness: "blocked" as const };
const workingSession = { ...makeSession("s2", secondTitle, "codex"), busy: true, liveness: "busy" as const };
const finishedSession = makeSession("s3", thirdTitle, "codex");

/** The scene's live objects, as `data-room` reports them. */
type LiveSummary = {
  robots: { id: string; state: string; place: string }[];
  mail: { sealed: number; open: number; pile: number };
  hearth: string;
  kettle: boolean;
  points?: Record<string, [number, number]>;
  camera?: { yaw: number; pitch: number; zoom: number; focus: number };
};
const live = async (room: Locator) => (await summary(room)) as unknown as LiveSummary;

/** Where the canvas last drew an object (CSS pixels), once it has reported it. */
async function pointOf(room: Locator, key: string): Promise<[number, number]> {
  await expect.poll(async () => (await live(room)).points?.[key] ?? null).not.toBeNull();
  return (await live(room)).points![key];
}

test("live objects: a session waiting on approval puts its robot by the door, and the tray, hearth and kettle follow the status", async ({ page }, info) => {
  const room = roomState();
  room.census.activityLastHour = 25;
  await setupPortal(page, {
    webgl: true,
    room,
    sessions: [approvalSession, workingSession, finishedSession],
    portal: {
      status: {
        counts: { needsYou: 14, inbox: 0, approvals: 1, intents: 0 },
        runs: [{ id: "r1", kind: "consolidate", jobId: "consolidate", threadId: null, startedAt: Date.now(), summary: "Curating memory" }],
      },
    },
  });
  await page.goto("/palace");
  const scene = page.locator(".room-scene");
  await expect.poll(async () => (await live(scene)).robots).toEqual([
    { id: "s1", state: "approval", place: "door" },
    { id: "s2", state: "working", place: "bench" },
  ]);
  const summaryNow = await live(scene);
  expect(summaryNow.mail).toEqual({ sealed: 1, open: 11, pile: 3 });
  expect(summaryNow.hearth).toBe("fire");
  expect(summaryNow.kettle).toBe(true);
  // Every live object has a hotspot the pointer can find (the accumulated ones' are another test's).
  const accumulated = /^(book|notes|plant|frame|key|tree):/;
  await expect
    .poll(async () =>
      Object.keys((await live(scene)).points ?? {})
        .filter((key) => !accumulated.test(key))
        .sort(),
    )
    .toEqual(["hearth:hearth", "kettle:kettle", "lamp:lamp", "mail:mail", "robot:s1", "robot:s2", "window:window"]);
  await page.screenshot({ path: info.outputPath("live-objects.png") });

  // The tray's card says what is in it; a click opens Needs you (on the Palace page, once a double click is ruled out).
  const [mx, my] = await pointOf(scene, "mail:mail");
  await page.mouse.move(mx, my);
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Mail tray");
  await expect(tooltip).toContainText("12 in the tray and a pile of 3 more");
  await expect(tooltip).toContainText("Click to open Needs you");
  await page.mouse.click(mx, my);
  await expect(page).toHaveURL(/\/attention$/);
});

test("a robot's hover card names its session; on the Palace page a click makes it wave, then its card opens the session", async ({ page }, info) => {
  await setupPortal(page, { webgl: true, sessions: [approvalSession, workingSession, finishedSession] });
  await page.goto("/palace");
  const scene = page.locator(".room-scene");
  const [x, y] = await pointOf(scene, "robot:s1");
  await page.mouse.move(x, y);
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText(firstTitle);
  await expect(tooltip).toContainText("Needs approval · Claude Code");
  await expect(tooltip).toContainText("2 active sessions in the room");
  await expect(tooltip).toContainText("Click to open the session");
  // Over the robot the room's surface shows a pointer.
  await expect(page.locator("[data-palace]")).toHaveCSS("cursor", "pointer");
  await page.screenshot({ path: info.outputPath("robot-hover.png") });

  await page.mouse.click(x, y);
  // The wave comes first; the card, pinned with its button, after it.
  const card = page.getByRole("dialog", { name: firstTitle });
  await expect(card).toBeVisible();
  await page.screenshot({ path: info.outputPath("robot-card.png") });
  await card.getByRole("button", { name: "Open the session" }).click();
  await expect(page).toHaveURL(tabUrl);
  await expect(page.locator('[data-pane][data-session="s1"]')).toBeVisible();
});

test("the Palace page's drag turns the camera within its limits, the wheel zooms, and Escape flies back", async ({ page }) => {
  await setupPortal(page, { webgl: true });
  await page.goto("/palace");
  const scene = page.locator(".room-scene");
  const camera = async () => (await live(scene)).camera ?? null;
  await expect.poll(camera).toEqual({ yaw: 0, pitch: 25, zoom: 1, focus: 0 });
  const box = (await page.locator("[data-palace]").boundingBox())!;
  // Start in the open sky above the room, away from every object.
  const start = { x: box.x + box.width * 0.5, y: box.y + 40 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 60, start.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await camera())!.yaw).toBeGreaterThan(5);
  // The release is not a click on the empty room: the camera keeps the look rather than flying back.
  await page.waitForTimeout(700);
  expect((await camera())!.yaw).toBeGreaterThan(5);
  // A long drag stops at 20° of yaw and 40° of pitch.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 900, start.y + 900, { steps: 10 });
  await page.mouse.up();
  await expect.poll(camera).toMatchObject({ yaw: 20, pitch: 40 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 900, start.y - 900, { steps: 10 });
  await page.mouse.up();
  await expect.poll(camera).toMatchObject({ yaw: -20, pitch: 10 });
  await page.mouse.move(start.x, start.y + 100);
  await page.mouse.wheel(0, -2000);
  await expect.poll(async () => (await camera())!.zoom).toBe(1.3);
  await page.keyboard.press("Escape");
  await expect.poll(camera).toEqual({ yaw: 0, pitch: 25, zoom: 1, focus: 0 });
  // Elsewhere the look is gone: leaving the page put the camera back.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 300, start.y, { steps: 4 });
  await page.mouse.up();
  await page.getByRole("navigation", { name: "Portal", exact: true }).getByRole("button", { name: "Activity", exact: true }).click();
  await expect.poll(camera).toEqual({ yaw: 0, pitch: 25, zoom: 1, focus: 0 });
});

test("a click on a terminal or a resize handle over a room object stays in the UI: no card, no navigation", async ({ page }) => {
  await setupPortal(page, {
    webgl: true,
    sessions: [approvalSession, workingSession, finishedSession],
    // Stacked panes: the top one's terminal and the separator under it run across the middle of the room.
    workspace: workspaceOf([tab("t1", split("x1", "column", [pane("p1", "s1"), pane("p2", "s2")]))]),
  });
  await page.goto("/tabs/t1?pane=p1");
  const p1 = page.locator('[data-pane="p1"]');
  await p1.getByRole("button", { name: "Show terminal" }).click();
  await expect(p1.getByRole("region", { name: "Terminal" })).toBeVisible();
  const scene = page.locator(".room-scene");
  await pointOf(scene, "robot:s1");
  const url = page.url();
  // Every reported object whose screen point lies under the terminal or a pane separator.
  const covered = await page.evaluate((points) => {
    // Over the empty part of either, not one of the terminal's own controls (a click there would change the layout).
    const under = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit && !hit.closest("button, a, input, [role=tab]") ? hit.closest('section[aria-label="Terminal"], [role=separator]') : null;
    };
    return Object.entries(points)
      .filter(([, [x, y]]) => under(x, y) !== null)
      .map(([key, point]) => ({ key, point }));
  }, (await live(scene)).points ?? {});
  expect(covered.length, "an object lies under the terminal or a separator").toBeGreaterThan(0);
  for (const { point } of covered) {
    await page.mouse.move(point[0], point[1]);
    await page.mouse.click(point[0], point[1]);
  }
  await page.waitForTimeout(400);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.locator("[data-room-card]")).toHaveCount(0);
  expect(page.url()).toBe(url);
});

/** The accumulated objects and milestone furniture, as `data-room` reports them. */
type GrowthSummary = {
  layout: number;
  furniture: string[];
  books: { total: number; drawn: number; rows: number; boxed: number; purged: number };
  notes: { pinned: number; layered: number; loose: number; looseExtra: number };
  plants: { sill: number; stand: number; blooms: number };
  keys: number;
  tree: { stage: string; season: string };
  delivery?: string | null;
  points?: Record<string, [number, number]>;
};
const growth = async (room: Locator) => (await summary(room)) as unknown as GrowthSummary;

test("accumulated objects: thirty sessions fill two shelf rows on the tall bookcase two milestones brought", async ({ page }, info) => {
  // Noon in New York in October, a year and a half after the first session.
  await page.clock.install({ time: new Date(Date.UTC(2026, 9, 9, 16, 0, 0)) });
  const room = roomState(
    {},
    {
      census: {
        sessionsEver: 30,
        memoryActive: 75,
        memoryInbox: 3,
        watches: { active: 0, finished: 3, fires: 4, ever: 3 },
        grants: 2,
        since: Date.UTC(2025, 3, 1),
      },
      milestones: [milestone("tall-bookcase"), milestone("wide-pinboard")],
    },
  );
  await setupPortal(page, { webgl: true, room });
  await page.goto("/palace");
  const scene = page.locator(".room-scene");
  await expect.poll(async () => (await growth(scene)).books).toEqual({ total: 30, drawn: 30, rows: 2, boxed: 0, purged: 27 });
  const now = await growth(scene);
  expect(now.furniture).toEqual(["tall-bookcase", "wide-pinboard"]);
  expect(now.notes).toEqual({ pinned: 60, layered: 15, loose: 3, looseExtra: 0 });
  expect(now.plants).toMatchObject({ stand: 3 });
  expect(now.keys).toBe(2);
  expect(now.tree).toEqual({ stage: "full", season: "autumn" });
  // Neither milestone is fresh: the furniture is simply there, no crate.
  expect(now.delivery ?? null).toBeNull();
  // The first books on the shelf are purged sessions': their card says so and a click goes nowhere.
  const [bx, by] = await pointOf(scene, "book:purged:0");
  await page.mouse.move(bx, by);
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("A purged session");
  await expect(tooltip).toContainText("30 books on 2 shelf rows");
  await page.screenshot({ path: info.outputPath("growth.png") });
});

test("a milestone that arrives over the stream is delivered in a crate, then its furniture stays", async ({ page }, info) => {
  const base = roomState({}, { census: { sessionsEver: 24 } });
  const fixture = await setupPortal(page, { webgl: true, room: base });
  await page.goto("/palace");
  const scene = page.locator(".room-scene");
  await expect.poll(async () => (await growth(scene)).books?.rows).toBe(1);
  await fixture.pushRoom({ ...base, census: { ...base.census, sessionsEver: 25 }, milestones: [milestone("tall-bookcase", Date.now())] });
  await expect.poll(async () => (await growth(scene)).delivery ?? null).toBe("tall-bookcase");
  await page.screenshot({ path: info.outputPath("delivery.png") });
  await expect.poll(async () => (await growth(scene)).delivery ?? null, { timeout: 15_000 }).toBeNull();
  expect((await growth(scene)).furniture).toEqual(["tall-bookcase"]);
});

test("the Settings dialog's Room section shows the location and weather, and Refresh looks them up again", async ({ page }, info) => {
  const refreshed = roomState({ code: 61, condition: "rain", temperature: 12 }, { environment: { latitude: 51.5072, longitude: -0.1276, source: "ip", timezone: "Europe/London" } });
  const fixture = await setupPortal(page, { roomRefresh: refreshed });
  await page.goto("/");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("portal:open-settings", { detail: { section: "room" } })));
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("heading", { name: "Room" })).toBeVisible();
  const location = dialog.locator("[data-room-location]");
  const weather = dialog.locator("[data-room-weather]");
  await expect(location).toContainText("40.71, -74.01");
  await expect(location).toContainText("set by PORTAL_LOCATION");
  await expect(weather).toContainText("Clear, 18°C, day");
  await expect(dialog.getByRole("link", { name: "Weather data by Open-Meteo.com" })).toHaveAttribute("href", "https://open-meteo.com/");
  await expect(dialog.locator("[data-room-layout]")).toHaveText("1");
  await dialog.screenshot({ animations: "disabled", path: info.outputPath("settings-room.png") });

  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(location).toContainText("51.51, -0.13");
  await expect(location).toContainText("from the server's public IP address");
  await expect(weather).toContainText("Rain, 12°C, day");
  expect(fixture.requests.filter((request) => request.path === "/api/room/refresh" && request.method === "POST")).toHaveLength(1);
  // The room itself took the new state too.
  await expect.poll(async () => (await summary(page.locator(".room-scene"))).weather).toBe("rain");
});

test("when the room cannot be loaded the Settings dialog says it is unavailable, and Refresh still works", async ({ page }) => {
  const fixture = await setupPortal(page, { roomUnavailable: true });
  await page.goto("/");
  await expect.poll(() => fixture.requests.filter((request) => request.path === "/api/room" && request.method === "GET").length).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("portal:open-settings", { detail: { section: "room" } })));
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const location = dialog.locator("[data-room-location]");
  const weather = dialog.locator("[data-room-weather]");
  await expect(location).toHaveText("Unavailable");
  await expect(weather).toContainText("Unavailable");
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(location).toContainText("40.71, -74.01");
  await expect(weather).toContainText("Clear, 18°C, day");
});
