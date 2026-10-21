import { expect, test, type Page } from "@playwright/test";
import { emitPortal, firstTitle, portalItem, portalStatus, setupPortal, thirdTitle } from "./fixtures";
import { approval, globalEntity, helperJob, intent, intentJob, mainThread, memoryRecords, repoEntity, reviewThread } from "./orchestrator-fixtures";
import { pane, split, tab, workspaceOf } from "./workspace-fixtures";

test.use({ viewport: { width: 390, height: 844 } });

test("Agent and Search stay at the top of the phone sidebar, with Settings at the foot", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  const sidebar = page.getByRole("dialog", { name: "Your workspace" });
  await expect(sidebar.getByRole("button", { name: "Settings", exact: true })).toBeInViewport();
  await expect(sidebar.getByRole("button", { name: "Search", exact: true })).toBeInViewport();
  await expect(sidebar.getByRole("button", { name: /^Agent/ })).toBeInViewport();
  await expect(sidebar.getByRole("group", { name: "Room mode" })).toHaveCount(0);
  await expect(page.locator(".room-scene")).toHaveAttribute("data-scene", /^(day|night)$/);
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
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("dialog", { name: "Your workspace" }).getByRole("button", { name: /^Agent/ }).click();
  await expect(page.getByRole("main", { name: "Agent", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Threads" })).toBeVisible();
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noHorizontalScroll()).toBe(true);
  await page.screenshot({ animations: "disabled", path: info.outputPath("mobile-chat.png") });
  await page.keyboard.press("Escape");

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

  test("a page covers the pane bar and closing it reveals the same mobile pane and draft", async ({ page }) => {
    await setupPortal(page, { workspace: threePanes() });
    await page.goto("/tabs/t1");
    const bar = page.getByRole("group", { name: "Panes" });
    const input = page.getByRole("combobox", { name: "Message Claude Code" });
    await input.fill("A draft beneath the page");
    await expect(bar).toBeVisible();
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await page.getByRole("dialog", { name: "Your workspace" }).getByRole("navigation", { name: "Portal", exact: true }).getByRole("button", { name: "Watches", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Watches", level: 1 })).toBeVisible();
    await expect(bar).toBeHidden();
    await expect(input).toBeHidden();
    await expect(page).toHaveURL("/tabs/t1");
    await page.getByRole("button", { name: "Close page", exact: true }).click();
    await expect(bar).toBeVisible();
    await expect(bar.locator("[data-pane-counter]")).toHaveText("1 of 3");
    await expect(input).toHaveValue("A draft beneath the page");
    await expect(page).toHaveURL("/tabs/t1");
  });

  test("the pane bar counts the flat list; a swipe switches panes; the sheet lists, closes and opens them", async ({ page }) => {
    const fixture = await setupPortal(page, { workspace: threePanes() });
    await page.goto("/tabs/t1");
    const bar = page.getByRole("group", { name: "Panes" });
    const counter = bar.locator("[data-pane-counter]");
    await expect(bar).toBeVisible();
    await expect(counter).toHaveText("1 of 3");
    // No strip and no splits on a phone: one pane at a time.
    await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toHaveCount(0);
    await expect(page.locator("[data-pane]")).toHaveCount(1);

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
    await expect(page).toHaveURL(/\/tabs\/t2\?pane=p2$/);
    await expect(counter).toHaveText("2 of 3");
    await expect(page.locator('[data-pane="p2"]')).toBeVisible();
    await expect(page.locator('[data-pane="p1"]')).toHaveCount(0);
    await swipe(box.x + box.width * 0.8, box.x + box.width * 0.2);
    await expect(counter).toHaveText("3 of 3");
    await expect(page).toHaveURL(/\/tabs\/t2\?pane=p3$/);
    // The last pane has no next: another swipe stays.
    await swipe(box.x + box.width * 0.8, box.x + box.width * 0.2);
    await expect(counter).toHaveText("3 of 3");
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

  test("the bar's panes button opens the sheet too", async ({ page }) => {
    await setupPortal(page, { workspace: threePanes() });
    await page.goto("/tabs/t1");
    await page.getByRole("group", { name: "Panes" }).getByRole("button", { name: "Panes", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Panes" }).locator("[data-pane-row]")).toHaveCount(3);
  });
});

test.describe("Agent from the phone's bar", () => {
  const onePane = () => workspaceOf([tab("t1", pane("p1", "s1"))]);
  const threads = [mainThread, reviewThread];
  const agentButton = (page: Page) => page.getByRole("group", { name: "Panes" }).locator("[data-agent-button]");
  const agentSheet = (page: Page) => page.getByRole("main", { name: "Agent", exact: true });

  test("the Agent button opens a full overlay and closing it restores the pane bar", async ({ page }, info) => {
    await setupPortal(page, { workspace: onePane() });
    await page.goto("/tabs/t1");
    await agentButton(page).click();
    await expect(agentSheet(page)).toBeVisible();
    expect(await agentSheet(page).boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await expect(agentSheet(page).locator("[data-agent-grip]")).toHaveCount(0);
    await expect(agentButton(page)).toBeHidden();
    await page.screenshot({ path: info.outputPath("agent-overlay.png") });
    await agentSheet(page).getByRole("button", { name: "Close Agent" }).click();
    await expect(agentSheet(page)).toHaveCount(0);
    await expect(agentButton(page)).toBeVisible();
    await agentButton(page).click();
    await expect(agentSheet(page)).toBeVisible();
  });

  test("a reply while Agent is closed marks the button and floats a preview above the composer; tapping it opens that thread", async ({ page }, info) => {
    const fixture = await setupPortal(page, { workspace: onePane(), portal: { threads } });
    await page.goto("/tabs/t1");
    await expect(agentButton(page)).toHaveAccessibleName("Agent");
    fixture.appendPortalMessage(
      { id: "rt9", role: "assistant", metadata: { at: Date.now() }, parts: [{ type: "text", text: "The **review** finished with two findings." }] },
      reviewThread.id,
    );
    await emitPortal(page, { type: "messages", threadId: reviewThread.id });
    await expect(agentButton(page)).toHaveAccessibleName("Agent, new messages");
    const preview = page.locator("[data-agent-reply-preview]");
    await expect(preview).toContainText(`Portal in ${reviewThread.title}: The review finished with two findings.`);
    // Above the composer, clear of it.
    const composer = (await page.locator(".composer-wrap").boundingBox())!;
    const box = (await preview.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
    await page.screenshot({ path: info.outputPath("agent-reply-preview.png") });

    await preview.getByRole("button", { name: /Portal in/ }).click();
    await expect(agentSheet(page)).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Threads" }).getByRole("tab", { name: reviewThread.title })).toHaveAttribute("aria-selected", "true");
    await expect(preview).toHaveCount(0);
    await agentSheet(page).getByRole("button", { name: "Close Agent" }).click();
    await expect(agentButton(page)).toHaveAccessibleName("Agent");
  });

  test("the preview's cross dismisses it, and a reply in the open thread shows none", async ({ page }) => {
    const fixture = await setupPortal(page, { workspace: onePane() });
    await page.goto("/tabs/t1");
    // Wait for the live provider to mount before delivering an event through its stream.
    await expect.poll(() => fixture.requests.some((request) => request.path === "/api/portal")).toBe(true);
    fixture.appendPortalMessage({ id: "m9", role: "assistant", metadata: { at: Date.now() }, parts: [{ type: "text", text: "Nothing needs you right now." }] });
    await emitPortal(page, { type: "messages", threadId: "main" });
    const preview = page.locator("[data-agent-reply-preview]");
    await expect(preview).toContainText("Portal replied: Nothing needs you right now.");
    await preview.getByRole("button", { name: "Dismiss" }).click();
    await expect(preview).toHaveCount(0);
    // Still unread until Agent is opened.
    await expect(agentButton(page)).toHaveAccessibleName("Agent, new messages");
    await agentButton(page).click();
    await expect(agentSheet(page)).toBeVisible();
    await emitPortal(page, { type: "messages", threadId: "main" });
    await page.waitForTimeout(300);
    await expect(preview).toHaveCount(0);
  });

  test("the button shows Portal working and an approval waiting", async ({ page }) => {
    await setupPortal(page, { workspace: onePane() });
    await page.goto("/tabs/t1");
    // The shell (and its stream) is up once the bar is.
    await expect(agentButton(page)).toHaveAccessibleName("Agent");
    await emitPortal(page, { type: "status", status: { ...portalStatus, busyThreads: ["main"] } });
    await expect(agentButton(page)).toHaveAttribute("data-agent-activity", "working");
    await expect(agentButton(page)).toHaveAccessibleName("Agent, working");
    await emitPortal(page, { type: "approvals", approvals: [approval] });
    // (The approvals dialog is modal and hides the bar from role queries; the attribute still reads.)
    await expect(page.locator("[data-pane-bar] [data-agent-button]")).toHaveAttribute("data-agent-activity", "waiting");
  });

  test("an empty workspace keeps the bar for Agent, with no counter or sheet", async ({ page }) => {
    await setupPortal(page, { workspace: workspaceOf([]) });
    await page.goto("/new");
    const bar = page.getByRole("group", { name: "Panes" });
    await expect(bar.locator("[data-agent-button]")).toBeVisible();
    await expect(bar.locator("[data-pane-counter]")).toHaveCount(0);
    await expect(bar.locator("[data-pane-bar-title]")).toBeDisabled();
    await bar.locator("[data-agent-button]").click();
    await expect(page.getByRole("main", { name: "Agent", exact: true })).toBeVisible();
  });
});
