import { expect, test, type Page } from "@playwright/test";
import { makeSession, portalItem, project, removedProject, setupPortal, worktree } from "./fixtures";
import type { ProjectSummary } from "../../src/lib/types";

const sidebarOf = (page: Page) => page.getByRole("complementary", { name: "Workspace sidebar" });
const renames = (requests: { path: string; method: string; body: unknown }[]) =>
  requests.filter((r) => r.method === "PATCH" && /^\/api\/sessions\/[^/]+$/.test(r.path));

test("a session renames from the sidebar menu; a refused title says why and puts the old one back", async ({ page }) => {
  const fixture = await setupPortal(page, { sessions: [makeSession("s1", "Old title")] });
  await page.goto("/new");
  const sidebar = sidebarOf(page);
  await sidebar.getByRole("button", { name: "Actions for Old title" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = sidebar.getByRole("textbox", { name: "Session title" });
  await expect(field).toBeFocused();
  await field.fill("Renamed in the sidebar");
  await field.press("Enter");
  await expect(sidebar.getByRole("button", { name: "Renamed in the sidebar", exact: true })).toBeVisible();
  expect(renames(fixture.requests).at(-1)?.body).toEqual({ title: "Renamed in the sidebar" });

  fixture.failRename("That title is taken.");
  await sidebar.getByRole("button", { name: "Actions for Renamed in the sidebar" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await field.fill("Refused title");
  await field.press("Enter");
  await expect(sidebar.getByRole("alert")).toHaveText("That title is taken.");
  await expect(sidebar.getByRole("button", { name: "Renamed in the sidebar", exact: true })).toBeVisible();
});

test("a title over 120 characters keeps the rename field open with an error and is not sent", async ({ page }) => {
  // An agent's title can be longer than a user may type.
  const long = `Investigate ${"the flaky integration suite ".repeat(5)}`.trim();
  expect(long.length).toBeGreaterThan(120);
  const fixture = await setupPortal(page, { sessions: [makeSession("s1", long)] });
  await page.goto("/new");
  const sidebar = sidebarOf(page);
  await sidebar.getByRole("button", { name: `Actions for ${long}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = sidebar.getByRole("textbox", { name: "Session title" });
  await field.fill(`${long} again`);
  await field.press("Enter");
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(`${long} again`);
  await expect(sidebar.getByRole("alert")).toContainText("Keep it to 120 characters");
  // Leaving the field does not lose the draft either.
  await field.blur();
  await expect(field).toHaveValue(`${long} again`);
  expect(renames(fixture.requests)).toHaveLength(0);

  await field.fill("Flaky integration suite");
  await expect(sidebar.getByRole("alert")).toHaveCount(0);
  await field.press("Enter");
  await expect(sidebar.getByRole("button", { name: "Flaky integration suite", exact: true })).toBeVisible();
  expect(renames(fixture.requests).at(-1)?.body).toEqual({ title: "Flaky integration suite" });
});

test("a session renames from its header; a refused title shows the server's error", async ({ page }) => {
  const fixture = await setupPortal(page, { sessions: [makeSession("s1", "Header title")] });
  await page.goto("/sessions/s1");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Header title");
  await page.getByRole("button", { name: "Rename conversation" }).click();
  const field = page.getByRole("textbox", { name: "Conversation title" });
  await field.fill("Renamed in the header");
  await field.press("Enter");
  await expect(heading).toHaveText("Renamed in the header");
  expect(renames(fixture.requests).at(-1)?.body).toEqual({ title: "Renamed in the header" });

  fixture.failRename("That title is taken.");
  await page.getByRole("button", { name: "Rename conversation" }).click();
  await field.fill("Refused title");
  await field.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "That title is taken." })).toBeVisible();
  await expect(heading).toHaveText("Renamed in the header");
});

test("the header says Background with the task titles while background work runs", async ({ page }) => {
  await setupPortal(page, {
    sessions: [
      {
        ...makeSession("s1", "Run the suite"),
        liveness: "background",
        idleSince: null,
        backgroundTasks: [{ id: "t1", title: "bazel test //...", taskType: "shell", startedAt: Date.now(), canStop: true }],
      },
    ],
  });
  await page.goto("/sessions/s1");
  await expect(page.locator("header.workspace-header").getByRole("status")).toHaveText("Background · bazel test //...");
});

test("the Sessions settings save a clock and refuse an out-of-range or unparsable one", async ({ page }) => {
  const fixture = await setupPortal(page);
  await page.goto("/");
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("portal:open-settings", { detail: { section: "sessions" } })),
  );
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("heading", { name: "Sessions" })).toBeVisible();
  const untrack = dialog.getByRole("textbox", { name: /Untrack a finished session after/ });
  const remove = dialog.getByRole("textbox", { name: /Remove an idle worktree after/ });
  await expect(untrack).toHaveValue("48");
  await expect(remove).toHaveValue("72");
  const patches = () =>
    fixture.requests.filter((r) => r.path === "/api/settings" && r.method === "PATCH").map((r) => r.body);

  await untrack.fill("24");
  await untrack.press("Tab");
  await expect.poll(() => patches().at(-1)).toEqual({ sessions: { tracked: { untrackAfterHours: 24 } } });
  await expect(dialog.getByText("Saved", { exact: true })).toBeVisible();

  const sent = patches().length;
  await remove.fill("721");
  await remove.press("Tab");
  await expect(dialog.getByRole("alert")).toHaveText("Enter a whole number of hours from 1 to 720.");
  // Not a number at all is refused too, rather than read as blank (the default).
  await remove.fill("5e");
  await remove.press("Tab");
  await expect(dialog.getByRole("alert")).toHaveText("Enter a whole number of hours from 1 to 720.");
  expect(patches()).toHaveLength(sent);
});

test("the Data section retries a failed count, then deletes removed sessions", async ({ page }) => {
  const fixture = await setupPortal(page, { removed: [removedProject] });
  // The count fails until the server is back; the Retry control asks again.
  let failing = true;
  await page.route("**/api/projects/removed", (route) => {
    if (!failing) return route.fallback();
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Database unavailable." }) });
  });
  await page.goto("/");
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("portal:open-settings", { detail: { section: "data" } })),
  );
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("alert")).toHaveText("Database unavailable.");
  const remove = dialog.getByRole("button", { name: "Delete removed sessions" });
  await expect(remove).toBeDisabled();
  failing = false;
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByText("2 removed sessions.")).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  await remove.click();
  const confirm = dialog.getByRole("group", { name: "Delete removed sessions?" });
  await expect(confirm).toContainText("Delete 2 removed sessions for good?");
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog.getByText("Deleted 2 sessions.")).toBeVisible();
  await expect(dialog.getByText("No removed sessions.")).toBeVisible();
  await expect(remove).toBeDisabled();
  expect(fixture.requests.some((r) => r.path === "/api/sessions/removed" && r.method === "DELETE")).toBe(true);
});

test("worktree rows say when they will be removed, or why the sweep kept them", async ({ page }) => {
  const held: ProjectSummary = {
    ...worktree,
    id: "p3",
    name: "terminal-held",
    path: "/workspace/portal-held",
    keptReason: "open terminal",
    // Long past due: the reason still shows instead of "removes soon".
    createdAt: Date.now() - 30 * 24 * 3_600_000,
  };
  await setupPortal(page, {
    projects: [project, worktree, held],
    sessions: [
      // Idle an hour of the default 72: "removes in 2d".
      { ...makeSession("s1", "Idle worktree work"), idleSince: Date.now() - 3_600_000 },
      makeSession("s3", "Main checkout work", "codex", project),
    ],
  });
  await page.goto("/new");
  const sidebar = sidebarOf(page);
  await expect(sidebar.getByRole("region", { name: worktree.name }).getByTestId("worktree-retention")).toHaveText("removes in 2d");
  await expect(sidebar.getByRole("region", { name: held.name }).getByTestId("worktree-retention")).toHaveText("kept: open terminal");
  // Folders the user added are never swept.
  await expect(sidebar.getByRole("region", { name: project.name, exact: true }).getByTestId("worktree-retention")).toHaveCount(0);
});

test("six open items: the Needs-you badge says 6, the page lists six cards by kind, and the chat shows none", async ({ page }) => {
  const items = Array.from({ length: 6 }, (_, i) => ({
    ...portalItem,
    id: `i${i + 1}`,
    kind: i < 4 ? ("pr_checks_failing" as const) : ("pr_conflicts" as const),
    title: `${i < 4 ? "Checks are failing" : "Merge conflicts"} on example/portal#${40 + i}`,
    fingerprint: `pr:example/portal#${40 + i}`,
    updatedAt: Date.now() - i * 1000,
  }));
  await setupPortal(page, { portal: { items } });
  await page.goto("/");
  await expect(page.getByText("Nothing yet. I will keep an eye on your pull requests.")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  const entry = page.getByRole("complementary", { name: "Workspace sidebar" }).getByRole("button", { name: /Needs your attention|All caught up|Work in progress/ });
  await expect(entry).toContainText("6 items need you");

  await entry.click();
  const view = page.getByRole("region", { name: "Needs your attention" });
  await expect(view.getByRole("article")).toHaveCount(6);
  await expect(view.getByRole("region", { name: /^Checks failing/ }).getByRole("article")).toHaveCount(4);
  await expect(view.getByRole("region", { name: /^Merge conflicts/ }).getByRole("article")).toHaveCount(2);
  for (const item of items) await expect(view.getByRole("article", { name: item.title })).toBeVisible();
});
