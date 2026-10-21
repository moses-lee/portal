import { expect, test, type Page } from "@playwright/test";
import { makeSession, project, removedProject, setupPortal } from "./fixtures";
import type { StoredEvent } from "../../src/lib/types";

const retainedProject = { ...project, ...removedProject };
const removedSession = (id: string, title: string) => ({
  ...makeSession(id, title, "codex", retainedProject),
  project: null,
  cwdMissing: true,
});
const banner = (page: Page) => page.locator("[data-removed-project]");
async function openSearch(page: Page) {
  // The navigation button exists in the server HTML before its client handler is attached.
  await expect(page.getByText(/^(⌘K|Ctrl K)$/)).toBeVisible();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
}
const history: StoredEvent[] = [
  { seq: 0, ts: 1, type: "user", text: "Retained project history" },
  { seq: 1, ts: 2, type: "turn_start" },
  { seq: 2, ts: 3, type: "permission_request", requestId: "old-approval", toolCall: { toolCallId: "tool-1", title: "Run tests", kind: "execute" }, options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }] },
];

async function sessionStreamQueries(page: Page) {
  return page.evaluate(() => window.__portalStreamUrls
    .filter((url) => url.startsWith("/api/sessions/streams?"))
    .map((url) => Object.fromEntries(new URL(url, location.origin).searchParams)));
}

test("removed sessions are labeled in recents, title matches, and message matches; opening keeps history read only", async ({ page }) => {
  const fixture = await setupPortal(page, {
    projects: [project],
    removed: [removedProject],
    sessions: [removedSession("s8", "Retained work")],
    history,
    search: () => ({ messages: [{ sessionId: "s8", seq: 0, role: "user", ts: 1, snippet: "Retained project history" }], pulls: [] }),
  });
  await page.goto("/new");
  await openSearch(page);
  const search = page.getByRole("dialog", { name: "Search" });
  await expect(search.getByRole("group", { name: "Recent sessions", exact: true }).getByRole("option")).toContainText("Removed");
  await search.getByRole("combobox", { name: "Search" }).fill("Retained");
  await expect(search.getByRole("group", { name: "Sessions", exact: true }).getByRole("option")).toContainText("Removed");
  const message = search.getByRole("group", { name: "Messages", exact: true }).getByRole("option");
  await expect(message).toContainText("Removed");
  await message.click();

  await expect(banner(page).getByText("Project removed", { exact: true })).toBeVisible();
  await expect(page.getByRole("log", { name: "Messages" })).toContainText("Retained project history");
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Message Codex", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Show terminal|Reconnect|Rename conversation/ })).toHaveCount(0);
  await expect.poll(async () => (await sessionStreamQueries(page)).length).toBeGreaterThan(0);
  expect((await sessionStreamQueries(page)).every((query) => !query.attach?.split(",").includes("s8"))).toBe(true);
  expect(fixture.requests.filter((request) => /\/(attach|prompt|permission|config|cancel|terminals)$/.test(request.path) && request.method !== "GET")).toHaveLength(0);

  await openSearch(page);
  await expect(search.getByRole("group", { name: "Recent", exact: true }).getByRole("option")).toContainText("Removed");
});

test("restore continues the opened conversation, restores its siblings, and reattaches only after restoration", async ({ page }) => {
  const older = { ...removedSession("s8", "Specific older conversation"), lastActiveAt: 1 };
  const newer = { ...removedSession("s9", "Newest conversation"), lastActiveAt: 2 };
  const fixture = await setupPortal(page, { projects: [project], sessions: [older, newer], removed: [removedProject], history: history.slice(0, 1) });
  await page.goto("/sessions/s8");
  await expect(banner(page)).toBeVisible();
  await expect.poll(async () => (await sessionStreamQueries(page)).length).toBeGreaterThan(0);
  expect((await sessionStreamQueries(page)).every((query) => query.attach === "")).toBe(true);
  await banner(page).getByRole("button", { name: "Restore project and continue", exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('[data-pane][data-session="s8"]')).toBeVisible();
  await expect(page.getByLabel("Message Codex", { exact: true })).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  await expect(sidebar.getByRole("button", { name: "Specific older conversation", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Newest conversation", exact: true })).toBeVisible();
  await expect.poll(async () => (await sessionStreamQueries(page)).some((query) => query.attach?.split(",").includes("s8"))).toBe(true);
  expect(fixture.requests.filter((request) => request.method === "POST" && request.path === "/api/projects/removed/p9/restore")).toHaveLength(1);
});

test("an unavailable restoration explains its blocker", async ({ page }) => {
  await setupPortal(page, { projects: [project], sessions: [removedSession("s8", "Retained work")], removed: [{ ...removedProject, restorable: false, reason: "The original branch is gone." }] });
  await page.goto("/sessions/s8");
  await expect(banner(page)).toContainText("The original branch is gone.");
  await expect(banner(page).getByRole("button", { name: "Restore project and continue", exact: true })).toBeDisabled();
});

test("a refused restore keeps the transcript and shows the server error", async ({ page }) => {
  await setupPortal(page, { projects: [project], sessions: [removedSession("s8", "Retained work")], removed: [removedProject], history: history.slice(0, 1) });
  await page.route("**/api/projects/removed/p9/restore", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "The original path is occupied." }) }));
  await page.goto("/sessions/s8");
  await banner(page).getByRole("button", { name: "Restore project and continue", exact: true }).click();
  await expect(banner(page).getByRole("alert")).toHaveText("The original path is occupied.");
  await expect(banner(page).getByRole("button", { name: "Restore project and continue", exact: true })).toBeEnabled();
  await expect(page.getByRole("log", { name: "Messages" })).toContainText("Retained project history");
});

test("restoration availability errors can be retried without leaving the conversation", async ({ page }) => {
  await setupPortal(page, { projects: [project], sessions: [removedSession("s8", "Retained work")], removed: [removedProject] });
  let unavailable = true;
  await page.route("**/api/projects/removed", (route) => unavailable
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Restoration status is unavailable." }) })
    : route.fallback());
  await page.goto("/sessions/s8");
  await expect(banner(page).getByRole("alert")).toHaveText("Restoration status is unavailable.");
  unavailable = false;
  await banner(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(banner(page).getByRole("alert")).toHaveCount(0);
  await expect(banner(page).getByRole("button", { name: "Restore project and continue", exact: true })).toBeEnabled();
});

test("legacy sessions without a project or restoration record stay readable and explain the blocker", async ({ page }) => {
  await setupPortal(page, { projects: [project], sessions: [{ ...removedSession("s8", "Unassigned conversation"), projectId: "" }], history: history.slice(0, 1) });
  await page.goto("/sessions/s8");
  await expect(banner(page)).toContainText("No restoration record is available for this project.");
  await expect(banner(page).getByRole("button", { name: "Restore project and continue", exact: true })).toBeDisabled();
  await expect(page.getByRole("log", { name: "Messages" })).toContainText("Retained project history");
  await expect(page.getByLabel("Message Codex", { exact: true })).toHaveCount(0);
});

test("removal before a streamed frame renders resumes from the last applied event", async ({ page }) => {
  await setupPortal(page, { projects: [project], sessions: [makeSession("s8", "Live conversation", "codex", project)], history: history.slice(0, 1) });
  await page.goto("/sessions/s8");
  await expect.poll(async () => (await sessionStreamQueries(page)).some((query) => query.attach === "s8")).toBe(true);
  await page.evaluate(async () => {
    const schedule = window.requestAnimationFrame;
    // Hold the stream's pending frame while metadata triggers a history-only subscription.
    window.requestAnimationFrame = () => 0;
    try {
      const session = window.__portalSessions.find((item) => item.id === "s8");
      if (session) session.project = null;
      await window.__portalEmit("/api/sessions/s8/stream", { type: "user", text: "A frame waiting to render", ts: 4 }, "message", 100);
      await window.__portalEmit("/api/sessions/s8/stream", { project: null }, "meta");
    } finally {
      window.requestAnimationFrame = schedule;
    }
  });
  await expect(banner(page)).toBeVisible();
  await expect.poll(async () => (await sessionStreamQueries(page)).some((query) => query.attach === "")).toBe(true);
  const query = (await sessionStreamQueries(page)).at(-1);
  expect(query?.since).toBe("s8:0");
  // The server replays the unapplied event after that cursor; it must still reach the transcript.
  await page.evaluate(() => window.__portalEmit("/api/sessions/s8/stream", { type: "user", text: "A frame waiting to render", ts: 4 }, "message", 100));
  await expect(page.getByRole("log", { name: "Messages" })).toContainText("A frame waiting to render");
});
