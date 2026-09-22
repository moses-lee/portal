import { expect, test, type Page } from "@playwright/test";
import { portalItem, portalStatus, setupPortal } from "./fixtures";
import type { OrchestratorEvent, OrchestratorMessage } from "../../src/lib/orchestrator/types";

/** Pushes one orchestrator event through the page's open `/api/portal/stream`. */
const emitPortal = (page: Page, event: OrchestratorEvent) =>
  page.evaluate((event) => window.__portalEmit("/api/portal/stream", event, "message"), event);

declare global {
  interface Window {
    __openSettingsRequests: unknown[];
  }
}

test("the sidebar's Talk to Portal button opens /portal and is marked current", async ({
  page,
}) => {
  await setupPortal(page);
  await page.goto("/");
  const button = page.getByRole("button", { name: "Talk to Portal", exact: true });
  await expect(button).not.toHaveAttribute("aria-current", "page");
  await button.click();
  await expect(page).toHaveURL(/\/portal$/);
  await expect(button).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Talk to Portal" })).toBeVisible();
  // The fixture times the check seven minutes out at setup; a slow run may have shaved one off.
  await expect(page.getByText(/^gpt-5-mini · next check in [67] min$/)).toBeVisible();
  // The GitHub inspector belongs to sessions; Talk to Portal has none.
  await expect(page.getByRole("button", { name: "Open GitHub inspector" })).toHaveCount(0);
  await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(button).not.toHaveAttribute("aria-current", "page");
});

test("without an API key the page asks for one and Add API key opens settings", async ({
  page,
}) => {
  await setupPortal(page, { portal: { status: { ready: false }, items: [] } });
  await page.goto("/portal");
  await expect(page.getByText("Paused: add an API key")).toBeVisible();
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

test("the thread renders replies, the tick label, tool rows, and item cards", async ({
  page,
}, info) => {
  const fixture = await setupPortal(page);
  await page.goto("/portal");
  await expect(page.getByText("What needs me today?")).toBeVisible();
  await expect(
    page.getByText("Nothing yet. I will keep an eye on your pull requests."),
  ).toBeVisible();
  await expect(page.getByText(/^Scheduled check · \d{2}:\d{2}/)).toBeVisible();
  const toolRow = page.getByRole("button", { name: /Ran get_tick_digest/ });
  await expect(toolRow).toBeVisible();
  await toolRow.click();
  await expect(page.getByText('"changes": 1')).toBeVisible();
  const card = page.getByRole("article", { name: portalItem.title });
  await expect(card).toBeVisible();
  await expect(card.getByText("Needs you", { exact: true })).toBeVisible();
  await expect(card.getByText("Checks failing")).toBeVisible();
  await expect(card.getByText("Unit tests")).toBeVisible();
  await expect(card.getByRole("button", { name: "Open session" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Open on GitHub" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Ask Portal" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Needs you (1)" })).toBeVisible();
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

  // Resolve goes through PATCH and hides the item from the strip, but the card under the tick's
  // message stays as a dimmed record of what happened, and can be reopened.
  await card.getByRole("button", { name: `More actions for ${portalItem.title}` }).click();
  await page.getByRole("menuitem", { name: "Resolve" }).click();
  await expect(page.getByRole("region", { name: "Needs you (0)" })).toBeVisible();
  const patch = fixture.requests.find(
    (request) => request.path === "/api/portal/items/i1" && request.method === "PATCH",
  );
  expect(patch?.body).toEqual({ status: "resolved", snoozedUntil: null });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "resolved");
  await expect(card.getByText("Resolved")).toBeVisible();
  // The first menu must finish dismissing before the trigger can open the next one.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await card.getByRole("button", { name: `More actions for ${portalItem.title}` }).click();
  await expect(page.getByRole("menuitem", { name: "Reopen" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Resolve" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Reopen" }).click();
  await expect(page.getByRole("region", { name: "Needs you (1)" })).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "open");
});

test("a refused send keeps the text in the composer and shows the server's reason", async ({
  page,
}) => {
  const fixture = await setupPortal(page);
  fixture.failPortalSend("Portal is running a check. Try again in a moment.");
  await page.goto("/portal");
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

test("while a check is running, the composer waits and Ask Portal hands its text to the composer", async ({
  page,
}) => {
  await setupPortal(page, { portal: { status: { busy: true } } });
  await page.goto("/portal");
  await expect(page.getByText("Checking…")).toBeVisible();
  await expect(page.getByText(/Portal is running a check/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop agent" })).toBeVisible();
  await page
    .getByRole("article", { name: portalItem.title })
    .getByRole("button", { name: "Ask Portal" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Portal" });
  await expect(input).toHaveValue("Set up a fix for example/portal#42");
  await expect(input).toBeFocused();

  // The check finishing (a `status` event) frees the composer; the draft is still there to send.
  await emitPortal(page, { type: "status", status: { ...portalStatus, busy: false } });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(input).toHaveValue("Set up a fix for example/portal#42");
});

test("a messages stream event refetches the thread and shows what a tick appended", async ({
  page,
}) => {
  const fixture = await setupPortal(page);
  await page.goto("/portal");
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
  await page.goto("/portal");
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Checked at/ })).toContainText(
    "2 changes, 1 new",
  );
  expect(
    fixture.requests.filter(
      (request) => request.path === "/api/portal/tick" && request.method === "POST",
    ),
  ).toHaveLength(1);
  await page
    .getByRole("article", { name: portalItem.title })
    .getByRole("button", { name: "Open session" })
    .click();
  await expect(page).toHaveURL(/\/sessions\/s1$/);
  await expect(
    page.getByRole("combobox", { name: "Message Claude Code" }),
  ).toBeVisible();
});
