import { expect, test, type Page } from "@playwright/test";
import { firstTitle, project, removedProject, sessions, setupPortal, worktree } from "./fixtures";

const sidebarOf = (page: Page) => page.getByRole("complementary", { name: "Workspace sidebar" });
const removedWorktree = {
  ...removedProject,
  id: worktree.id,
  name: worktree.name,
  path: worktree.path,
  displayPath: worktree.displayPath,
  worktree: worktree.worktree,
  sessionCount: 2,
};

test("a project removed elsewhere updates the open history, sidebar, and search without a reload", async ({ page }) => {
  const fixture = await setupPortal(page, { removed: [] });
  await page.goto("/sessions/s1");
  await expect(page.getByLabel("Message Claude Code", { exact: true })).toBeVisible();

  await fixture.pushProjects([project], [removedWorktree]);
  const banner = page.locator("[data-removed-project]");
  await expect(banner.getByText("Project removed", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message Claude Code", { exact: true })).toHaveCount(0);
  await expect(sidebarOf(page).locator(`button[aria-controls="project-${worktree.id}"]`)).toHaveCount(0);
  await expect(banner.getByRole("button", { name: "Restore project and continue", exact: true })).toBeEnabled();

  await sidebarOf(page).getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search", exact: true });
  await search.getByRole("combobox", { name: "Search", exact: true }).fill(firstTitle);
  await expect(search.getByRole("option").filter({ hasText: firstTitle }).getByText("Removed", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // The inverse update also reaches an existing pane: another device restored the same project.
  await fixture.pushProjects([project, worktree]);
  await expect(banner).toHaveCount(0);
  await expect(page.getByLabel("Message Claude Code", { exact: true })).toBeVisible();
  await expect(sidebarOf(page).locator(`button[aria-controls="project-${worktree.id}"]`)).toBeVisible();
});

test("a held session-list response cannot undo a newer project-removal event", async ({ page }) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  await expect(page.getByLabel("Message Claude Code", { exact: true })).toBeVisible();
  const stale = structuredClone(sessions);
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === "/api/sessions", async (route) => {
    started();
    await held;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions: stale }) });
  });
  // Discovering an unknown session after reconnect asks the provider for a full list.
  await page.evaluate(() => window.__portalEmit("/api/sessions/stream", {
    type: "snapshot",
    sessions: [...window.__portalSessions.map(({ id }) => ({ id })), { id: "newly-discovered" }],
  }, "message"));
  await requested;
  await fixture.pushProjects([project], [removedWorktree]);
  await expect(page.locator("[data-removed-project]")).toBeVisible();
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sessions");
  release();
  await response;
  await expect(page.locator("[data-removed-project]")).toBeVisible();
  await expect(page.getByLabel("Message Claude Code", { exact: true })).toHaveCount(0);
  await sidebarOf(page).getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search", exact: true });
  await search.getByRole("combobox", { name: "Search", exact: true }).fill(firstTitle);
  await expect(search.getByRole("option").filter({ hasText: firstTitle }).getByText("Removed", { exact: true })).toBeVisible();
});

test("a confirmed restore survives a stale removed-list response and failed session refresh", async ({ page }) => {
  const retained = sessions.map((session) => session.projectId === worktree.id ? { ...session, project: null } : session);
  await setupPortal(page, { projects: [project], removed: [removedWorktree], sessions: retained });
  await page.goto("/sessions/s1");
  const banner = page.locator("[data-removed-project]");
  await expect(banner.getByRole("button", { name: "Restore project and continue", exact: true })).toBeEnabled();

  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === "/api/projects/removed", async (route) => {
    started();
    await held;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ removed: [removedWorktree] }) });
  });
  // A refresh is already in flight when this device restores the project.
  await page.evaluate((project) => window.__portalEmit("/api/sessions/stream", { projects: [{ id: project.id, name: project.name }] }, "projects"), project);
  await requested;
  await page.route((url) => url.pathname === "/api/sessions", (route) => route.fulfill({ status: 500, body: "Unavailable" }));
  await banner.getByRole("button", { name: "Restore project and continue", exact: true }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByLabel("Message Claude Code", { exact: true })).toBeVisible();

  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects/removed");
  release();
  await response;
  await expect(page.getByLabel("Message Claude Code", { exact: true })).toBeVisible();
  await expect(banner).toHaveCount(0);
});
