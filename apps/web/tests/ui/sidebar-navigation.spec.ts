import { expect, test, type Page } from "@playwright/test";
import { firstTitle, makeSession, project, setupPortal, thirdTitle, worktree } from "./fixtures";
import { pane, split, tab, workspaceOf } from "./workspace-fixtures";

const sidebarOf = (page: Page) => page.getByRole("complementary", { name: "Workspace sidebar" });
const projectHeader = (page: Page, id: string) => sidebarOf(page).locator(`button[aria-controls="project-${id}"]`);
const tabsOf = (page: Page) => page.getByRole("tablist", { name: "Workspace tabs" });

const longProjectList = () => {
  const projects = Array.from({ length: 18 }, (_, i) => ({
    ...project,
    id: `project-${i}`,
    name: `Project ${i}`,
    path: `/workspace/project-${i}`,
    createdAt: 1,
  }));
  return {
    projects,
    sessions: projects.map((entry, i) => ({
      ...makeSession(`session-${i}`, `Work ${i}`, "claude", entry),
      lastActiveAt: Date.now() - i * 60_000,
    })),
  };
};

test("direct links, tabs, and search highlight the collapsed project without opening it", async ({ page }) => {
  await setupPortal(page, {
    workspace: workspaceOf([tab("t1", pane("a", "s1")), tab("t2", pane("b", "s3"))]),
  });
  await page.addInitScript((id) => localStorage.setItem("portal.sidebar.collapsed", JSON.stringify([id])), worktree.id);
  await page.goto("/sessions/s1");
  const worktreeHeader = projectHeader(page, worktree.id);
  await expect(worktreeHeader).toHaveAttribute("aria-current", "page");
  await expect(worktreeHeader).toHaveAttribute("aria-expanded", "false");
  await expect(sidebarOf(page).getByRole("button", { name: firstTitle, exact: true })).toBeHidden();

  await tabsOf(page).getByRole("tab", { name: thirdTitle }).click();
  await expect(sidebarOf(page).getByRole("button", { name: thirdTitle, exact: true })).toHaveAttribute("aria-current", "page");
  await expect(worktreeHeader).not.toHaveAttribute("aria-current");
  await expect(projectHeader(page, project.id)).not.toHaveAttribute("aria-current");

  await sidebarOf(page).getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search" });
  await search.getByRole("combobox", { name: "Search" }).fill("Improve the chat");
  await search.getByRole("option").filter({ hasText: firstTitle }).click();
  await expect(page).toHaveURL(/\/tabs\/t1$/);
  await expect(worktreeHeader).toHaveAttribute("aria-current", "page");
  await expect(worktreeHeader).toHaveAttribute("aria-expanded", "false");

  // Expanding returns the current indicator to the session; collapsing brings it to the project.
  await worktreeHeader.click();
  await expect(worktreeHeader).not.toHaveAttribute("aria-current");
  await expect(sidebarOf(page).getByRole("button", { name: firstTitle, exact: true })).toHaveAttribute("aria-current", "page");
  await worktreeHeader.click();
  await expect(worktreeHeader).toHaveAttribute("aria-current", "page");
});

test("a split tab follows the focused pane's collapsed project", async ({ page }) => {
  await setupPortal(page, {
    workspace: workspaceOf([tab("t1", split("split", "row", [pane("a", "s1"), pane("b", "s3")]))]),
  });
  await page.addInitScript((ids) => localStorage.setItem("portal.sidebar.collapsed", JSON.stringify(ids)), [project.id, worktree.id]);
  await page.goto("/tabs/t1?pane=a");
  await expect(projectHeader(page, worktree.id)).toHaveAttribute("aria-current", "page");
  await page.locator('[data-pane="b"] header.workspace-header').click({ position: { x: 4, y: 4 } });
  await expect(page).toHaveURL(/\?pane=b$/);
  await expect(projectHeader(page, project.id)).toHaveAttribute("aria-current", "page");
  await expect(projectHeader(page, worktree.id)).not.toHaveAttribute("aria-current");
  await expect(projectHeader(page, project.id)).toHaveAttribute("aria-expanded", "false");
  await expect(projectHeader(page, worktree.id)).toHaveAttribute("aria-expanded", "false");
});

test("selection scrolls inside the sidebar on navigation and reopening, with no jump for background updates", async ({ page }) => {
  await setupPortal(page, {
    ...longProjectList(),
    workspace: workspaceOf([tab("t1", pane("a", "session-0")), tab("t2", pane("b", "session-17"))]),
  });
  await page.goto("/sessions/session-17");
  const scroll = sidebarOf(page).locator("[data-sidebar-scroll]");
  const current = sidebarOf(page).getByRole("button", { name: "Work 17", exact: true });
  await expect(current).toBeInViewport({ ratio: 1 });
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await scroll.evaluate((el) => { el.scrollTop = 0; });
  await page.evaluate(async () => {
    await window.__portalEmit("/api/sessions/stream", { type: "updated", id: "session-0", patch: { busy: true } }, "message");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(sidebarOf(page).getByRole("button", { name: "Work 0", exact: true }).getByLabel("Working")).toHaveCount(1);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);

  await tabsOf(page).getByRole("tab", { name: "Work 0", exact: true }).click();
  await tabsOf(page).getByRole("tab", { name: "Work 17", exact: true }).click();
  await expect(current).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);

  const collapsed = projectHeader(page, "project-17");
  await collapsed.click();
  await expect(collapsed).toHaveAttribute("aria-current", "page");
  await scroll.evaluate((el) => { el.scrollTop = 0; });
  await tabsOf(page).getByRole("tab", { name: "Work 0", exact: true }).click();
  await tabsOf(page).getByRole("tab", { name: "Work 17", exact: true }).click();
  await expect(collapsed).toBeInViewport({ ratio: 1 });
  await expect(collapsed).toHaveAttribute("aria-expanded", "false");
  await expect(current).toBeHidden();

  // A quick close/reopen keeps the component mounted through the exit animation.
  await scroll.evaluate((el) => { el.scrollTop = 0; });
  await page.evaluate(async () => {
    const toggle = document.querySelector<HTMLElement>('[data-workspace-layer] button[aria-label="Toggle sidebar"]')!;
    for (let i = 0; i < 2; i++) {
      toggle.click();
      await Promise.resolve();
      await Promise.resolve();
    }
  });
  await expect(collapsed).toBeInViewport({ ratio: 1 });

  // Reopening mounts a fresh tree and reveals the current item again.
  await sidebarOf(page).getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(sidebarOf(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle sidebar", exact: true }).first().click();
  await expect(collapsed).toBeInViewport({ ratio: 1 });
});

test("start pages highlight their shared selected project and sessions take over when focused", async ({ page }) => {
  await setupPortal(page, {
    workspace: workspaceOf([tab("t1", pane("a", "s1")), tab("t2", pane("b", null))]),
  });
  await page.goto("/tabs/t1");
  await sidebarOf(page).getByRole("button", { name: "New conversation in portal", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "First message" })).toBeVisible();
  await expect(projectHeader(page, project.id)).toHaveAttribute("aria-current", "page");
  await projectHeader(page, project.id).click();
  await expect(projectHeader(page, project.id)).toHaveAttribute("aria-expanded", "false");
  await expect(projectHeader(page, project.id)).toHaveAttribute("aria-current", "page");

  await tabsOf(page).getByRole("tab", { name: firstTitle }).click();
  await expect(sidebarOf(page).getByRole("button", { name: firstTitle, exact: true })).toHaveAttribute("aria-current", "page");
  await expect(projectHeader(page, project.id)).not.toHaveAttribute("aria-current");
  // The other start page uses the same selection, rather than remembering its own project.
  await tabsOf(page).locator('[data-tab-trigger="t2"]').click();
  await expect(projectHeader(page, project.id)).toHaveAttribute("aria-current", "page");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("opening and reopening the sheet reveals the collapsed project, then expanding reveals its session", async ({ page }) => {
    const list = longProjectList();
    await setupPortal(page, list);
    await page.addInitScript((ids) => localStorage.setItem("portal.sidebar.collapsed", JSON.stringify(ids)), list.projects.map((entry) => entry.id));
    await page.goto("/sessions/session-17");
    const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true });
    const sheet = page.getByRole("dialog", { name: "Your workspace" });
    const header = sheet.locator('button[aria-controls="project-project-17"]');
    await toggle.click();
    await expect(header).toHaveAttribute("aria-current", "page");
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(header).toBeInViewport({ ratio: 1 });
    await sheet.locator("[data-sidebar-scroll]").evaluate((el) => { el.scrollTop = 0; });
    await sheet.getByRole("button", { name: "Close sidebar", exact: true }).click();
    await expect(sheet).toHaveCount(0);

    await toggle.click();
    await expect(header).toBeInViewport({ ratio: 1 });
    await header.click();
    const current = sheet.getByRole("button", { name: "Work 17", exact: true });
    await expect(current).toHaveAttribute("aria-current", "page");
    await expect(current).toBeInViewport({ ratio: 1 });
    await expect(header).not.toHaveAttribute("aria-current");
  });
});
