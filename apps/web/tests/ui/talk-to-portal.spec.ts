import { expect, test } from "@playwright/test";
import { emitPortal, portalItem, portalStatus, setupPortal } from "./fixtures";
import { approval } from "./orchestrator-fixtures";
import type { OrchestratorMessage } from "../../src/lib/orchestrator/types";

declare global {
  interface Window {
    __openSettingsRequests: unknown[];
  }
}

test("Portal is the home: the sidebar's Chat entry opens / and is marked current", async ({
  page,
}) => {
  await setupPortal(page);
  // The start page opens the sidebar on Projects; Portal's entries sit one step back.
  await page.goto("/new");
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  await expect(sidebar.getByRole("navigation", { name: "Projects and sessions" })).toBeVisible();
  await sidebar.getByRole("button", { name: "Back to Portal" }).click();
  const nav = sidebar.getByRole("navigation", { name: "Portal", exact: true });
  // Chat carries the needs-you count (one in the fixture) as a badge.
  await expect(nav.getByRole("button")).toHaveText([/^Chat/, "Goals", "Activity", "Memory", "System", "Terminal", "Projects", "Settings"]);
  await expect(nav.getByRole("button", { name: "Chat", exact: true })).toContainText("1");
  const button = nav.getByRole("button", { name: "Chat", exact: true });
  await expect(button).not.toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("button", { name: "Projects", exact: true })).toHaveAttribute("aria-current", "page");
  await button.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(button).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Talk to Portal" })).toBeVisible();
  // The status line: the server's words, then the next job counted down in the browser (the
  // fixture times it seven minutes out at setup; a slow run may have shaved one off).
  const line = page.getByTestId("portal-status-line");
  await expect(line).toContainText("Idle · next: Check for changes");
  await expect(line).toContainText(/· in [67] min/);
  // The GitHub inspector belongs to sessions; Portal has none.
  await expect(page.getByRole("button", { name: "Open GitHub inspector" })).toHaveCount(0);
  // The other views drop the status line and Run now and take their own title.
  await nav.getByRole("button", { name: "Goals", exact: true }).click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByRole("heading", { name: "Goals", level: 1 })).toBeVisible();
  await expect(line).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(0);
  // The brand is a home link.
  await sidebar.getByRole("button", { name: "Portal home" }).click();
  await expect(page).toHaveURL(/\/$/);
  // Projects opens the projects column; a new conversation from there leaves Portal.
  await nav.getByRole("button", { name: "Projects", exact: true }).click();
  await sidebar.getByRole("button", { name: "New conversation in portal", exact: true }).click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(sidebar.getByRole("navigation", { name: "Projects and sessions" })).toBeVisible();
});

test("without an API key the page asks for one and Add API key opens settings", async ({
  page,
}) => {
  await setupPortal(page, {
    portal: { status: { ready: false, line: "Add an API key in Settings to start Portal." }, items: [] },
  });
  await page.goto("/");
  await expect(page.getByTestId("portal-status-line")).toHaveText("Add an API key in Settings to start Portal.");
  await expect(
    page.getByText("Talk to Portal needs an API key for OpenAI."),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Portal" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Run now" })).toBeDisabled();
  await page.evaluate(() => {
    window.__openSettingsRequests = [];
    window.addEventListener("portal:open-settings", (event) =>
      window.__openSettingsRequests.push((event as CustomEvent).detail),
    );
  });
  await page.getByRole("button", { name: "Add API key" }).click();
  expect(await page.evaluate(() => window.__openSettingsRequests)).toEqual([
    { section: "orchestrator" },
  ]);
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("the thread renders replies, the tick label, and tool rows in prose; items live in the Needs-you strip", async ({
  page,
}, info) => {
  const fixture = await setupPortal(page);
  await page.goto("/");
  await expect(page.getByText("What needs me today?")).toBeVisible();
  await expect(
    page.getByText("Nothing yet. I will keep an eye on your pull requests."),
  ).toBeVisible();
  await expect(page.getByText(/^Scheduled check · \d{2}:\d{2}/)).toBeVisible();
  const toolRow = page.getByRole("button", { name: /Ran get_tick_digest/ });
  await expect(toolRow).toBeVisible();
  await toolRow.click();
  await expect(page.getByText('"changes": 1')).toBeVisible();
  // The tick's message touched the item, but the thread stays prose: no card under it.
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article")).toHaveCount(0);
  const strip = page.getByRole("region", { name: "Needs you (1)" });
  await expect(strip).toBeVisible();
  await strip.getByRole("button", { name: portalItem.title }).click();
  const card = strip.getByRole("article", { name: portalItem.title });
  await expect(card).toBeVisible();
  await expect(card.getByText("Needs you", { exact: true })).toBeVisible();
  await expect(card.getByText("Checks failing")).toBeVisible();
  await expect(card.getByText("Unit tests")).toBeVisible();
  await expect(card.getByRole("button", { name: "Open session" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Open on GitHub" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Ask Portal" })).toBeVisible();
  await page.screenshot({ animations: "disabled", path: info.outputPath("portal.png") });

  // Ask Portal sends the action's text as a chat message; only that message goes to the server.
  await card.getByRole("button", { name: "Ask Portal" }).click();
  await expect(page.getByText("Set up a fix for example/portal#42", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Portal reply to: Set up a fix for example/portal#42"),
  ).toBeVisible();
  const sent = fixture.requests.filter(
    (request) => request.path === "/api/portal/messages" && request.method === "POST",
  );
  expect(sent).toHaveLength(1);
  expect(Object.keys(sent[0].body as object)).toEqual(["message"]);
  expect((sent[0].body as { message: { role: string } }).message.role).toBe("user");

  // Resolve goes through PATCH and leaves the strip empty; the thread's messages are unchanged.
  await card.getByRole("button", { name: `More actions for ${portalItem.title}` }).click();
  await page.getByRole("menuitem", { name: "Resolve" }).click();
  await expect(page.getByRole("region", { name: "Needs you (0)" })).toBeVisible();
  const patch = fixture.requests.find(
    (request) => request.path === "/api/portal/items/i1" && request.method === "PATCH",
  );
  expect(patch?.body).toEqual({ status: "resolved", snoozedUntil: null });
  await expect(page.getByRole("article", { name: portalItem.title })).toHaveCount(0);
  await expect(log.getByRole("article")).toHaveCount(0);
});

test("a refused send keeps the text in the composer and shows the server's reason", async ({
  page,
}) => {
  const fixture = await setupPortal(page);
  fixture.failPortalSend("Portal is running a check. Try again in a moment.");
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Portal" });
  await input.fill("Which PRs are waiting on me?");
  await input.press("Enter");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Portal is running a check. Try again in a moment.",
  );
  await expect(input).toHaveValue("Which PRs are waiting on me?");
  // The server never kept the turn, so the thread does not show it either (only the composer has the text).
  await expect(
    page.getByRole("log", { name: "Messages" }).getByText("Which PRs are waiting on me?", { exact: true }),
  ).toHaveCount(0);
  expect(
    fixture.requests.filter(
      (request) => request.path === "/api/portal/messages" && request.method === "POST",
    ),
  ).toHaveLength(1);

  // Once the server takes it, the same text goes through and the composer lets go of it.
  fixture.failPortalSend(null);
  await input.press("Enter");
  await expect(
    page.getByText("Portal reply to: Which PRs are waiting on me?"),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);

  // Up recalls what the server took, once: the refused attempt is not a second history entry.
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Which PRs are waiting on me?");
  await input.press("Home");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Which PRs are waiting on me?");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");
});

test("sending behaves as on a session page: the text stays, with Sending…, until the server takes it", async ({
  page,
}) => {
  const fixture = await setupPortal(page);
  const release = fixture.holdSends("main");
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Portal" });
  await input.fill("What changed overnight?");
  await input.press("Enter");
  // The server has not answered: the send button shows the wait, and the draft is still in the box.
  await expect(page.getByRole("button", { name: "Sending message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop agent" })).toHaveCount(0);
  await expect(input).toHaveValue("What changed overnight?");
  await expect(page.getByRole("log", { name: "Messages" }).getByText("What changed overnight?", { exact: true })).toBeVisible();
  // The reply stream opens: the message was taken, the box clears, and the turn can be stopped from here.
  release();
  await expect(input).toHaveValue("");
  await expect(page.getByText("Portal reply to: What changed overnight?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await input.press("ArrowUp");
  await expect(input).toHaveValue("What changed overnight?");
});

test("background work never blocks the composer; only this thread's own turn does", async ({
  page,
}) => {
  const fixture = await setupPortal(page, {
    portal: {
      status: {
        busy: true,
        line: "Checking for changes…",
        runs: [{ id: "r1", kind: "tick", jobId: "tick", threadId: null, startedAt: Date.now() - 5000, summary: "Checking for changes" }],
      },
    },
  });
  await page.goto("/");
  await expect(page.getByTestId("portal-status-line")).toContainText("Checking for changes…");
  const input = page.getByRole("textbox", { name: "Message Portal" });
  // A job is running, and the user can still talk.
  await input.fill("Anything new?");
  await input.press("Enter");
  await expect(page.getByText("Portal reply to: Anything new?")).toBeVisible();

  // A turn in this thread started elsewhere (another tab): the composer offers Stop, and a card's
  // Ask Portal hands its text to the composer instead of sending.
  await emitPortal(page, { type: "status", status: { ...portalStatus, busy: true, busyThreads: ["main"] } });
  await expect(page.getByText(/Portal is answering in this thread/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop agent" })).toBeVisible();
  await page.getByRole("region", { name: "Needs you (1)" }).getByRole("button", { name: portalItem.title }).click();
  await page
    .getByRole("article", { name: portalItem.title })
    .getByRole("button", { name: "Ask Portal" })
    .click();
  await expect(input).toHaveValue("Set up a fix for example/portal#42");
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "Stop agent" }).click();
  await expect
    .poll(() => fixture.requests.filter((r) => r.path === "/api/portal/threads/main/cancel" && r.method === "POST").length)
    .toBe(1);

  // The turn ending (a `status` event) frees the composer; the draft is still there to send.
  await emitPortal(page, { type: "status", status: { ...portalStatus, busy: false } });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(input).toHaveValue("Set up a fix for example/portal#42");
});

test("a messages stream event refetches the thread and shows what a tick appended", async ({
  page,
}) => {
  const fixture = await setupPortal(page);
  await page.goto("/");
  await expect(page.getByText("What needs me today?")).toBeVisible();
  const appended: OrchestratorMessage = {
    id: "m4",
    role: "assistant",
    metadata: { at: Date.now(), tick: { id: "t2", reason: "manual" } },
    parts: [{ type: "text", text: "Your PR #42 checks are green again." }],
  };
  fixture.appendPortalMessage(appended);
  const loads = () =>
    fixture.requests.filter(
      (request) => request.path === "/api/portal/messages" && request.method === "GET",
    ).length;
  const before = loads();
  await emitPortal(page, { type: "messages" });
  await expect(page.getByText("Your PR #42 checks are green again.")).toBeVisible();
  await expect(page.getByText(/^Manual check · \d{2}:\d{2}/)).toBeVisible();
  expect(loads()).toBe(before + 1);
});

test("Open session navigates to the session and Run now posts a tick", async ({
  page,
}) => {
  const fixture = await setupPortal(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Checked at/ })).toContainText(
    "2 changes, 1 new",
  );
  expect(
    fixture.requests.filter(
      (request) => request.path === "/api/portal/tick" && request.method === "POST",
    ),
  ).toHaveLength(1);
  await page.getByRole("region", { name: "Needs you (1)" }).getByRole("button", { name: portalItem.title }).click();
  await page
    .getByRole("article", { name: portalItem.title })
    .getByRole("button", { name: "Open session" })
    .click();
  await expect(page).toHaveURL(/\/sessions\/s1$/);
  await expect(
    page.getByRole("combobox", { name: "Message Claude Code" }),
  ).toBeVisible();
});

test("the aurora sits behind every Portal view and follows the user's turn and pending approvals", async ({
  page,
}) => {
  await setupPortal(page);
  await page.goto("/");
  const aurora = page.locator(".aurora");
  await expect(aurora).toHaveAttribute("data-activity", "idle");
  // A background job never colours it; a turn answering the user (in any thread) does.
  await emitPortal(page, {
    type: "status",
    status: { ...portalStatus, busy: true, runs: [{ id: "r1", kind: "tick", jobId: "tick", threadId: null, startedAt: Date.now(), summary: "Checking" }] },
  });
  await expect(aurora).toHaveAttribute("data-activity", "idle");
  await emitPortal(page, { type: "status", status: { ...portalStatus, busy: true, busyThreads: ["t-review"] } });
  await expect(aurora).toHaveAttribute("data-activity", "working");
  // An approval waiting turns it amber, whichever view is open.
  await emitPortal(page, { type: "approvals", approvals: [approval] });
  await expect(aurora).toHaveAttribute("data-activity", "waiting");
  await page.getByRole("button", { name: "Decide later" }).click();
  await page.getByRole("navigation", { name: "Portal", exact: true }).getByRole("button", { name: "Goals", exact: true }).click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(aurora).toHaveAttribute("data-activity", "waiting");
  await emitPortal(page, { type: "approvals", approvals: [] });
  await emitPortal(page, { type: "status", status: portalStatus });
  await expect(aurora).toHaveAttribute("data-activity", "idle");
});
