import { expect, test, type Page } from "@playwright/test";
import type { AttributedProcess, MonitoringPoint, MonitoringSnapshot } from "@portal/contracts/monitoring";
import { setupPortal } from "./fixtures";
import { openPage, showSettings } from "./surfaces";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const fixtureTime = Date.now();

const NOT_ATTRIBUTED = "not attributed to a session, a worktree, or Portal";

/** A process row as the server sends it: stoppable unless `extra` says why not (as the server's `stopRefusal` would). */
const proc = (pid: number, owner: AttributedProcess["owner"], memoryBytes: number, command: string, extra: Partial<AttributedProcess> = {}): AttributedProcess => ({
  pid,
  ppid: 1,
  pgid: pid,
  elapsedSeconds: 3600,
  cpuSeconds: 12,
  memoryBytes,
  command,
  cwd: null,
  owner,
  inheritedFrom: null,
  orphan: false,
  stoppable: true,
  stopBlockedReason: null,
  ...extra,
});

/** A day of samples: pressure at warning for the last two hours, disk shrinking toward the critical level. */
function history(now: number): MonitoringPoint[] {
  return Array.from({ length: 24 * 6 }, (_, i) => {
    const at = now - DAY + (i + 1) * 10 * MIN;
    const late = i >= 24 * 6 - 12;
    return {
      at,
      memoryUsedBytes: (9 + 4 * Math.sin(i / 9) ** 2 + (late ? 2 : 0)) * GiB,
      swapUsedBytes: (late ? 3 : 1) * GiB,
      diskFreeBytes: (60 - i * 0.33) * 1e9,
      pressure: late ? "warning" : "normal",
    };
  });
}

/** One snapshot as `GET /api/monitoring` answers it: warning pressure, a critical disk, an idle and a busy session, and a worktree. */
export function monitoringSnapshot(now = fixtureTime): MonitoringSnapshot {
  const s1 = { kind: "session" as const, sessionId: "s1" };
  const s2 = { kind: "session" as const, sessionId: "s2" };
  const wt = { kind: "worktree" as const, projectId: "p2" };
  return {
    supported: true,
    now,
    levels: { warnFreeGb: 30, criticalFreeGb: 15 },
    sample: {
      at: now,
      memory: { totalBytes: 16 * GiB, availableBytes: 1.5 * GiB, usedBytes: 14.5 * GiB },
      swap: { totalBytes: 4 * GiB, usedBytes: 3 * GiB },
      pressure: { level: "warning", raw: "2" },
      volumes: [{ path: "/Users/me/.portal", totalBytes: 460e9, freeBytes: 12e9 }],
    },
    diskLevel: "critical",
    history: history(now),
    processesAt: now,
    processes: [
      proc(4100, wt, 2.6 * GiB, "bazel(portal) -server --workspace_directory=/workspace/portal-worktree", { orphan: true }),
      proc(4101, wt, 300 * MiB, "java -jar bazel-server.jar", { ppid: 4100, inheritedFrom: 4100, stoppable: false, stopBlockedReason: "inherited from pid 4100; stop that process" }),
      proc(9001, { kind: "none" }, 1.8 * GiB, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", { stoppable: false, stopBlockedReason: NOT_ATTRIBUTED }),
      proc(500, { kind: "portal", role: "database" }, 900 * MiB, "com.docker.virtualization", { stoppable: false, stopBlockedReason: "Portal's database" }),
      proc(101, s1, 350 * MiB, "claude --resume abc", { ppid: 200 }),
      proc(102, s1, 120 * MiB, "node /workspace/portal/node_modules/.bin/vitest", { ppid: 101 }),
      proc(103, s2, 280 * MiB, "codex exec", { ppid: 200 }),
      proc(300, { kind: "portal", role: "server" }, 210 * MiB, "node apps/server/src/index.ts", { stoppable: false, stopBlockedReason: "part of the Portal server" }),
      proc(200, { kind: "portal", role: "adapter" }, 180 * MiB, "node claude-agent-acp"),
      proc(9002, { kind: "none" }, 140 * MiB, "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder", { stoppable: false, stopBlockedReason: NOT_ATTRIBUTED }),
    ],
    sessions: [
      {
        sessionId: "s1",
        title: "Improve the chat experience",
        projectId: "p2",
        projectName: "improve-chat-experience",
        agentId: "claude",
        agentName: "Claude",
        busy: false,
        awaitingPermission: false,
        state: "finished",
        rootPid: 101,
        pids: [101, 102],
        memoryBytes: 470 * MiB,
        processCount: 2,
        idleSince: now - 25 * MIN,
        attachedAt: now - 40 * MIN,
        idleStopAt: now + 95 * MIN,
      },
      {
        sessionId: "s2",
        title: "Fix the flaky test",
        projectId: "p1",
        projectName: "portal",
        agentId: "codex",
        agentName: "Codex",
        busy: true,
        awaitingPermission: false,
        state: "working",
        rootPid: 103,
        pids: [103],
        memoryBytes: 280 * MiB,
        processCount: 1,
        idleSince: null,
        attachedAt: now - 10 * MIN,
        idleStopAt: null,
      },
    ],
    worktrees: [
      {
        projectId: "p2",
        name: "improve-chat-experience",
        path: "/workspace/portal-worktree",
        branch: "feature/improve-chat-experience",
        sizeBytes: 88e9,
        sessionCount: 1,
        pids: [4100, 4101],
        memoryBytes: 2.9 * GiB,
        processCount: 2,
        pinned: false,
        removalAt: null,
        keptReason: "uncommitted changes",
        keptSince: now - 9 * DAY,
      },
    ],
    disk: {
      survey: {
        startedAt: now - 5 * MIN,
        finishedAt: now - 4 * MIN,
        home: { path: "/Users/me/.portal", worktreesBytes: 154e9, blobsBytes: 60e6, logsBytes: 12e6, otherBytes: 300e6 },
        worktrees: [{ projectId: "p2", path: "/workspace/portal-worktree", bytes: 88e9 }],
        strayWorktrees: [],
        watched: [
          {
            path: "/Users/me/Library/Caches/bazel",
            exists: true,
            bytes: 41e9,
            children: [
              { name: "_bazel_me", bytes: 39e9, modifiedAt: now - DAY },
              { name: "_bazel_cache", bytes: 2e9, modifiedAt: now - 3 * DAY },
            ],
          },
          { path: "/Users/me/gone", exists: false, bytes: null, children: [] },
        ],
        database: { bytes: 1.2e9, tables: [{ name: "session_events", bytes: 1.1e9 }, { name: "activity", bytes: 40e6 }] },
        largest: [{ label: "improve-chat-experience", path: "/workspace/portal-worktree", bytes: 88e9 }],
      },
      ageMs: 4 * MIN,
      running: false,
    },
  };
}

/** Serves `GET /api/monitoring` and the actions on top of `setupPortal`'s mocks, recording what was asked. */
async function mockMonitoring(page: Page, snapshot: MonitoringSnapshot) {
  const requests: { path: string; method: string }[] = [];
  await page.route(/\/api\/(monitoring|sessions\/[^/]+\/stop-cli|projects\/[^/]+\/cleanup-script)(\/|$|\?)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ path, method: request.method() });
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/monitoring") return json(snapshot);
    if (path === "/api/monitoring/disk/refresh") return json({ disk: { ...snapshot.disk, running: true } });
    if (path === "/api/monitoring/folders/check") {
      const { paths } = request.postDataJSON() as { paths: string[] };
      return json({ paths: paths.map((given) => ({ path: given, expanded: given.replace(/^~/, "/Users/me"), exists: !given.includes("gone") })) });
    }
    if (path === "/api/monitoring/processes/200/stop") return json({ error: "Process 200 changed since the table was read; look again." }, 409);
    if (/^\/api\/monitoring\/processes\/\d+\/stop$/.test(path)) return json({ pid: Number(path.split("/")[4]), target: "group" });
    if (path.endsWith("/stop-cli")) return json({ stopped: true });
    return json({ error: "Unexpected" }, 400);
  });
  return requests;
}

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(fixtureTime); });

test("the sidebar entry opens Monitoring, with tiles coloured by level from the fixture", async ({ page }) => {
  await setupPortal(page);
  await mockMonitoring(page, monitoringSnapshot());
  await openPage(page, "monitoring");
  const view = page.getByRole("region", { name: "Monitoring", exact: true });

  const tile = (key: string) => view.locator(`[data-tile="${key}"]`);
  await expect(tile("memory")).toHaveAttribute("data-level", "warning");
  await expect(tile("memory")).toContainText("15 GB of 16 GB");
  await expect(tile("memory")).toContainText("Pressure warning");
  await expect(tile("swap")).toHaveAttribute("data-level", "warning");
  await expect(tile("disk")).toHaveAttribute("data-level", "critical");
  await expect(tile("disk")).toContainText("12 GB free");
  await expect(tile("disk")).toContainText("Critical");
  await expect(tile("agents")).toHaveAttribute("data-level", "normal");
  await expect(tile("agents")).toContainText("2 live CLIs");
  // The colours themselves: amber for warning, red for critical, the neutral glass for normal.
  const background = (key: string) => tile(key).evaluate((el) => getComputedStyle(el).backgroundColor);
  const [warning, critical, normal] = await Promise.all([background("memory"), background("disk"), background("agents")]);
  expect(new Set([warning, critical, normal]).size).toBe(3);

  await expect(view.locator("[data-chart]")).toHaveCount(3);
  await expect(view.getByRole("img", { name: "Free disk over the last 24 hours" })).toBeVisible();

  // The worktree kept for nine days is highlighted; its Bazel server is charged to it and orphaned.
  const worktree = view.getByRole("table", { name: "Worktrees" }).getByRole("row", { name: "improve-chat-experience" });
  await expect(worktree).toHaveAttribute("data-highlight", "true");
  await expect(worktree).toContainText("kept: uncommitted changes for 9 days");
  await expect(worktree).toContainText("88 GB");
  // No cleanup script is set in the default settings.
  await expect(worktree.getByRole("button", { name: "Run cleanup script" })).toBeDisabled();
  await worktree.getByRole("button", { name: "Processes of improve-chat-experience" }).click();
  const bazel = view.getByRole("listitem", { name: "Process 4100" });
  await expect(bazel).toContainText("Orphan");
  // It matched the worktree itself: no "via pid".
  await expect(bazel).not.toContainText("via pid");
  await expect(bazel.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  // A row charged through its ancestor says so, and the server's reason stands where Stop would be.
  const inherited = view.getByRole("listitem", { name: "Process 4101" });
  await expect(inherited).toContainText("via pid 4100");
  await expect(inherited.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const cantStop = inherited.getByRole("button", { name: "Can't stop" });
  await expect(cantStop).toHaveAttribute("title", "Inherited from pid 4100; stop that process");
  await expect(cantStop).toHaveAccessibleDescription("Inherited from pid 4100; stop that process");
  // A tap shows the reason in the row, for a phone with no hover.
  await cantStop.click();
  await expect(inherited.getByText("Inherited from pid 4100; stop that process")).toBeVisible();

  // Other processes are listed but never stoppable.
  const others = view.getByRole("table", { name: "Other processes" });
  await expect(others).toContainText("Google Chrome");
  await expect(others.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const portal = view.getByRole("table", { name: "Portal processes" });
  await expect(portal).toContainText("Database");
  // Portal's own server, web server and database are not offered; an adapter is.
  await expect(portal.getByRole("row", { name: "Process 300" }).getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(portal.getByRole("row", { name: "Process 300" }).getByRole("button", { name: "Can't stop" })).toHaveAccessibleDescription("Part of the Portal server");
  await expect(portal.getByRole("row", { name: "Process 200" }).getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  await expect(view.getByText("measured 4 min ago")).toBeVisible();
  await expect(view.getByRole("group", { name: "/Users/me/gone" })).toContainText("Missing");
});

test("Stop CLI waits while the session is busy; an action's error shows in its section and clears on the next action", async ({ page }) => {
  await setupPortal(page);
  const requests = await mockMonitoring(page, monitoringSnapshot());
  await openPage(page, "monitoring");
  const view = page.getByRole("region", { name: "Monitoring", exact: true });
  const busy = view.getByRole("table", { name: "Sessions" }).getByRole("row", { name: "Fix the flaky test" });
  await expect(busy.getByRole("button", { name: "Stop CLI" })).toBeDisabled();
  await expect(busy.getByRole("button", { name: "Stop CLI" })).toHaveAccessibleDescription("Busy; stop once idle");
  await expect(busy).toContainText("active");

  // The adapter's stop is refused: the error stands under the Portal section, not elsewhere.
  const portal = view.getByRole("region", { name: "Portal", exact: true });
  const adapter = portal.getByRole("row", { name: "Process 200" });
  await adapter.getByRole("button", { name: "Stop", exact: true }).click();
  await adapter.getByRole("button", { name: "Confirm stop" }).click();
  await expect(portal.getByRole("alert")).toHaveText("Process 200: Process 200 changed since the table was read; look again.");
  await expect(view.getByRole("region", { name: /^Sessions/ }).getByRole("alert")).toHaveCount(0);

  // The next action clears it.
  await view.getByRole("table", { name: "Sessions" }).getByRole("row", { name: "Improve the chat experience" }).getByRole("button", { name: "Stop CLI" }).click();
  await expect.poll(() => requests.some((r) => r.path === "/api/sessions/s1/stop-cli")).toBe(true);
  await expect(portal.getByRole("alert")).toHaveCount(0);
});

test("polling pauses while the page is hidden and resumes at once when shown", async ({ page }) => {
  await setupPortal(page);
  const requests = await mockMonitoring(page, monitoringSnapshot());
  await openPage(page, "monitoring");
  await expect(page.getByRole("region", { name: "Monitoring", exact: true }).locator('[data-tile="memory"]')).toBeVisible();
  const reads = () => requests.filter((r) => r.path === "/api/monitoring").length;
  const setHidden = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await setHidden(true);
  const before = reads();
  await page.waitForTimeout(6_500);
  expect(reads()).toBe(before);
  await setHidden(false);
  await expect.poll(reads, { timeout: 2_000 }).toBe(before + 1);
});

test("Stop CLI and a child's Stop call their routes", async ({ page }) => {
  await setupPortal(page);
  const requests = await mockMonitoring(page, monitoringSnapshot());
  await openPage(page, "monitoring");
  const view = page.getByRole("region", { name: "Monitoring", exact: true });
  const session = view.getByRole("table", { name: "Sessions" }).getByRole("row", { name: "Improve the chat experience" });
  await expect(session).toContainText("idle 25m");
  await expect(session).toContainText("in 1h 35m");

  await session.getByRole("button", { name: "Stop CLI" }).click();
  await expect.poll(() => requests.some((r) => r.path === "/api/sessions/s1/stop-cli" && r.method === "POST")).toBe(true);

  // The tree: the CLI and its test runner below it; Stop asks once more before it signals.
  await session.getByRole("button", { name: "Processes of Improve the chat experience" }).click();
  const child = view.getByRole("listitem", { name: "Process 102" });
  await expect(child).toContainText("vitest");
  await child.getByRole("button", { name: "Stop", exact: true }).click();
  await child.getByRole("button", { name: "Confirm stop" }).click();
  await expect.poll(() => requests.some((r) => r.path === "/api/monitoring/processes/102/stop" && r.method === "POST")).toBe(true);
});

test("hovering a chart survives a poll that drops the hovered point", async ({ page }) => {
  await setupPortal(page);
  const full = monitoringSnapshot();
  let snapshot = full;
  await page.route("**/api/monitoring", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }));
  await openPage(page, "monitoring");
  const view = page.getByRole("region", { name: "Monitoring", exact: true });
  const chart = view.locator('[data-chart="memory"]');
  const svg = chart.getByRole("img");
  const box = (await svg.boundingBox())!;
  // The far right: the newest point.
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
  await expect(chart.locator("line")).toHaveCount(2);
  // The next poll answers a history without the newest points; the crosshair goes, the view stays.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  snapshot = { ...full, history: full.history.slice(0, 10) };
  await expect(chart.locator("line")).toHaveCount(1, { timeout: 8_000 });
  await expect(chart.locator("figcaption")).not.toContainText("—");
  expect(errors).toEqual([]);
});

test("an OS without a probe says so", async ({ page }) => {
  await setupPortal(page);
  const snapshot = monitoringSnapshot();
  await mockMonitoring(page, { ...snapshot, supported: false, sample: null, diskLevel: null, history: [], processes: [], sessions: [], worktrees: [] });
  await openPage(page, "monitoring");
  await expect(page.getByRole("region", { name: "Monitoring", exact: true }).getByText(/Not supported on this OS/)).toBeVisible();
});

test("Settings: the disk levels, the watched folders with a missing one flagged, and the idle stop", async ({ page }) => {
  const fixture = await setupPortal(page);
  const requests = await mockMonitoring(page, monitoringSnapshot());
  await page.goto("/");
  const patches = () => fixture.requests.filter((r) => r.path === "/api/settings" && r.method === "PATCH").map((r) => r.body);

  const dialog = await showSettings(page, "Monitoring");
  const warn = dialog.getByRole("textbox", { name: "Warning below … GB free" });
  await expect(warn).toHaveValue("30");
  // Lowering both: the warning level waits, with a reason, until the critical level makes the pair valid; then one PATCH.
  await warn.fill("10");
  await warn.press("Tab");
  await expect(dialog.getByText("The warning level must be above the critical level (15 GB).")).toBeVisible();
  expect(patches()).toEqual([]);
  const critical = dialog.getByRole("textbox", { name: "Critical below … GB free" });
  await critical.fill("5");
  await critical.press("Tab");
  await expect.poll(() => patches().at(-1)).toEqual({ monitoring: { disk: { warnFreeGb: 10, criticalFreeGb: 5 } } });
  expect(patches()).toHaveLength(1);
  await expect(dialog.getByText("The warning level must be above the critical level (15 GB).")).toHaveCount(0);
  await expect(warn).toHaveValue("10");
  await expect(critical).toHaveValue("5");

  const folders = dialog.getByRole("textbox", { name: "Watched folders" });
  await folders.fill("~/gone\n\n/Users/me/Library/Caches/bazel\n");
  await folders.press("Tab");
  await expect.poll(() => patches().at(-1)).toEqual({ monitoring: { watchedFolders: ["~/gone", "/Users/me/Library/Caches/bazel"] } });
  // Checked right after saving, not from the last survey.
  await expect(dialog.getByText(/Not found: ~\/gone\./)).toBeVisible();
  expect(requests.some((r) => r.path === "/api/monitoring")).toBe(false);

  await dialog.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Sessions", exact: true }).click();
  await dialog.getByRole("switch", { name: "Stop idle agent CLIs" }).click();
  await expect.poll(() => patches().at(-1)).toEqual({ sessions: { idleStop: { enabled: false } } });
});

test("screenshots of the view on a desktop and a phone", async ({ page }) => {
  test.skip(!process.env.MONITORING_SCREENSHOTS, "Set MONITORING_SCREENSHOTS=1 to write /tmp/monitoring-*.png");
  await setupPortal(page);
  await mockMonitoring(page, monitoringSnapshot());
  await openPage(page, "monitoring");
  const view = page.getByRole("region", { name: "Monitoring", exact: true });
  await view.getByRole("button", { name: "Processes of Improve the chat experience" }).click();
  await view.getByRole("button", { name: "Largest items in /Users/me/Library/Caches/bazel" }).click();
  await expect(view.locator('[data-tile="disk"]')).toBeVisible();
  // The view scrolls inside its region: grow the page to it for one picture.
  const height = await view.evaluate((el) => el.scrollHeight + 120);
  await page.setViewportSize({ width: 1440, height });
  await page.screenshot({ animations: "disabled", path: "/tmp/monitoring-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneHeight = await view.evaluate((el) => el.scrollHeight + 120);
  await page.setViewportSize({ width: 390, height: phoneHeight });
  await page.screenshot({ animations: "disabled", path: "/tmp/monitoring-phone.png" });
});
