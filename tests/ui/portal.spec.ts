import { expect, test } from "@playwright/test";
import { emit, events, firstTitle, secondTitle, setupPortal } from "./fixtures";
import type { StoredEvent } from "../../src/lib/types";

test("long titles retain space and GitHub loads only when opened", async ({
  page,
}, info) => {
  const fixture = await setupPortal(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/sessions/s1");
  const row = page.getByRole("button", { name: firstTitle, exact: true });
  await expect(row).toBeVisible();
  const title = row.locator(".sidebar-title");
  expect((await title.boundingBox())!.width).toBeGreaterThan(140);
  const titleBox = (await title.boundingBox())!;
  const actionBox = (await page
    .getByRole("button", { name: `Actions for ${firstTitle}`, exact: true })
    .boundingBox())!;
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(actionBox.x);
  await expect(
    page.getByText("A calmer place to work", { exact: true }),
  ).toBeVisible();
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/github")),
  ).toHaveLength(0);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("desktop.png"),
  });
  await page.getByRole("button", { name: "Open GitHub inspector" }).click();
  await expect(
    page.getByRole("link", {
      name: /Improve the chat experience and simplify workspace/,
    }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("inspector.png"),
  });
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/github"))
      .length,
  ).toBeGreaterThan(0);
  await page
    .getByRole("complementary", { name: "GitHub inspector" })
    .getByRole("button", { name: "Close GitHub inspector" })
    .click();
  await expect(
    page.getByRole("complementary", { name: "GitHub inspector" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("drafts survive switching, reload, failed send, and an in-flight edit", async ({
  page,
}) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  const input = page.getByRole("combobox", { name: "Message Claude Code" });
  await input.fill("A draft worth keeping");
  await page.getByRole("button", { name: secondTitle, exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Message Codex" }),
  ).toHaveValue("");
  await page.getByRole("button", { name: firstTitle, exact: true }).click();
  await expect(input).toHaveValue("A draft worth keeping");
  await page.reload();
  await expect(input).toHaveValue("A draft worth keeping");
  fixture.failSend();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Your draft is saved",
  );
  await expect(input).toHaveValue("A draft worth keeping");
  fixture.failSend(false);
  fixture.delaySend(350);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await input.fill("A different follow-up");
  await expect(
    page.getByRole("button", { name: "Sending message" }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("A different follow-up");
});

test("agent settings retain dynamic select groups and booleans", async ({
  page,
}, info) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  await page
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Agent settings" });
  await expect(
    dialog.getByText("How much time the agent spends reasoning."),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("settings.png"),
  });
  await dialog.getByRole("combobox", { name: "Reasoning effort" }).click();
  await page.getByRole("option", { name: "Low", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Reasoning effort" }),
  ).toContainText("Low");
  await dialog.getByRole("switch", { name: "Fast mode" }).click();
  await expect(dialog.getByRole("switch", { name: "Fast mode" })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Agent settings", exact: true }),
  ).toBeFocused();
});

test("new conversation sends the first prompt once and retains a failed first prompt", async ({
  page,
}, info) => {
  const fixture = await setupPortal(page);
  fixture.failSend();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "What would you like to work on?" }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("start.png"),
  });
  await page
    .getByRole("textbox", { name: "First message" })
    .fill("Build a project dashboard");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/created$/);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Your draft is saved",
  );
  await expect(
    page.getByRole("combobox", { name: "Message Claude Code" }),
  ).toHaveValue("Build a project dashboard");
  expect(
    fixture.requests.filter(
      (request) =>
        request.path === "/api/sessions" && request.method === "POST",
    ),
  ).toHaveLength(1);
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/prompt")),
  ).toHaveLength(1);
  fixture.failSend(false);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Message Claude Code" }),
  ).toHaveValue("");
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("mobile navigation traps focus, dismisses with Escape, and avoids overflow", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupPortal(page);
  await page.goto("/sessions/s1");
  await expect(
    page.getByText("A calmer place to work", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile.png"),
  });
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  const dialog = page.getByRole("dialog", { name: "Your workspace" });
  await expect(dialog).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-sidebar.png"),
  });
  await page.keyboard.press("Shift+Tab");
  expect(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Toggle sidebar" }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Agent settings" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});

test("activity colors and controls follow streaming, permission, and cancellation", async ({
  page,
}, info) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  await expect(
    page.getByRole("button", { name: "Agent settings", exact: true }),
  ).toBeVisible();
  await emit(page, { busy: true });
  await expect(page.locator(".aurora")).toHaveAttribute(
    "data-activity",
    "working",
  );
  await expect(page.getByRole("button", { name: "Stop agent" })).toBeVisible();
  await emit(
    page,
    {
      type: "permission_request",
      requestId: "approve-1",
      toolCall: {
        toolCallId: "tool3",
        title: "Run the project test suite before continuing",
        kind: "execute",
        rawInput: { command: "pnpm test" },
      },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    },
    "message",
    100,
  );
  await expect(page.locator(".aurora")).toHaveAttribute(
    "data-activity",
    "waiting",
  );
  await expect(
    page.getByRole("group", { name: /Permission request/ }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("permission.png"),
  });
  await page.getByRole("button", { name: "Allow once" }).click();
  expect(
    fixture.requests.find((request) => request.path.endsWith("/permission"))
      ?.body,
  ).toEqual({ requestId: "approve-1", optionId: "once" });
  await emit(
    page,
    {
      type: "permission_response",
      requestId: "approve-1",
      outcome: "selected",
      optionId: "once",
      optionName: "Allow once",
    },
    "message",
    101,
  );
  await page.getByRole("button", { name: "Stop agent" }).click();
  expect(
    fixture.requests.some((request) => request.path.endsWith("/cancel")),
  ).toBe(true);
  await emit(
    page,
    { type: "turn_end", stopReason: "cancelled" },
    "message",
    102,
  );
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".aurora")).toHaveAttribute(
    "data-activity",
    "idle",
  );
});

test("slash command completion preserves IME and keyboard behavior", async ({
  page,
}) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  const input = page.getByRole("combobox", { name: "Message Claude Code" });
  await input.fill("/rev");
  await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue("/review ");
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/prompt")),
  ).toHaveLength(0);
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("/review \n");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/prompt")),
  ).toHaveLength(0);
});

test("tool details include readable diffs and code copy actions", async ({
  page,
}) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  await page.getByRole("button", { name: "2 tool calls" }).click();
  await page
    .getByRole("button", { name: /Adjust the conversation layout/ })
    .click();
  await expect(
    page.getByText('const width = "840px";', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy code", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Working directory and branch" })
    .click();
  await expect(
    page.getByText("/workspace/portal-worktree", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy branch", exact: true }),
  ).toBeVisible();
});

test("streaming respects reading position and jump to latest restores following", async ({
  page,
}) => {
  const history: StoredEvent[] = Array.from({ length: 12 }, (_, i) =>
    events.map((event) => ({ ...event, seq: i * events.length + event.seq })),
  ).flat();
  await setupPortal(page, { history });
  await page.goto("/sessions/s1");
  const viewport = page.getByRole("region", { name: "Conversation" });
  await expect(
    page.getByRole("button", { name: "Copy response", exact: true }),
  ).toHaveCount(12);
  await expect
    .poll(() =>
      viewport.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(100);
  await viewport.hover();
  await page.mouse.wheel(0, -650);
  await expect(
    page.getByRole("button", { name: "Jump to latest message" }),
  ).toHaveAttribute("data-active", "true");
  const before = await viewport.evaluate((node) => node.scrollTop);
  await emit(
    page,
    {
      type: "update",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "A streamed follow-up that should not pull the reader away. ".repeat(
            20,
          ),
        },
      },
    },
    "message",
    1000,
  );
  await page.waitForTimeout(150);
  expect(
    Math.abs((await viewport.evaluate((node) => node.scrollTop)) - before),
  ).toBeLessThan(5);
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect
    .poll(() =>
      viewport.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(10);
});

test("reduced motion freezes the aurora and sidebar search finds session titles", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setupPortal(page);
  await page.goto("/sessions/s1");
  await expect(
    page.getByRole("button", { name: firstTitle, exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator(".aurora-ribbons")
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).animationName),
      ),
  ).toEqual(["none", "none"]);
  await page
    .getByRole("textbox", { name: "Search sessions" })
    .fill("overlapping");
  await expect(
    page.getByRole("button", { name: secondTitle, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: firstTitle, exact: true }),
  ).toHaveCount(0);
});

test("loading earlier messages preserves the visible conversation", async ({
  page,
}) => {
  const history: StoredEvent[] = Array.from({ length: 6 }, (_, i) =>
    events.map((event) => ({
      ...event,
      seq: 100 + i * events.length + event.seq,
    })),
  ).flat();
  const fixture = await setupPortal(page, {
    history,
    hasMore: true,
    olderDelay: 350,
  });
  await page.goto("/sessions/s1");
  const viewport = page.getByRole("region", { name: "Conversation" });
  await expect(
    page.getByRole("button", { name: "Copy response", exact: true }),
  ).toHaveCount(6);
  await expect
    .poll(() =>
      viewport.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(100);
  await viewport.hover();
  await page.mouse.wheel(0, -100000);
  await expect(
    page.getByRole("button", { name: "Loading earlier messages…" }),
  ).toBeVisible();
  const anchor = page.locator('[data-message-id="turn-100"]');
  const before = (await anchor.boundingBox())!.y;
  await expect(
    page.getByText("Earlier question 0", { exact: true }),
  ).toBeAttached();
  expect(Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThan(5);
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/events")),
  ).toHaveLength(2);
});

test("sidebar width, visibility, and pins survive reload", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  const divider = page.getByRole("separator", { name: "Resize sidebar" });
  await divider.focus();
  await divider.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "400");
  await page
    .getByRole("button", { name: `Actions for ${firstTitle}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Pin session", exact: true })
    .click();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.reload();
  await expect(
    page.getByRole("complementary", { name: "Workspace sidebar" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(divider).toHaveAttribute("aria-valuenow", "400");
  await page
    .getByRole("button", { name: `Actions for ${firstTitle}`, exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Unpin session", exact: true }),
  ).toBeVisible();
});

test("each project has a new conversation button, and the start page applies chosen agent settings before the first prompt", async ({
  page,
}, info) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  await expect(
    page.getByText("A calmer place to work", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Actions for project portal" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New conversation in portal", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("combobox", { name: "Project", exact: true }),
  ).toContainText("portal");
  // Seeded from Claude Code's latest session: Sonnet in the fixture.
  const settings = page.getByRole("button", {
    name: "Agent settings",
    exact: true,
  });
  await expect(settings).toContainText("Sonnet");
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "Agent settings" });
  await dialog.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: "Opus", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toContainText("Opus");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("start-settings.png"),
  });
  await page
    .getByRole("textbox", { name: "First message" })
    .fill("Build a project dashboard");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/created$/);
  await expect(
    page.getByRole("combobox", { name: "Message Claude Code" }),
  ).toHaveValue("");
  const steps = fixture.requests
    .filter(
      (request) =>
        request.path.endsWith("/config") || request.path.endsWith("/prompt"),
    )
    .map((request) => [request.path, request.body]);
  expect(steps).toEqual([
    ["/api/sessions/created/config", { configId: "model", value: "opus" }],
    ["/api/sessions/created/prompt", { text: "Build a project dashboard" }],
  ]);
  // The next start page seeds from the session just created, so Opus is now the default.
  await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
  await expect(settings).toContainText("Opus");
});

test("sidebar rows are compact with single-line titles", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  const row = page.getByRole("button", { name: firstTitle, exact: true });
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  expect(box.height).toBeLessThan(50);
  const title = row.locator(".sidebar-title");
  expect(await title.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
});
