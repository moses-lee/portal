import { expect, test } from "@playwright/test";
import {
  emit,
  events,
  failingGithubSummary,
  firstTitle,
  makeSession,
  manySessions,
  project,
  secondTitle,
  setupPortal,
  removedProject,
  worktree,
} from "./fixtures";
import { buildGitActionPrompt } from "../../src/lib/git-action-prompt";
import { defaultSettings } from "../../src/lib/settings";
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

test("Up and Down recall this session's sent prompts like a shell", async ({
  page,
}) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  const input = page.getByRole("combobox", { name: "Message Claude Code" });
  const sent = () =>
    fixture.requests.filter((request) => request.path.endsWith("/prompt"));

  // Nothing sent yet: Up leaves the draft alone.
  await input.fill("draft");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("draft");

  // A failed send is not history; the accepted ones are, trimmed and without a repeated entry.
  fixture.failSend();
  await input.fill("never accepted");
  await input.press("Enter");
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  fixture.failSend(false);
  for (const text of ["first prompt", "second\nprompt  ", "second\nprompt"]) {
    const count = sent().length;
    await input.fill(text);
    await input.press("Enter");
    await expect.poll(() => sent().length).toBe(count + 1);
    await expect(input).toHaveValue("");
  }

  // Up recalls the newest first with the caret at the end; a multi-line entry moves the caret up
  // a line before stepping further back, and the oldest entry stays put.
  await input.fill("half-typed");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("second\nprompt");
  expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(13);
  await input.press("ArrowUp");
  await expect(input).toHaveValue("second\nprompt");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("first prompt");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("first prompt");

  // Down walks forward and past the newest entry restores the half-typed draft.
  await input.press("End");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("second\nprompt");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("half-typed");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("half-typed");

  // Editing a recalled entry makes it the draft: browsing starts over from the newest.
  await input.press("ArrowUp");
  await input.press("ArrowUp");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("first prompt");
  await input.pressSequentially(" again");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("second\nprompt");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("first prompt again");

  // History is per session, and survives a reload.
  await page.getByRole("button", { name: secondTitle, exact: true }).click();
  const other = page.getByRole("combobox", { name: "Message Codex" });
  await other.press("ArrowUp");
  await expect(other).toHaveValue("");
  await page.getByRole("button", { name: firstTitle, exact: true }).click();
  await page.reload();
  await input.fill("");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("second\nprompt");

  // The command palette keeps the arrows while it is open.
  await input.fill("/");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("/");
});

for (const { trigger, agentId, name, partial } of [
  { trigger: "/", agentId: "claude", name: "compact", partial: "autocompact" },
  { trigger: "$", agentId: "codex", name: "release", partial: "prerelease" },
]) {
  test(`${trigger} completion exposes all commands and scrolls keyboard selections`, async ({ page }) => {
    const session = makeSession("s1", firstTitle, agentId);
    const sigil = trigger === "$" ? "$" : "";
    session.state.commands = [
      ...Array.from({ length: 30 }, (_, i) => ({
        name: `${sigil}skill-${i + 1}`,
        description: `Run skill ${i + 1}`,
      })),
      { name: sigil + partial, description: "A partial match" },
      { name: sigil + name, description: "A command at the end of the list" },
    ];
    const fixture = await setupPortal(page, { sessions: [session] });
    await page.goto("/sessions/s1");
    const input = page.getByRole("combobox", { name: `Message ${session.agentName}` });
    const palette = page.getByRole("listbox", { name: "Commands" });
    const options = palette.getByRole("option");
    await input.fill(trigger);
    await expect(options).toHaveCount(session.state.commands.length);

    // Wrapping backwards reaches the formerly hidden last command and scrolls it into view.
    await input.press("ArrowUp");
    await expect(options.last()).toHaveAttribute("aria-selected", "true");
    await expect(options.last()).toBeInViewport({ ratio: 1 });
    await expect(input).toBeFocused();
    await input.press("ArrowDown");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await expect(options.first()).toBeInViewport({ ratio: 1 });

    // Forward navigation also follows the selection beyond the old ten-result limit.
    for (let i = 0; i < 12; i++) await input.press("ArrowDown");
    await expect(options.nth(12)).toHaveAttribute("aria-selected", "true");
    await expect(options.nth(12)).toBeInViewport({ ratio: 1 });

    // Filtering still ranks prefix matches ahead of partial matches and resets the scroll.
    await input.fill(trigger + name);
    await expect(options).toHaveCount(2);
    await expect(options.first()).toContainText(trigger + name);
    await expect(options.last()).toContainText(trigger + partial);
    await expect(options.first()).toBeInViewport({ ratio: 1 });
    await input.press("Tab");
    await expect(input).toHaveValue(`${trigger}${name} `);
    expect(fixture.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(0);
  });
}

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

test("git action prompts persist across reloads and reset to their default", async ({
  page,
}) => {
  await setupPortal(page, { realSettings: true });
  await page.goto("/sessions/s1");
  const openSettings = () =>
    page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const field = dialog.getByRole("textbox", { name: "Failing checks" });
  const reset = dialog.getByRole("button", { name: "Reset to default" });
  const defaultPrompt = defaultSettings.gitActions.prompts.checks;
  await openSettings();
  await expect(
    dialog.getByRole("heading", { name: "Git actions" }),
  ).toBeVisible();
  await expect(field).toHaveValue(defaultPrompt);
  await expect(reset).toHaveCount(0);
  // Unique so settings saved by another run can never satisfy the assertions.
  const custom = `Find out why the checks fail (${Date.now()})`;
  await field.fill(custom);
  await field.press("Tab");
  await expect(dialog.getByRole("status")).toHaveText("Saved");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await openSettings();
  await expect(field).toHaveValue(custom);
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(field).toHaveValue(defaultPrompt);
  await expect(reset).toHaveCount(0);
  // Leave the server's settings as this test found them.
  await page.reload();
  await openSettings();
  await expect(field).toHaveValue(defaultPrompt);
});

test("settings sections live in a sidebar, the last one viewed is remembered, and a script saves with its options", async ({
  page,
}, info) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  const openSettings = () =>
    page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await openSettings();
  const nav = dialog.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("button")).toHaveText([
    "Git actions",
    "Talk to Portal",
    "Scripts",
  ]);
  // Opening with nothing remembered lands on the first section; only its pane is on screen.
  await expect(dialog.getByRole("heading", { name: "Git actions" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Scripts" })).toHaveCount(0);

  await nav.getByRole("button", { name: "Scripts" }).click();
  await expect(dialog.getByRole("heading", { name: "Scripts" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Git actions" })).toHaveCount(0);
  const command = dialog.getByRole("textbox", { name: "Before deleting a worktree" });
  await expect(command).toHaveValue("");
  await expect(dialog.getByText("Script is Off")).toBeVisible();
  await dialog.screenshot({
    animations: "disabled",
    path: info.outputPath("settings-scripts.png"),
  });

  // The command saves when the field is left; the mocked server echoes the patch back.
  await command.fill("make clean");
  await command.press("Tab");
  await expect(dialog.getByRole("status")).toHaveText("Saved");
  await expect(dialog.getByText("Script is On")).toBeVisible();
  const toggle = dialog.getByRole("switch", { name: "If the script fails" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(dialog.getByText("Carry on and delete anyway")).toBeVisible();
  const timeout = dialog.getByRole("spinbutton", { name: "Timeout (seconds)" });
  await expect(timeout).toHaveValue("300");
  await timeout.fill("0");
  await timeout.press("Tab");
  await expect(
    dialog.getByRole("alert").filter({ hasText: "whole number of seconds" }),
  ).toBeVisible();
  await timeout.fill("45");
  await timeout.press("Tab");
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Reopening lands on the section last viewed in this browser.
  await openSettings();
  await expect(dialog.getByRole("heading", { name: "Scripts" })).toBeVisible();
  await page.keyboard.press("Escape");

  // A deep link still wins over the remembered section.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("portal:open-settings", {
        detail: { section: "orchestrator" },
      }),
    ),
  );
  await expect(dialog.getByRole("heading", { name: "Talk to Portal" })).toBeVisible();
});

test("source control actions draft a prompt on the start page without creating a session", async ({
  page,
}, info) => {
  const fixture = await setupPortal(page, { github: failingGithubSummary });
  await page.goto("/sessions/s3");
  await expect(
    page.getByRole("combobox", { name: "Message Codex" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open GitHub inspector" }).click();
  const inspector = page.getByRole("complementary", {
    name: "GitHub inspector",
  });
  const action = (name: string) => inspector.getByRole("button", { name });
  const checks = action("Investigate failing checks in a new conversation");
  await expect(checks).toBeVisible();
  // The expand toggle is the action button's sibling, not its parent, and still works.
  const toggle = inspector.getByRole("button", {
    name: /Checks: 1 passing, 1 failing/,
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    inspector.getByRole("link", { name: "Unit tests" }),
  ).toBeVisible();
  await inspector.screenshot({
    animations: "disabled",
    path: info.outputPath("git-actions.png"),
  });
  const composer = page.getByRole("textbox", { name: "First message" });
  const prompts = defaultSettings.gitActions.prompts;

  await checks.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("combobox", { name: "Project", exact: true }),
  ).toContainText("portal");
  const checksPrompt = buildGitActionPrompt(
    "checks",
    failingGithubSummary,
    prompts.checks,
  );
  expect(checksPrompt).toContain(prompts.checks);
  expect(checksPrompt).toContain(
    "PR #42: https://github.com/example/portal/pull/42",
  );
  expect(checksPrompt).toContain(
    "- Unit tests: https://github.com/example/portal/actions/runs/2",
  );
  expect(checksPrompt).not.toContain("Lint");
  await expect(composer).toHaveValue(checksPrompt);

  // The inspector stays open on the start page, so the other actions are a click away.
  await action("Investigate merge conflicts in a new conversation").click();
  const conflictsPrompt = buildGitActionPrompt(
    "conflicts",
    failingGithubSummary,
    prompts.conflicts,
  );
  expect(conflictsPrompt).toContain("- src/a.ts");
  await expect(composer).toHaveValue(conflictsPrompt);

  await action("Summarize review items in a new conversation").click();
  const reviewPrompt = buildGitActionPrompt(
    "review",
    failingGithubSummary,
    prompts.review,
  );
  expect(reviewPrompt).toContain("2 unresolved threads, 3 comments");
  await expect(composer).toHaveValue(reviewPrompt);

  expect(
    fixture.requests.filter(
      (request) =>
        request.path === "/api/sessions" && request.method === "POST",
    ),
  ).toHaveLength(0);
});

test("the sidebar opens a standalone terminal page with its own URL", async ({
  page,
}) => {
  await setupPortal(page);
  // No PTY behind the fixtures: the tab stays connecting instead of being closed as unknown.
  await page.routeWebSocket("**/api/shell/socket**", () => {});
  await page.goto("/sessions/s1");
  const terminalButton = page.getByRole("button", {
    name: "Terminal",
    exact: true,
  });
  await expect(terminalButton).not.toHaveAttribute("aria-current", "page");
  await terminalButton.click();
  await expect(page).toHaveURL(/\/terminal$/);
  await expect(terminalButton).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Terminal", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Connecting…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide terminal" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /GitHub inspector/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "First message" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: firstTitle, exact: true }),
  ).not.toHaveAttribute("aria-current", "page");

  // The page survives a reload and leaves via the sidebar.
  await page.reload();
  await expect(page).toHaveURL(/\/terminal$/);
  await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("textbox", { name: "First message" })).toBeVisible();
  await expect(terminalButton).not.toHaveAttribute("aria-current", "page");
});

test("the Removed view lists removed projects, restores one, and opens its conversation", async ({
  page,
}) => {
  const fixture = await setupPortal(page, { removed: [removedProject] });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  const workspace = sidebar.getByRole("navigation", {
    name: "Projects and sessions",
  });
  await expect(workspace).toBeVisible();
  // Conversations of removed projects no longer show up as a group in the workspace.
  await expect(sidebar.getByText("Removed projects")).toHaveCount(0);

  await sidebar.getByRole("button", { name: "Removed", exact: true }).click();
  const view = sidebar.getByRole("region", { name: "Removed projects" });
  await expect(view).toBeVisible();
  await expect(workspace).toHaveCount(0);
  const row = view.getByRole("listitem", { name: "feat/old-branch" });
  await expect(row.getByText("portal · feat/old-branch")).toBeVisible();
  await expect(row.getByText("2 conversations · removed 2h ago")).toBeVisible();

  await row.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(workspace).toBeVisible();
  expect(
    fixture.requests.filter(
      (request) =>
        request.path === "/api/projects/removed/p9/restore" &&
        request.method === "POST",
    ),
  ).toHaveLength(1);
  await expect(page).toHaveURL(/\/sessions\/s9$/);
  await expect(
    workspace.getByRole("button", {
      name: "Finish the old branch",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
});

test("the Removed view explains unrestorable rows and deletes their conversations after confirming", async ({
  page,
}) => {
  const fixture = await setupPortal(page, {
    removed: [
      {
        ...removedProject,
        id: "p8",
        name: "old-tools",
        worktree: undefined,
        restorable: false,
        reason: "The project folder is missing.",
        sessionCount: 1,
      },
    ],
  });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  await sidebar.getByRole("button", { name: "Removed", exact: true }).click();
  const view = sidebar.getByRole("region", { name: "Removed projects" });
  const row = view.getByRole("listitem", { name: "old-tools" });
  await expect(row.getByText("The project folder is missing.")).toBeVisible();
  await expect(row.getByRole("button", { name: "Restore" })).toHaveCount(0);

  await row.getByRole("button", { name: "Delete conversations" }).click();
  await row.getByRole("button", { name: "Cancel" }).click();
  expect(
    fixture.requests.filter((request) => request.method === "DELETE"),
  ).toHaveLength(0);
  await row.getByRole("button", { name: "Delete conversations" }).click();
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(view.getByText("Nothing to bring back")).toBeVisible();
  expect(
    fixture.requests.filter(
      (request) =>
        request.path === "/api/projects/removed/p8" &&
        request.method === "DELETE",
    ),
  ).toHaveLength(1);

  await view.getByRole("button", { name: "Back to workspace" }).click();
  await expect(
    sidebar.getByRole("navigation", { name: "Projects and sessions" }),
  ).toBeVisible();
});

test("a project lists five conversations and reveals the rest on request", async ({
  page,
}) => {
  await setupPortal(page, { sessions: manySessions() });
  await page.goto("/");
  const portalSection = page.getByRole("region", { name: "portal" });

  // The five most recent show; the older three are only a count until asked for.
  await expect(portalSection.getByRole("button", { name: "Conversation 5", exact: true })).toBeVisible();
  await expect(portalSection.getByRole("button", { name: "Conversation 6", exact: true })).toHaveCount(0);
  const more = portalSection.getByRole("button", { name: "Show 3 more" });
  await expect(more).toBeVisible();
  // The cap is per project: the worktree's single conversation is untouched.
  await expect(
    page.getByRole("region", { name: worktree.name }).getByRole("button", { name: "Show" }),
  ).toHaveCount(0);

  await more.click();
  await expect(portalSection.getByRole("button", { name: "Conversation 8", exact: true })).toBeVisible();
  await portalSection.getByRole("button", { name: "Show less" }).click();
  await expect(portalSection.getByRole("button", { name: "Conversation 8", exact: true })).toHaveCount(0);

  // A search shows every match rather than hiding results behind the cap.
  await page.getByRole("textbox", { name: "Search sessions" }).fill("Conversation");
  await expect(portalSection.getByRole("button", { name: "Conversation 8", exact: true })).toBeVisible();
  await expect(portalSection.getByRole("button", { name: /^Show/ })).toHaveCount(0);
});

test("the conversation you have open stays listed past the cap", async ({ page }) => {
  await setupPortal(page, { sessions: manySessions() });
  // m7 sorts seventh, so the cap would hide it if the sidebar did not keep the open one.
  await page.goto("/sessions/m7");
  const portalSection = page.getByRole("region", { name: "portal" });
  const open = portalSection.getByRole("button", { name: "Conversation 7", exact: true });
  await expect(open).toHaveAttribute("aria-current", "page");
  // It keeps its sorted position: still after the fifth, and only the remaining two are hidden.
  await expect(portalSection.getByRole("button", { name: "Show 2 more" })).toBeVisible();
  await expect(portalSection.getByRole("button", { name: "Conversation 6", exact: true })).toHaveCount(0);
});

test("collapse all folds every project, survives a reload, and expands again", async ({
  page,
}) => {
  await setupPortal(page, { sessions: manySessions() });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  const first = sidebar.getByRole("button", { name: "Conversation 1", exact: true });
  await expect(first).toBeVisible();

  await sidebar.getByRole("button", { name: "Collapse all projects" }).click();
  await expect(first).toBeHidden();
  await expect(sidebar.getByRole("button", { name: "Worktree work", exact: true })).toBeHidden();
  const expandAll = sidebar.getByRole("button", { name: "Expand all projects" });
  await expect(expandAll).toBeVisible();

  await page.reload();
  await expect(first).toBeHidden();
  // Searching still surfaces matches inside collapsed projects.
  await page.getByRole("textbox", { name: "Search sessions" }).fill("Conversation 1");
  await expect(first).toBeVisible();
  await page.getByRole("textbox", { name: "Search sessions" }).fill("");
  await expect(first).toBeHidden();

  await sidebar.getByRole("button", { name: "Expand all projects" }).click();
  await expect(first).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Collapse all projects" })).toBeVisible();
});

test("projects are ordered by most recent activity, below pinned ones", async ({
  page,
}) => {
  const base = Date.now();
  await setupPortal(page, {
    // Explicit createdAt so the ranking comes from the sessions, not from when the fixtures loaded.
    projects: [
      { ...project, createdAt: 1 },
      { ...worktree, createdAt: 2 },
    ],
    sessions: [
      { ...makeSession("a1", "Older work", "claude", project), lastActiveAt: base - 3_600_000 },
      { ...makeSession("b1", "Newer work", "codex", worktree), lastActiveAt: base },
    ],
  });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  const regions = sidebar
    .getByRole("navigation", { name: "Projects and sessions" })
    .getByRole("region");
  const names = () =>
    regions.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label")),
    );
  await expect.poll(names).toEqual([worktree.name, project.name]);

  // A pin outranks recency.
  await sidebar.getByRole("button", { name: `Actions for project ${project.name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin project" }).click();
  await expect.poll(names).toEqual([project.name, worktree.name]);
});

test("collapsing one project folds only it and forgets its expanded list", async ({
  page,
}) => {
  await setupPortal(page, { sessions: manySessions() });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  const portalSection = page.getByRole("region", { name: project.name, exact: true });
  const eighth = portalSection.getByRole("button", { name: "Conversation 8", exact: true });
  const header = sidebar.locator(`button[aria-controls="project-${project.id}"]`);
  const worktreeRow = sidebar.getByRole("button", { name: "Worktree work", exact: true });

  await portalSection.getByRole("button", { name: "Show 3 more" }).click();
  await expect(eighth).toBeVisible();

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(eighth).toBeHidden();
  // Folding one project leaves the others alone.
  await expect(worktreeRow).toBeVisible();

  // Reopening starts from the short list again rather than restoring the "show all".
  await header.click();
  await expect(eighth).toBeHidden();
  await expect(portalSection.getByRole("button", { name: "Show 3 more" })).toBeVisible();

  await header.click();
  await page.reload();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(worktreeRow).toBeVisible();
});

test("collapse all covers projects the search filtered out", async ({ page }) => {
  await setupPortal(page, { sessions: manySessions() });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  const search = page.getByRole("textbox", { name: "Search sessions" });
  const headers = [project.id, worktree.id].map((id) =>
    sidebar.locator(`button[aria-controls="project-${id}"]`),
  );

  // Only the portal project matches, but the button edits the stored state for every project.
  await search.fill("Conversation");
  await sidebar.getByRole("button", { name: "Collapse all projects" }).click();
  await search.fill("");
  for (const header of headers)
    await expect(header).toHaveAttribute("aria-expanded", "false");
});

test("the collapse toggle is disabled when there are no projects", async ({
  page,
}) => {
  await setupPortal(page, { projects: [], sessions: [] });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  await expect(
    sidebar.getByText("Add a project to create your first conversation."),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "Collapse all projects" }),
  ).toBeDisabled();
});
