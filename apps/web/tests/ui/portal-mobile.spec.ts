import { expect, test } from "@playwright/test";
import { firstTitle, portalItem, setupPortal, thirdTitle } from "./fixtures";
import { approval, globalEntity, helperJob, intent, intentJob, mainThread, memoryRecords, repoEntity, reviewThread } from "./orchestrator-fixtures";
import { pane, split, tab, workspaceOf } from "./workspace-fixtures";

test.use({ viewport: { width: 390, height: 844 } });

test("room mode remains usable above Settings in the phone sidebar", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  const sidebar = page.getByRole("dialog", { name: "Your workspace" });
  const mode = sidebar.getByRole("group", { name: "Room mode" });
  await expect(mode).toBeInViewport();
  await expect(sidebar.getByRole("button", { name: "Settings", exact: true })).toBeInViewport();
  await mode.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator(".room-scene")).toHaveAttribute("data-scene", "study");
});

test("on a phone the views, the memory browser, and the approvals dialog fit the screen", async ({ page }, info) => {
  await setupPortal(page, {
    portal: {
      threads: [mainThread, reviewThread],
      intents: [intent],
      jobs: [helperJob, intentJob],
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

  // The Needs-you page has no entry: the foyer card in the sheet opens it.
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Needs your attention|All caught up|Work in progress/ }).click();
  await expect(page.getByRole("dialog", { name: "Your workspace" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Needs your attention" }).getByRole("article", { name: portalItem.title })).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
  await page.screenshot({ animations: "disabled", path: info.outputPath("mobile-attention.png") });

  await go("Watches");
  await expect(page.getByRole("listitem", { name: intentJob.title })).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
  await page.screenshot({ animations: "disabled", path: info.outputPath("mobile-watches.png") });

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

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the return key types a new line and only the button sends", async ({ page }) => {
    const fixture = await setupPortal(page);
    await page.goto("/sessions/s1");
    const input = page.getByRole("combobox", { name: "Message Claude Code" });
    await expect(input).toHaveAttribute("enterkeyhint", "enter");
    await expect(page.getByText("Enter to send")).toHaveCount(0);
    await input.fill("first line");
    await input.press("Enter");
    await input.pressSequentially("second line");
    await expect(input).toHaveValue("first line\nsecond line");
    const prompts = () => fixture.requests.filter((request) => request.path.endsWith("/prompt"));
    expect(prompts()).toHaveLength(0);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => prompts().length).toBe(1);
  });
});

test.describe("the workspace on a phone", () => {
  /** One tab of its own, then a split of two: three panes flat (docs/WORKSPACE.md, decision 18). */
  const threePanes = () => workspaceOf([tab("t1", pane("p1", "s1")), tab("t2", split("x1", "row", [pane("p2", "s2"), pane("p3", "s3")]))]);

  test("the pane bar counts the flat list; chevrons and a swipe switch panes; the sheet lists, closes and opens them", async ({ page }) => {
    const fixture = await setupPortal(page, { workspace: threePanes() });
    await page.goto("/tabs/t1");
    const bar = page.getByRole("group", { name: "Panes" });
    const counter = bar.locator("[data-pane-counter]");
    await expect(bar).toBeVisible();
    await expect(counter).toHaveText("1 of 3");
    await expect(bar.getByRole("button", { name: "Previous pane" })).toBeDisabled();
    // No strip and no splits on a phone: one pane at a time.
    await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toHaveCount(0);
    await expect(page.locator("[data-pane]")).toHaveCount(1);
    await bar.getByRole("button", { name: "Next pane" }).click();
    await expect(page).toHaveURL(/\/tabs\/t2\?pane=p2$/);
    await expect(counter).toHaveText("2 of 3");
    await expect(page.locator('[data-pane="p2"]')).toBeVisible();
    await expect(page.locator('[data-pane="p1"]')).toHaveCount(0);

    // A swipe to the left on the bar pulls the next pane in; a swipe is not a tap, so no sheet.
    const title = bar.locator("[data-pane-bar-title]");
    const box = (await title.boundingBox())!;
    const y = box.y + box.height / 2;
    const swipe = async (from: number, to: number) => {
      await page.mouse.move(from, y);
      await page.mouse.down();
      await page.mouse.move(to, y, { steps: 8 });
      await page.mouse.up();
    };
    await swipe(box.x + box.width * 0.8, box.x + box.width * 0.2);
    await expect(counter).toHaveText("3 of 3");
    await expect(page).toHaveURL(/\/tabs\/t2\?pane=p3$/);
    await expect(bar.getByRole("button", { name: "Next pane" })).toBeDisabled();
    await expect(page.getByRole("dialog", { name: "Panes" })).toHaveCount(0);
    // And back to the right.
    await swipe(box.x + box.width * 0.2, box.x + box.width * 0.8);
    await expect(counter).toHaveText("2 of 3");
    await expect(page).toHaveURL(/\/tabs\/t2\?pane=p2$/);

    // A tap on the title opens the sheet: every pane in order, the current one marked.
    await title.click();
    const sheet = page.getByRole("dialog", { name: "Panes" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("[data-pane-row]")).toHaveCount(3);
    await expect(sheet.locator("[data-pane-row][data-current]")).toHaveAttribute("data-pane-row", "p2");
    // Closing a pane from the sheet removes it from its split, for every device (decision 19).
    await sheet.getByRole("button", { name: `Close pane ${thirdTitle}` }).click();
    await expect(sheet.locator("[data-pane-row]")).toHaveCount(2);
    // (The modal sheet hides the bar from role queries while it is open; the attribute still reads.)
    await expect(page.locator("[data-pane-bar] [data-pane-counter]")).toHaveText("2 of 2");
    expect(fixture.requests.filter((request) => request.path === "/api/workspace/ops").map((request) => request.body)).toEqual([
      { op: "close_pane", paneId: "p3" },
    ]);
    // Tapping a row shows that pane and closes the sheet.
    // The row's own button (its close button carries the title too).
    await sheet.locator('[data-pane-row="p1"]').getByRole("button", { name: firstTitle }).first().click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/\/tabs\/t1$/);
    await expect(counter).toHaveText("1 of 2");
    await expect(page.locator('[data-pane="p1"]')).toBeVisible();
  });

  test("the pane bar hides while the on-screen keyboard is up", async ({ page }) => {
    await setupPortal(page, { workspace: threePanes() });
    await page.goto("/tabs/t1");
    const bar = page.getByRole("group", { name: "Panes" });
    await expect(bar).toBeVisible();
    // The keyboard: the visual viewport loses more than 150 px of height at the same width.
    await page.setViewportSize({ width: 390, height: 500 });
    await expect(bar).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(bar).toBeVisible();
  });
});
