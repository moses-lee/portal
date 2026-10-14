import { expect, test, type Page } from "@playwright/test";
import { portalMessages, setupPortal, tabUrl } from "./fixtures";
import type { OrchestratorMessage } from "../../src/lib/orchestrator/types";

const agent = (page: Page) => page.getByRole("dialog", { name: "Agent", exact: true });
const composer = (page: Page) => agent(page).getByRole("textbox", { name: "Message Portal", exact: true });
const search = (page: Page) => page.getByRole("dialog", { name: "Search", exact: true });
const hydrated = (page: Page) => expect(page.getByText(/^(⌘K|Ctrl K)$/)).toBeVisible();
const openSearch = async (page: Page) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("/");
};

test("command-K opens Agent over the session, sends its context, and restores composer focus on dismissal", async ({ page }) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  await expect(page).toHaveURL(tabUrl);
  const sessionComposer = page.getByLabel("Message Claude Code", { exact: true });
  await hydrated(page);
  await sessionComposer.click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(agent(page)).toBeVisible();
  await expect(search(page)).toHaveCount(0);
  await expect(agent(page).getByText("Nothing yet. I will keep an eye on your pull requests.")).toBeVisible();
  await expect(composer(page)).toBeFocused();
  await composer(page).fill("What is this session doing?");
  await composer(page).press("Enter");
  await expect(agent(page).getByText("Portal reply to: What is this session doing?")).toBeVisible();
  await expect(composer(page)).toHaveValue("");
  const sent = fixture.requests.filter((request) => request.path === "/api/portal/messages" && request.method === "POST");
  expect(sent).toHaveLength(1);
  expect((sent[0].body as { view: { sessionId: string | null } }).view.sessionId).toBe("s1");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(agent(page)).toHaveCount(0);
  await expect(sessionComposer).toBeFocused();
  await expect(sessionComposer).toHaveValue("");
});

test("Search and Agent are independent dialogs and Agent preserves its draft after dismissal", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  await hydrated(page);
  await openSearch(page);
  await expect(search(page).getByRole("combobox", { name: "Search" })).toBeFocused();
  await expect(search(page).getByRole("tablist")).toHaveCount(0);
  await search(page).getByRole("combobox", { name: "Search" }).fill("chat");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(agent(page)).toBeVisible();
  await expect(search(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await composer(page).fill("half a thought");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(agent(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(composer(page)).toHaveValue("half a thought");
  await expect(composer(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(agent(page)).toHaveCount(0);
  await openSearch(page);
  await expect(search(page).getByRole("combobox", { name: "Search" })).toHaveValue("");
});

test("a reply continues while Agent is dismissed and is available on reopening", async ({ page }) => {
  const fixture = await setupPortal(page);
  const release = fixture.holdSends("main");
  await page.goto("/");
  await hydrated(page);
  await page.keyboard.press("ControlOrMeta+k");
  await composer(page).fill("Keep working while I look around");
  await composer(page).press("Enter");
  await expect(agent(page).getByRole("button", { name: "Sending message" })).toBeVisible();
  await agent(page).getByRole("button", { name: "Close Agent" }).click();
  await expect(agent(page)).toHaveCount(0);
  release();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(agent(page).getByText("Portal reply to: Keep working while I look around")).toBeVisible();
  await expect(composer(page)).toHaveValue("");
  expect(fixture.requests.filter((request) => request.path.endsWith("/cancel"))).toHaveLength(0);
});

test("a session link in a reply dismisses Agent and opens the session workspace", async ({ page }) => {
  const linked: OrchestratorMessage = {
    id: "m-link", role: "assistant", metadata: { at: Date.now() - 60_000 },
    parts: [{ type: "text", text: "The [second session](/sessions/s2) is waiting on you." }],
  };
  await setupPortal(page, { portal: { messages: [...portalMessages, linked] } });
  await page.goto("/");
  await hydrated(page);
  await page.keyboard.press("ControlOrMeta+k");
  const link = agent(page).getByRole("link", { name: "second session" });
  await link.focus();
  await link.press("Enter");
  await expect(agent(page)).toHaveCount(0);
  await expect(page).toHaveURL(tabUrl);
  await expect(page.locator('[data-pane][data-session="s2"]')).toBeVisible();
});

test("a page link in a reply opens its overlay without changing the workspace URL", async ({ page }) => {
  const linked: OrchestratorMessage = {
    id: "m-watch", role: "assistant", metadata: { at: Date.now() - 60_000 },
    parts: [{ type: "text", text: "Read [your watches](/watches)." }],
  };
  await setupPortal(page, { portal: { messages: [...portalMessages, linked] } });
  await page.goto("/sessions/s1");
  await expect(page).toHaveURL(tabUrl);
  await hydrated(page);
  await page.keyboard.press("ControlOrMeta+k");
  await agent(page).getByRole("link", { name: "your watches" }).click();
  await expect(agent(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Watches", exact: true })).toBeVisible();
  await expect(page).toHaveURL(tabUrl);
});

test("Agent is centered at sixty percent viewport width and eighty-five percent height", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  await hydrated(page);
  await page.keyboard.press("ControlOrMeta+k");
  const box = await agent(page).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeCloseTo(1440 * 0.6, 0);
  expect(box!.height).toBeCloseTo(960 * 0.85, 0);
  expect(box!.x).toBeCloseTo((1440 - box!.width) / 2, 0);
  expect(box!.y).toBeCloseTo((960 - box!.height) / 2, 0);
});

test("Agent retains conversation scroll and supports wheel scrolling, focus wrapping, and outside dismissal", async ({ page }) => {
  const messages: OrchestratorMessage[] = Array.from({ length: 30 }, (_, index) => ({
    id: `scroll-${index}`,
    role: "assistant",
    metadata: { at: Date.now() - (30 - index) * 60_000 },
    parts: [{ type: "text", text: `History entry ${index}. ${"An update about the project. ".repeat(20)}` }],
  }));
  await setupPortal(page, { portal: { messages } });
  await page.goto("/");
  await hydrated(page);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(composer(page)).toBeFocused();
  const viewport = agent(page).getByRole("region", { name: "Talk to Portal", exact: true });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);
  const bottom = await viewport.evaluate((element) => element.scrollTop);
  await viewport.hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(bottom - 200);
  const position = await viewport.evaluate((element) => element.scrollTop);
  await agent(page).getByRole("button", { name: "Close Agent" }).click();
  await expect(agent(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(composer(page)).toBeFocused();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeCloseTo(position, 0);
  await composer(page).fill("Keep this draft");
  const send = agent(page).getByRole("button", { name: "Send message", exact: true });
  const close = agent(page).getByRole("button", { name: "Close Agent" });
  await send.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(send).toBeFocused();
  await page.mouse.click(10, 10);
  await expect(agent(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).toBe("");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("Agent fills the viewport and can be dismissed with its close button", async ({ page }) => {
    await setupPortal(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(agent(page)).toBeVisible();
    const box = await agent(page).boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await agent(page).getByRole("button", { name: "Close Agent" }).click();
    await expect(agent(page)).toHaveCount(0);
  });
});
