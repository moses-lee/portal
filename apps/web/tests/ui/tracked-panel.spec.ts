import { expect, test, type Page } from "@playwright/test";
import { makeSession, portalItem, project, setupPortal } from "./fixtures";
import type { SessionSummary } from "../../src/lib/types";

const finishedTitle = "Summarise the review of PR 42";
const workingTitle = "Add the tracked sessions panel";
const approvalTitle = "Migrate the tracked sessions table";
const hungTitle = "Run the full bazel suite";
const untrackedTitle = "An untracked conversation";

function trackedSessions(): SessionSummary[] {
  const minute = 60_000;
  return [
    { ...makeSession("s1", finishedTitle), lastActiveAt: Date.now() - 5 * minute },
    { ...makeSession("s2", workingTitle, "codex"), busy: true, liveness: "busy", lastActiveAt: Date.now() - minute },
    { ...makeSession("s3", approvalTitle, "claude", project), awaitingPermission: true, liveness: "blocked" },
    { ...makeSession("s4", hungTitle, "codex", project), busy: true, liveness: "hung" },
    makeSession("s5", untrackedTitle),
  ];
}

const tracked = ["s1", "s2", "s3", "s4"].map((sessionId, i) => ({
  sessionId,
  trackedAt: Date.now() - i * 1000,
  trackedBy: i % 2 ? ("portal" as const) : ("user" as const),
}));

const setup = (page: Page) => setupPortal(page, { sessions: trackedSessions(), portal: { tracked } });
const panelOf = (page: Page) => page.getByRole("complementary", { name: "Tracked sessions" });

test("the panel lists tracked sessions in their groups with state badges", async ({ page }, info) => {
  await setup(page);
  await page.goto("/");
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { name: "Tracked (4)" })).toBeVisible();

  const groups = panel.getByRole("region");
  await expect(groups).toHaveCount(4);
  const expected: [string, string, string][] = [
    ["Needs approval", approvalTitle, "Needs approval"],
    ["Finished", finishedTitle, "Finished"],
    ["Working", workingTitle, "Working"],
    ["Offline or hung", hungTitle, "Hung"],
  ];
  for (const [index, [group, title, badge]] of expected.entries()) {
    await expect(groups.nth(index)).toHaveAccessibleName(group);
    const row = groups.nth(index).getByRole("button", { name: title, exact: true });
    await expect(row).toBeVisible();
    await expect(row.locator("[data-state]")).toHaveText(badge);
  }
  // Project name and age under the title; untracked sessions stay out.
  await expect(groups.nth(0).getByRole("button", { name: approvalTitle, exact: true })).toContainText(project.name);
  await expect(groups.nth(1).getByRole("button", { name: finishedTitle, exact: true })).toContainText("5m ago");
  await expect(panel.getByText(untrackedTitle)).toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: info.outputPath("tracked-list.png") });
});

test("the panel collapses to a toggle with the waiting count, and the choice survives a reload", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Collapse tracked sessions" }).click();
  await expect(panel.getByRole("heading", { name: /Tracked/ })).toHaveCount(0);
  // Needs approval (s3) and finished (s1) wait on the user.
  const toggle = panel.getByRole("button", { name: "Show tracked sessions (2 waiting on you)" });
  await expect(toggle).toBeVisible();
  await expect(toggle.getByTestId("tracked-attention")).toHaveText("2");

  await page.reload();
  await expect(panelOf(page).getByRole("button", { name: /Show tracked sessions/ })).toBeVisible();
  await panelOf(page).getByRole("button", { name: /Show tracked sessions/ }).click();
  await expect(panelOf(page).getByRole("heading", { name: "Tracked (4)" })).toBeVisible();
});

test("untrack from a row's menu sends DELETE and drops the row", async ({ page }) => {
  const fixture = await setup(page);
  await page.goto("/");
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { name: "Tracked (4)" })).toBeVisible();

  await panel.getByRole("button", { name: `Actions for ${workingTitle}` }).click();
  // Stop turn is offered only while the session works.
  await expect(page.getByRole("menuitem", { name: "Stop turn" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Untrack" }).click();

  await expect(panel.getByRole("button", { name: workingTitle, exact: true })).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Tracked (3)" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Working" })).toHaveCount(0);
  expect(fixture.requests.some((r) => r.method === "DELETE" && r.path === "/api/portal/tracked/s2")).toBe(true);

  await panel.getByRole("button", { name: `Actions for ${finishedTitle}` }).click();
  await expect(page.getByRole("menuitem", { name: "Stop turn" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("a row click opens the session in the panel through ?session=, which survives a reload and view switches", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  const panel = panelOf(page);
  await panel.getByRole("button", { name: finishedTitle, exact: true }).click();
  await expect(page).toHaveURL(/\/\?session=s1$/);
  await expect(panel.getByRole("heading", { name: finishedTitle })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Back to tracked sessions" })).toBeVisible();

  await page.reload();
  await expect(panelOf(page).getByRole("heading", { name: finishedTitle })).toBeVisible();

  // Switching Portal views keeps the panel's session.
  await page.getByRole("navigation", { name: "Portal", exact: true }).getByRole("button", { name: "Goals", exact: true }).click();
  await expect(page).toHaveURL(/\/goals\?session=s1$/);
  await expect(panelOf(page).getByRole("heading", { name: finishedTitle })).toBeVisible();

  await panelOf(page).getByRole("button", { name: "Back to tracked sessions" }).click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(panelOf(page).getByRole("heading", { name: "Tracked (4)" })).toBeVisible();
});

test("the session header's Track toggle tracks and untracks the open session", async ({ page }) => {
  const fixture = await setup(page);
  await page.goto("/sessions/s5");
  const toggle = page.getByRole("button", { name: "Track session", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(fixture.requests.some((r) => r.method === "PUT" && r.path === "/api/portal/tracked/s5")).toBe(true);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(fixture.requests.some((r) => r.method === "DELETE" && r.path === "/api/portal/tracked/s5")).toBe(true);
});

test("a project row's menu tracks a session, and the panel then lists it", async ({ page }) => {
  const fixture = await setup(page);
  await page.goto("/sessions/s5");
  await page.getByRole("button", { name: `Actions for ${untrackedTitle}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Track session", exact: true }).click();
  await expect.poll(() => fixture.requests.some((r) => r.method === "PUT" && r.path === "/api/portal/tracked/s5")).toBe(true);
  await page.getByRole("button", { name: `Actions for ${untrackedTitle}`, exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Untrack session", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Portal home" }).click();
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { name: "Tracked (5)" })).toBeVisible();
  await expect(panel.getByRole("button", { name: untrackedTitle, exact: true })).toBeVisible();
});

test("retired session items stay out of the Needs-you strip", async ({ page }) => {
  await setupPortal(page, {
    sessions: trackedSessions(),
    portal: {
      tracked,
      items: [
        portalItem,
        {
          ...portalItem,
          id: "i-retired",
          kind: "session_finished",
          title: "Session s1 finished",
          fingerprint: "session_finished:s1",
          actions: [{ type: "open_session", sessionId: "s1" }],
        },
      ],
    },
  });
  await page.goto("/");
  const strip = page.getByRole("region", { name: "Needs you (1)" });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole("button", { name: /Checks are failing/ })).toBeVisible();
  await expect(page.getByText("Session s1 finished")).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the list is a sheet from the header; closing it clears ?session=", async ({ page }) => {
    await setup(page);
    await page.goto("/");
    await expect(page.getByRole("complementary", { name: "Tracked sessions" })).toHaveCount(0);
    await page.locator("#tracked-toggle").click();
    const sheet = page.getByRole("dialog", { name: "Tracked sessions" });
    await expect(sheet.getByRole("heading", { name: "Tracked (4)" })).toBeVisible();

    await sheet.getByRole("button", { name: finishedTitle, exact: true }).click();
    await expect(page).toHaveURL(/\/\?session=s1$/);
    await expect(sheet.getByRole("heading", { name: finishedTitle })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Tracked sessions" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });
});
