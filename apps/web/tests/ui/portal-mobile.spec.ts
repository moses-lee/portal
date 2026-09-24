import { expect, test } from "@playwright/test";
import { setupPortal } from "./fixtures";
import { approval, globalEntity, intent, intentJob, mainThread, memoryRecords, repoEntity, reviewThread, tickJob } from "./orchestrator-fixtures";

test.use({ viewport: { width: 390, height: 844 } });

test("on a phone the views, the memory browser, and the approvals dialog fit the screen", async ({ page }, info) => {
  await setupPortal(page, {
    portal: {
      threads: [mainThread, reviewThread],
      intents: [intent],
      jobs: [tickJob, intentJob],
      entities: [globalEntity, repoEntity],
      records: memoryRecords,
    },
  });
  await page.goto("/");
  // The sidebar is a sheet on a phone: open it for each move, it closes itself on the way.
  const go = async (view: string) => {
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    const nav = page.getByRole("dialog").getByRole("navigation", { name: "Portal", exact: true });
    await expect(nav).toBeVisible();
    await nav.getByRole("button", { name: view, exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Your workspace" })).toHaveCount(0);
  };
  await expect(page.getByRole("heading", { name: "Talk to Portal" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Threads" })).toBeVisible();
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noHorizontalScroll()).toBe(true);
  await page.screenshot({ animations: "disabled", path: info.outputPath("mobile-chat.png") });

  await go("Goals");
  await expect(page.getByRole("listitem", { name: intentJob.title })).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
  await page.screenshot({ animations: "disabled", path: info.outputPath("mobile-goals.png") });

  // Memory: the list first, then one entity with a way back.
  await go("Memory");
  await page.getByRole("navigation", { name: "Memory" }).getByRole("button", { name: /example\/portal/ }).click();
  await expect(page.getByRole("heading", { name: "example/portal" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Memory" })).toHaveCount(0);
  await page.getByRole("region", { name: "Memory browser" }).getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Memory" })).toBeVisible();

  await page.evaluate((approval) => window.__portalEmit("/api/portal/stream", { type: "approvals", approvals: [approval] }, "message"), approval);
  const dialog = page.getByRole("dialog", { name: approval.title });
  await expect(dialog.getByRole("button", { name: "Approve once" })).toBeInViewport();
  await page.screenshot({ animations: "disabled", path: info.outputPath("mobile-approval.png") });
});
