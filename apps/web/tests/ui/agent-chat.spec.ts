import { expect, test, type Page } from "@playwright/test";
import { emitPortal, portalStatus, setupPortal } from "./fixtures";

const agent = (page: Page) => page.getByRole("main", { name: "Agent", exact: true });
const open = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(agent(page).getByRole("textbox", { name: "Message Portal", exact: true })).toBeEnabled();
};

test("Search and Agent each fill a sidebar row with their own shortcut", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  const search = sidebar.getByRole("button", { name: "Search", exact: true });
  const bot = sidebar.getByRole("button", { name: "Agent", exact: true });
  await expect(search.locator("kbd")).toHaveText("/");
  await expect(bot.locator("kbd")).toHaveText(/⌘K|Ctrl K/);
  const a = (await search.boundingBox())!;
  const b = (await bot.boundingBox())!;
  expect(a.x).toBe(b.x);
  expect(a.width).toBe(b.width);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
});

test("the main composer queues, edits, removes and restores follow-ups on Stop", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: { status: { busy: true } } });
  await open(page);
  const composer = agent(page).getByRole("textbox", { name: "Message Portal", exact: true });
  await expect(agent(page).getByRole("button", { name: "Queue message", exact: true })).toBeVisible();
  await composer.fill("run the tests next");
  await composer.press("Enter");
  const queue = agent(page).getByRole("region", { name: "Queued prompts" });
  await expect(queue).toContainText("run the tests next");
  await expect(composer).toHaveValue("");
  await composer.fill("then summarize");
  await composer.press("Enter");
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await queue.getByRole("button", { name: "Edit queued prompt 1" }).click();
  await expect(composer).toHaveValue("run the tests next");
  await expect(queue).toContainText("paused while a prompt is edited");
  await composer.fill("run all checks next");
  await agent(page).getByRole("button", { name: "Save queued prompt", exact: true }).click();
  await expect(queue.getByRole("listitem").first()).toContainText("run all checks next");
  await expect(queue).not.toContainText("paused");
  await queue.getByRole("button", { name: "Remove queued prompt 2" }).click();
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await composer.fill("draft in progress");
  await agent(page).getByRole("button", { name: "Stop agent" }).click();
  await expect(composer).toHaveValue("run all checks next\ndraft in progress");
  await expect(queue).toBeHidden();
  expect(fixture.requests.filter((request) => request.path === "/api/portal/messages" && request.method === "POST")).toHaveLength(0);
});

test("tool-first streaming shows jumping dots until text arrives, and tools separate text bubbles", async ({ page }) => {
  await setupPortal(page, { portal: { messages: [] } });
  await open(page);
  await emitPortal(page, { type: "status", status: { ...portalStatus, busy: true } });
  const dots = agent(page).getByRole("status", { name: "Agent is typing" });
  await expect(dots).toBeVisible();
  await expect(dots.locator("span")).toHaveCount(3);
  expect(await dots.locator("span").first().evaluate((node) => getComputedStyle(node).animationName)).toBe("agent-typing-dot");
  const tool = { type: "tool-list_sessions" as const, toolCallId: "call-1", state: "output-available" as const, input: {}, output: { sessions: [] } };
  const message = { id: "live-reply", role: "assistant" as const, parts: [tool] };
  await emitPortal(page, { type: "chat-message", message });
  await expect(agent(page).locator("[data-agent-bubble]")).toHaveCount(0);
  await expect(dots).toBeVisible();
  await expect(agent(page).getByRole("button", { name: /Ran list_sessions/ })).toBeHidden();
  await emitPortal(page, { type: "chat-message", message: { ...message, parts: [tool, { type: "text", text: "I found your session." }] } });
  await expect(dots).toBeHidden();
  await expect(agent(page).locator("[data-agent-bubble]")).toHaveCount(1);
  await emitPortal(page, { type: "chat-message", message: { ...message, parts: [tool, { type: "text", text: "I found your session." }, { ...tool, toolCallId: "call-2" }, { type: "text", text: "The checks are passing." }, { type: "reasoning", text: "Reviewing the results.", state: "done" }] } });
  await expect(agent(page).locator("[data-agent-bubble]")).toHaveCount(2);
  await expect(dots).toBeHidden();
  await expect(agent(page).getByText("Thinking…", { exact: true })).toHaveCount(0);
  await agent(page).getByRole("button", { name: "Activity", exact: true }).click();
  await expect(agent(page).getByRole("button", { name: /Ran list_sessions/ })).toHaveCount(2);
  await expect(agent(page).getByRole("button", { name: "Reasoning", exact: true })).toBeVisible();
});

test("a slow history read cannot replace newer queued streaming text", async ({ page }) => {
  await setupPortal(page, { portal: { messages: [] } });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/portal/messages", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await held;
    return route.fulfill({ json: { messages: [], hasMore: false, before: null, after: null } });
  });
  await open(page);
  await emitPortal(page, { type: "status", status: { ...portalStatus, busy: true } });
  await emitPortal(page, { type: "chat-message", message: { id: "streamed", role: "assistant", parts: [{ type: "text", text: "A newer streamed reply." }] } });
  await expect(agent(page).getByText("A newer streamed reply.", { exact: true })).toBeVisible();
  release();
  await expect(agent(page).getByText("Opening the conversation…", { exact: true })).toBeHidden();
  await expect(agent(page).getByText("A newer streamed reply.", { exact: true })).toBeVisible();
});

test("all page overlays share the fade and translucent surface", async ({ page }) => {
  await setupPortal(page);
  await open(page);
  for (const name of ["Agent", "Watches", "Activity", "Memory", "System", "Terminal"]) {
    if (name !== "Agent") await page.getByRole("navigation", { name: "Portal", exact: true }).getByRole("button", { name, exact: true }).click();
    const overlay = page.locator("[data-page-overlay]");
    await expect(overlay).toBeVisible();
    const style = await overlay.evaluate((node) => ({ animation: getComputedStyle(node).animationName, background: getComputedStyle(node).backgroundColor }));
    expect(style.animation).toBe("page-overlay-in");
    expect(style.background).toContain("0.88");
  }
});
