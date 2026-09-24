import { expect, test } from "@playwright/test";
import { emitPortal, setupPortal } from "./fixtures";
import { consolidateJob, curationRun, globalEntity, memoryRecords, octoEntity, repoEntity } from "./orchestrator-fixtures";

const portal = () => ({
  entities: [repoEntity, octoEntity, globalEntity],
  records: memoryRecords,
  jobs: [consolidateJob],
  runs: [curationRun],
});

test("curation lists its runs; a run shows its digest and the diff by action", async ({ page }, info) => {
  await setupPortal(page, { portal: portal() });
  await page.goto("/memory");
  await page.getByRole("navigation", { name: "Memory" }).getByRole("button", { name: "Curation" }).click();
  await expect(page).toHaveURL(/\/memory\/curation$/);
  const pane = page.getByRole("region", { name: "Memory browser" });
  await expect(pane.getByRole("heading", { name: "Curation" })).toBeVisible();
  await expect(pane.getByText(/Daily at 03:00|0 3 \* \* \*/)).toBeVisible();
  const runs = pane.getByRole("list", { name: "Curation runs" });
  await expect(runs).toContainText("Memory curation promoted 1, rewrote 1 summary; 1 left in the inbox.");
  await page.screenshot({ animations: "disabled", fullPage: true, path: info.outputPath("curation-runs.png") });

  await runs.getByRole("button").first().click();
  await expect(page).toHaveURL(/\/memory\/curation\/run-c1$/);
  const run = pane.getByRole("region", { name: "Curation run" });
  await expect(run).toContainText("anthropic · claude-opus-5-5");
  await expect(run.getByText("Seen in two PRs.").first()).toBeVisible();
  const promoted = run.getByRole("region", { name: "Promoted (1)" });
  await expect(promoted).toContainText("ci-provider");
  await expect(promoted).toContainText("proposed → active");
  await expect(run.getByRole("region", { name: "Left for you (1)" })).toContainText("Only one session says so.");
  await expect(run.getByRole("region", { name: "Summaries rewritten (1)" })).toContainText("CI on GitHub Actions");
  await page.screenshot({ animations: "disabled", fullPage: true, path: info.outputPath("curation-run.png") });

  // An entity in the diff opens its records.
  await promoted.getByRole("button", { name: "repo example/portal" }).click();
  await expect(page).toHaveURL(/\/memory\/e-repo$/);
});

test("Run now starts a pass and opens it; the run fills in when it ends", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: portal() });
  await page.goto("/memory/curation");
  await page.getByRole("button", { name: "Run now" }).last().click();
  await expect(page).toHaveURL(/\/memory\/curation\/run-curate-now$/);
  expect(fixture.requests.some((r) => r.path === "/api/portal/memory/consolidate" && r.method === "POST")).toBe(true);
  const run = page.getByRole("region", { name: "Curation run" });
  await expect(run.getByText("Curating… the digest appears when the pass ends.")).toBeVisible();
  await emitPortal(page, {
    type: "run",
    run: { ...curationRun, id: "run-curate-now", trigger: "manual", status: "succeeded", startedAt: Date.now() - 20_000, finishedAt: Date.now() },
  });
  await expect(run.getByRole("region", { name: "Promoted (1)" })).toBeVisible();
  await expect(run).toContainText("Run now");
});

test("the digest line in the main thread opens its run", async ({ page }) => {
  await setupPortal(page, {
    portal: {
      ...portal(),
      messages: [
        {
          id: "c1", role: "assistant", metadata: { at: Date.now() - 60_000, run: { id: "run-c1", kind: "consolidate" } },
          parts: [{ type: "text", text: "Memory curation promoted 1, rewrote 1 summary; 1 left in the inbox." }],
        },
      ],
      items: [],
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open the digest and changes" }).click();
  await expect(page).toHaveURL(/\/memory\/curation\/run-c1$/);
  await expect(page.getByRole("region", { name: "Curation run" })).toContainText("Memory curation");
});

test("the re-confirm item opens the Memory view", async ({ page }) => {
  const at = Date.now() - 60_000;
  await setupPortal(page, {
    portal: {
      ...portal(),
      items: [{
        id: "i-reconfirm", kind: "memory_reconfirm", title: "Re-confirm a memory claim of yours", body: "- repo example/portal · `deploy`: Deploys go out on Tuesdays.",
        links: { jobId: "consolidate" }, actions: [], fingerprint: "memory_reconfirm", status: "open", createdAt: at, updatedAt: at, snoozedUntil: null,
      }],
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Re-confirm a memory claim of yours/ }).click();
  await page.getByRole("button", { name: "Open memory" }).click();
  await expect(page).toHaveURL(/\/memory$/);
});

test("settings set when curation runs; an empty trigger turns it off", async ({ page }) => {
  const fixture = await setupPortal(page);
  await page.goto("/");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("portal:open-settings", { detail: { section: "orchestrator" } })));
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const nightly = dialog.getByLabel("Curate every night at");
  const threshold = dialog.getByRole("spinbutton", { name: "Also curate when the inbox holds … proposals" });
  const interval = dialog.getByRole("spinbutton", { name: "At most one inbox-started run every … minutes" });
  await expect(nightly).toHaveValue("03:00");
  await expect(threshold).toHaveValue("10");
  await expect(interval).toHaveValue("60");
  const patches = () => fixture.requests.filter((r) => r.path === "/api/settings" && r.method === "PATCH").map((r) => r.body);

  await threshold.fill("");
  await threshold.press("Tab");
  await expect.poll(() => patches().at(-1)).toEqual({ orchestrator: { consolidation: { inboxThreshold: null } } });
  await interval.fill("0");
  await interval.press("Tab");
  await expect(dialog.getByText("Enter a whole number of minutes between 1 and 1440.")).toBeVisible();
  await interval.fill("90");
  await interval.press("Tab");
  await expect.poll(() => patches().at(-1)).toEqual({ orchestrator: { consolidation: { minIntervalMinutes: 90 } } });
});
