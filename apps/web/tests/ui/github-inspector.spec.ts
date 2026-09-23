import { expect, test, type Page } from "@playwright/test";
import { failingGithubSummary, githubSummary, setupPortal } from "./fixtures";
import type { GithubSummary } from "../../src/lib/types";

const actionNames = [
  "Investigate merge conflicts in a new conversation",
  "Summarize review items in a new conversation",
  "Investigate failing checks in a new conversation",
] as const;

async function openInspector(page: Page, summary = githubSummary) {
  const fixture = await setupPortal(page, { github: summary });
  await page.goto("/sessions/s3");
  await page
    .getByRole("button", { name: "Open GitHub inspector", exact: true })
    .click();
  const panel = page.locator("#github-inspector");
  await expect(
    panel.getByRole("heading", {
      name: summary.logBase ? "Branch commits" : "Commit history",
      exact: true,
    }),
  ).toBeVisible();
  return { panel, fixture };
}

test("source control copies the PR link without navigating and keeps healthy actions visible", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.body.dataset.copiedPrLink = text;
        },
      },
    });
  });
  const { panel } = await openInspector(page);
  await expect(
    panel.getByText(githubSummary.branch!, { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("+123", { exact: true })).toBeVisible();
  await expect(panel.getByText("−45", { exact: true })).toBeVisible();
  await expect(panel.getByText(/8 files changed/)).toBeVisible();
  // Conversation comments alone do not imply unresolved review feedback.
  for (const name of actionNames)
    await expect(
      panel.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Close GitHub inspector", exact: true }),
  ).toHaveCount(1);
  await expect(panel.getByRole("button", { name: /^GitHub/ })).toHaveCount(0);
  const url = page.url();
  await panel
    .getByRole("button", { name: "Copy PR link", exact: true })
    .click();
  await expect(panel.getByText("Copied", { exact: true })).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute(
    "data-copied-pr-link",
    githubSummary.pull!.url,
  );
  expect(page.url()).toBe(url);
  expect(page.context().pages()).toHaveLength(1);
  expect(
    await panel
      .locator("#github-panel-body")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await expect(
    panel.getByRole("link", { name: /Improve the chat experience/ }),
  ).toHaveAttribute("href", githubSummary.pull!.url);
  await panel.screenshot({
    path: info.outputPath("source-control-healthy.png"),
    animations: "disabled",
  });
});

test("source control reports clipboard failure without navigating", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard denied");
        },
      },
    });
    document.execCommand = () => false;
  });
  const { panel } = await openInspector(page);
  await panel
    .getByRole("button", { name: "Copy PR link", exact: true })
    .click();
  await expect(panel.getByText("Copy failed", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/sessions\/s3$/);
});

test("source control retains disabled rows and committed diff context without a PR", async ({
  page,
}, info) => {
  const summary: GithubSummary = {
    ...githubSummary,
    pull: null,
    diff: {
      source: "branch",
      baseBranch: "main",
      additions: 7,
      deletions: 2,
      files: 1,
    },
  };
  const { panel } = await openInspector(page, summary);
  await expect(
    panel.getByText("No pull request", { exact: true }).first(),
  ).toBeVisible();
  await expect(panel.getByText("+7", { exact: true })).toBeVisible();
  await expect(panel.getByText(/1 file changed/)).toBeVisible();
  for (const name of actionNames)
    await expect(
      panel.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Copy PR link", exact: true }),
  ).toHaveCount(0);
  await panel.screenshot({
    path: info.outputPath("source-control-branch.png"),
    animations: "disabled",
  });
});

test("source control distinguishes unavailable review and conflict data from healthy states", async ({
  page,
}, info) => {
  const { panel } = await openInspector(page, {
    ...githubSummary,
    diff: null,
    conflicts: {
      status: "unknown",
      base: "main",
      reason: "origin/main does not exist locally; fetch to compare.",
    },
    pull: {
      ...githubSummary.pull!,
      unresolvedThreads: null,
      checks: {
        state: "pending",
        passing: 0,
        failing: 0,
        pending: 1,
        checks: [{ name: "Unit tests", state: "pending", url: null }],
      },
    },
  });
  await expect(
    panel.getByText("Review status unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Couldn't check conflicts", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("1 pending", { exact: true })).toBeVisible();
  await expect(
    panel.getByText(/No merge conflicts|No unresolved threads/),
  ).toHaveCount(0);
  for (const name of actionNames)
    await expect(
      panel.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await panel.screenshot({
    path: info.outputPath("source-control-unavailable.png"),
    animations: "disabled",
  });
});

for (const branch of ["main", null]) {
  test(`source control labels full history without a comparison base on ${branch ?? "detached HEAD"}`, async ({
    page,
  }) => {
    const { panel } = await openInspector(page, {
      ...githubSummary,
      branch,
      detached: branch === null,
      pull: null,
      diff: null,
      conflicts: null,
      logBase: null,
      upstream: null,
    });
    await expect(
      panel.getByRole("heading", { name: "Commit history", exact: true }),
    ).toBeVisible();
    await expect(panel.getByText("Base:", { exact: true })).toHaveCount(0);
  });
}

test("source control keeps a closed PR's base distinct from the current history base", async ({
  page,
}, info) => {
  const { panel } = await openInspector(page, {
    ...githubSummary,
    pull: { ...githubSummary.pull!, state: "closed", baseBranch: "release" },
    diff: { ...githubSummary.diff!, baseBranch: "release" },
    commits: [{ ...githubSummary.commits[0], head: false, base: true }],
  });
  await expect(panel.getByText("release", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("PR changes vs release", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Compared with main", { exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("list", { name: "Commits" })
      .getByText("main", { exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("list", { name: "Commits" })
      .getByText("release", { exact: true }),
  ).toHaveCount(0);
  await panel.screenshot({
    path: info.outputPath("source-control-closed-pr.png"),
    animations: "disabled",
  });
});

test("mobile source control keeps long names in bounds and closes after drafting an action", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { panel, fixture } = await openInspector(page, {
    ...failingGithubSummary,
    branch:
      "feature/a-very-long-branch-name-that-should-stay-readable-on-a-small-mobile-screen",
  });
  for (const name of actionNames)
    await expect(
      panel.getByRole("button", { name, exact: true }),
    ).toBeEnabled();
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await panel
      .locator("#github-panel-body")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await panel.screenshot({
    path: info.outputPath("source-control-mobile.png"),
    animations: "disabled",
  });
  await panel
    .getByRole("button", { name: actionNames[1], exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("textbox", { name: "First message" }),
  ).toHaveValue(/PR #42/);
  expect(
    fixture.requests.filter(
      (request) =>
        request.path === "/api/sessions" && request.method === "POST",
    ),
  ).toHaveLength(0);
});
