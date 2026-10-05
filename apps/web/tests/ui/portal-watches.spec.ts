import { expect, test } from "@playwright/test";
import { emitPortal, portalStatus, setupPortal } from "./fixtures";
import type { Intent } from "../../src/lib/orchestrator/types";
import { failedRun, helperJob, helperRun, intent, intentJob, mainThread, nightlyJob, reviewThread } from "./orchestrator-fixtures";

const portal = () => ({
  threads: [mainThread, reviewThread],
  intents: [intent],
  jobs: [helperJob, intentJob, nightlyJob],
  runs: [helperRun, failedRun],
  status: { counts: { needsYou: 1, inbox: 0, approvals: 0, intents: 1 } },
});

test("Watches lists the active intents, upcoming jobs by next run, and recent runs", async ({ page }, info) => {
  const fixture = await setupPortal(page, { portal: portal() });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Portal", exact: true }).getByRole("button", { name: "Watches", exact: true }).click();
  await expect(page).toHaveURL(/\/watches$/);
  const view = page.getByRole("region", { name: "Watches" });

  const card = view.getByRole("article", { name: intent.text });
  await expect(card.getByText(intent.trigger)).toBeVisible();
  await expect(card.getByText(intent.action)).toBeVisible();
  await expect(card.getByText("0 of 1 fired")).toBeVisible();
  await expect(card.getByText(/checked 4 min ago/)).toBeVisible();
  await card.getByRole("button", { name: "Portal’s notes" }).click();
  await expect(card.getByText("green")).toBeVisible();

  // Active and paused jobs, soonest first; the paused one sorts last with no next run.
  const rows = view.getByRole("list", { name: "Upcoming jobs" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(intentJob.title);
  await expect(rows.nth(0)).toContainText("Every 2 minutes");
  await expect(rows.nth(0)).toContainText(/next in 2 min|next in 1 min/);
  await expect(rows.nth(0)).toContainText(`for “${intent.text}”`);
  await expect(rows.nth(1)).toContainText("Every 10 minutes (every hour while you are away)");
  await expect(rows.nth(2)).toContainText("Daily at 03:00");
  await expect(rows.nth(2)).toContainText("Paused");
  const requested = fixture.requests.filter((r) => r.path === "/api/portal/jobs" && r.method === "GET");
  expect(requested.length).toBeGreaterThanOrEqual(2);

  const runs = view.getByRole("list", { name: "Recent runs" }).getByRole("listitem");
  await expect(runs.nth(0)).toContainText(helperJob.title);
  await expect(runs.nth(0)).toContainText("Succeeded");
  await expect(runs.nth(0)).toContainText("anthropic · claude-haiku-4-5");
  await expect(runs.nth(0)).toContainText("1.2k in · 80 out");
  await expect(runs.nth(0)).toContainText("12 s");
  await expect(runs.nth(1)).toContainText("Failed");
  await expect(runs.nth(1)).toContainText("GitHub rate limit reached.");
  await expect(runs.nth(1)).toContainText("5.4k in · 220 out · 4k cached");
  await page.screenshot({ animations: "disabled", fullPage: true, path: info.outputPath("watches.png") });
});

test("jobs pause, resume, run now, and cancel; watches cancel after a confirm", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: portal() });
  await page.goto("/watches");
  const view = page.getByRole("region", { name: "Watches" });
  const row = view.getByRole("listitem", { name: intentJob.title, exact: true });

  await row.getByRole("button", { name: `Pause ${intentJob.title}` }).click();
  await expect(row.getByText("Paused", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: `Resume ${intentJob.title}` }).click();
  await expect(row.getByRole("button", { name: `Pause ${intentJob.title}` })).toBeVisible();
  await row.getByRole("button", { name: `Run ${intentJob.title} now` }).click();
  await expect(row.getByRole("status")).toHaveText("Started");
  const patches = fixture.requests.filter((r) => r.path === `/api/portal/jobs/${intentJob.id}` && r.method === "PATCH");
  expect(patches.map((r) => r.body)).toEqual([{ status: "paused" }, { status: "active" }]);
  expect(fixture.requests.some((r) => r.path === `/api/portal/jobs/${intentJob.id}/run` && r.method === "POST")).toBe(true);

  await row.getByRole("button", { name: "Cancel" }).click();
  await row.getByRole("button", { name: "Confirm cancel" }).click();
  await expect(view.getByRole("listitem", { name: intentJob.title, exact: true })).toHaveCount(0);

  const card = view.getByRole("article", { name: intent.text });
  await card.getByRole("button", { name: "Cancel watch" }).click();
  await card.getByRole("button", { name: "Confirm cancel" }).click();
  await expect(card).toHaveCount(0);
  expect(fixture.requests.find((r) => r.path === `/api/portal/intents/${intent.id}`)?.body).toEqual({ status: "cancelled" });
});

test("run events update the recent runs live and jobs events refetch the schedule", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: portal() });
  await page.goto("/watches");
  const view = page.getByRole("region", { name: "Watches" });
  await expect(view.getByRole("listitem", { name: /^Run:/ })).toHaveCount(2);
  const started = { ...helperRun, id: "run-live", status: "running" as const, finishedAt: null, usage: null, summary: "Reading review comments" };
  await emitPortal(page, { type: "run", run: started });
  await expect(view.getByRole("listitem", { name: /^Run:/ })).toHaveCount(3);
  await expect(view.getByRole("listitem", { name: /^Run:/ }).first()).toContainText("Running");
  await emitPortal(page, { type: "run", run: { ...started, status: "succeeded", finishedAt: Date.now(), usage: { inputTokens: 900, outputTokens: 40 } } });
  await expect(view.getByRole("listitem", { name: /^Run:/ })).toHaveCount(3);
  await expect(view.getByRole("listitem", { name: /^Run:/ }).first()).toContainText("900 in · 40 out");

  const before = fixture.requests.filter((r) => r.path === "/api/portal/jobs").length;
  fixture.orchestrator.jobs.push({ ...intentJob, id: "j-new", title: "Summarize the review", nextRunAt: Date.now() + 30_000 });
  await emitPortal(page, { type: "jobs" });
  await expect(view.getByRole("listitem", { name: "Summarize the review" })).toBeVisible();
  expect(fixture.requests.filter((r) => r.path === "/api/portal/jobs").length).toBeGreaterThan(before);
});

test("empty Watches explains itself", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/watches");
  const view = page.getByRole("region", { name: "Watches" });
  await expect(view.getByText(/No standing watches/)).toBeVisible();
  await expect(view.getByText("Nothing is scheduled.")).toBeVisible();
  await expect(view.getByText("Portal has not run anything yet.")).toBeVisible();
});

const closedIntents: Intent[] = [
  { ...intent, id: "in-done", text: "Tell me when #38 merges", status: "done", fires: 1, lastFiredAt: Date.now() - 3_600_000, expiresAt: null },
  { ...intent, id: "in-cancelled", text: "Watch the nightly build", status: "cancelled", expiresAt: null },
  { ...intent, id: "in-expired", text: "Ping me if #30 gets a review", status: "expired", expiresAt: Date.now() - 86_400_000 },
];

test("Closed lists the ended watches with their end state, and Re-activate brings one back", async ({ page }, info) => {
  const fixture = await setupPortal(page, { portal: { ...portal(), closedIntents } });
  await page.goto("/watches");
  const view = page.getByRole("region", { name: "Watches" });
  const which = view.getByRole("group", { name: "Which watches" });
  await expect(which.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "true");
  await expect(which.getByRole("button", { name: "Closed" })).toHaveAttribute("aria-pressed", "false");
  await expect(view.getByRole("article")).toHaveText([new RegExp(intent.text)]);
  await expect(view.getByRole("article", { name: intent.text }).getByRole("button", { name: "Cancel watch" })).toBeVisible();

  await which.getByRole("button", { name: "Closed" }).click();
  await expect(which.getByRole("button", { name: "Closed" })).toHaveAttribute("aria-pressed", "true");
  await expect(which.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "false");
  const listed = fixture.requests.filter((r) => r.path === "/api/portal/intents" && r.method === "GET");
  expect(listed).toHaveLength(1);
  await expect(view.getByRole("article")).toHaveCount(3);
  await expect(view.getByRole("article", { name: intent.text })).toHaveCount(0);
  for (const [row, label] of [
    [closedIntents[0], "Done"],
    [closedIntents[1], "Cancelled"],
    [closedIntents[2], "Expired"],
  ] as const) {
    const card = view.getByRole("article", { name: row.text });
    await expect(card.getByText(label, { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Re-activate" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Cancel watch" })).toHaveCount(0);
  }
  await page.screenshot({ animations: "disabled", fullPage: true, path: info.outputPath("watches-closed.png") });

  await view.getByRole("article", { name: closedIntents[0].text }).getByRole("button", { name: "Re-activate" }).click();
  await expect(view.getByRole("article", { name: closedIntents[0].text })).toHaveCount(0);
  await expect(view.getByRole("article")).toHaveCount(2);
  const patch = fixture.requests.find((r) => r.path === `/api/portal/intents/${closedIntents[0].id}` && r.method === "PATCH");
  expect(patch?.body).toEqual({ status: "active" });

  // Back on Active, the re-activated watch is listed with the one that was there.
  await which.getByRole("button", { name: "Active" }).click();
  await expect(view.getByRole("article", { name: closedIntents[0].text })).toBeVisible();
  await expect(view.getByRole("article", { name: intent.text })).toBeVisible();
});

test("Closed with nothing ended says so", async ({ page }) => {
  await setupPortal(page, { portal: portal() });
  await page.goto("/watches");
  const view = page.getByRole("region", { name: "Watches" });
  await view.getByRole("group", { name: "Which watches" }).getByRole("button", { name: "Closed" }).click();
  await expect(view.getByText("No watch has closed yet.")).toBeVisible();
});

test("the sidebar's Watches count and the list follow the stream", async ({ page }) => {
  await setupPortal(page, { portal: portal() });
  await page.goto("/watches");
  const view = page.getByRole("region", { name: "Watches" });
  const entry = page
    .getByRole("complementary", { name: "Workspace sidebar" })
    .getByRole("navigation", { name: "Portal", exact: true })
    .getByRole("button", { name: "Watches", exact: true });
  await expect(entry).toHaveText(/^Watches\s*1$/);
  const added: Intent = { ...intent, id: "in2", text: "Tell me when #43 gets a review" };
  // The server follows an `intents` event with a fresh status, whose counts the sidebar shows.
  await emitPortal(page, { type: "intents", intents: [intent, added] });
  await emitPortal(page, { type: "status", status: { ...portalStatus, counts: { ...portalStatus.counts, intents: 2 } } });
  await expect(view.getByRole("article")).toHaveCount(2);
  await expect(view.getByRole("heading", { level: 2, name: /^Watches/ })).toHaveText(/^Watches\s*2$/);
  await expect(entry).toHaveText(/^Watches\s*2$/);
});
