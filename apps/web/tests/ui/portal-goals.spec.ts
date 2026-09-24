import { expect, test } from "@playwright/test";
import { emitPortal, setupPortal } from "./fixtures";
import { failedRun, intent, intentJob, mainThread, nightlyJob, reviewThread, tickJob, tickRun } from "./orchestrator-fixtures";

const portal = () => ({
  threads: [mainThread, reviewThread],
  intents: [intent],
  jobs: [tickJob, intentJob, nightlyJob],
  runs: [tickRun, failedRun],
  status: { counts: { needsYou: 1, inbox: 0, approvals: 0, intents: 1 } },
});

test("Goals lists the active intents, upcoming jobs by next run, and recent runs", async ({ page }, info) => {
  const fixture = await setupPortal(page, { portal: portal() });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Portal", exact: true }).getByRole("button", { name: "Goals", exact: true }).click();
  await expect(page).toHaveURL(/\/goals$/);
  const view = page.getByRole("region", { name: "Goals" });

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
  await expect(runs.nth(0)).toContainText("Check for changes");
  await expect(runs.nth(0)).toContainText("Succeeded");
  await expect(runs.nth(0)).toContainText("anthropic · claude-haiku-4-5");
  await expect(runs.nth(0)).toContainText("1.2k in · 80 out");
  await expect(runs.nth(0)).toContainText("12 s");
  await expect(runs.nth(1)).toContainText("Failed");
  await expect(runs.nth(1)).toContainText("GitHub rate limit reached.");
  await expect(runs.nth(1)).toContainText("5.4k in · 220 out · 4k cached");
  await page.screenshot({ animations: "disabled", fullPage: true, path: info.outputPath("goals.png") });
});

test("jobs pause, resume, run now, and cancel; intents cancel after a confirm", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: portal() });
  await page.goto("/goals");
  const view = page.getByRole("region", { name: "Goals" });
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
  await card.getByRole("button", { name: "Cancel goal" }).click();
  await card.getByRole("button", { name: "Confirm cancel" }).click();
  await expect(card).toHaveCount(0);
  expect(fixture.requests.find((r) => r.path === `/api/portal/intents/${intent.id}`)?.body).toEqual({ status: "cancelled" });
});

test("run events update the recent runs live and jobs events refetch the schedule", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: portal() });
  await page.goto("/goals");
  const view = page.getByRole("region", { name: "Goals" });
  await expect(view.getByRole("listitem", { name: /^Run:/ })).toHaveCount(2);
  const started = { ...tickRun, id: "run-live", status: "running" as const, finishedAt: null, usage: null, summary: "Checking for changes" };
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

test("empty Goals explains itself", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/goals");
  const view = page.getByRole("region", { name: "Goals" });
  await expect(view.getByText(/No standing goals/)).toBeVisible();
  await expect(view.getByText("Nothing is scheduled.")).toBeVisible();
  await expect(view.getByText("Portal has not run anything yet.")).toBeVisible();
});
