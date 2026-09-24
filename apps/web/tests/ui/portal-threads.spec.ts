import { expect, test } from "@playwright/test";
import { emitPortal, portalStatus, setupPortal } from "./fixtures";
import {
  archivedThread,
  archivedThreadMessages,
  mainThread,
  reviewThread,
  reviewThreadMessages,
} from "./orchestrator-fixtures";

const threads = [mainThread, reviewThread, archivedThread];
const threadMessages = { [reviewThread.id]: reviewThreadMessages, [archivedThread.id]: archivedThreadMessages };

test("side threads have their own history, composer, and URL; the switcher offers no way to create one", async ({
  page,
}, info) => {
  const fixture = await setupPortal(page, { portal: { threads, threadMessages } });
  await page.goto("/");
  const switcher = page.getByRole("tablist", { name: "Threads" });
  await expect(switcher.getByRole("tab")).toHaveText(["Main", reviewThread.title]);
  await expect(switcher.getByRole("tab", { name: "Main" })).toHaveAttribute("aria-selected", "true");
  // Portal alone opens and archives threads.
  await expect(page.getByRole("button", { name: /new thread/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);

  await switcher.getByRole("tab", { name: reviewThread.title }).click();
  await expect(page).toHaveURL(/\/threads\/t-review$/);
  await expect(page.getByText("I started a review session for")).toBeVisible();
  await expect(page.getByRole("heading", { name: reviewThread.title })).toBeVisible();
  await expect(page.getByRole("link", { name: "example/portal#42" })).toHaveAttribute("href", "https://github.com/example/portal/pull/42");
  // The main thread's Needs-you strip belongs to the main thread only.
  await expect(page.getByRole("region", { name: /Needs you/ })).toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: info.outputPath("side-thread.png") });

  const input = page.getByRole("textbox", { name: `Message Portal in ${reviewThread.title}` });
  await input.fill("How far along is the review?");
  await input.press("Enter");
  await expect(page.getByText("Portal reply to: How far along is the review?")).toBeVisible();
  const sent = fixture.requests.filter((r) => r.method === "POST" && r.path.endsWith("/messages"));
  expect(sent.map((r) => r.path)).toEqual(["/api/portal/threads/t-review/messages"]);

  // Back on main, its own history is intact and untouched by the side thread.
  await switcher.getByRole("tab", { name: "Main" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("What needs me today?")).toBeVisible();
  await expect(page.getByText("Portal reply to: How far along is the review?")).toBeHidden();

  // A reload lands on the thread in the URL.
  await page.goto("/threads/t-review");
  await expect(page.getByText("I started a review session for")).toBeVisible();

  // The sidebar's Chat entry goes to the main thread, even from a side thread (both are the Chat view).
  await page.getByRole("navigation", { name: "Portal", exact: true }).getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(switcher.getByRole("tab", { name: "Main" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("What needs me today?")).toBeVisible();
});

test("a turn running in one thread leaves every other thread free to chat", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: { threads, threadMessages } });
  const release = fixture.holdSends(reviewThread.id);
  await page.goto("/threads/t-review");
  const sideInput = page.getByRole("textbox", { name: `Message Portal in ${reviewThread.title}` });
  await sideInput.fill("Summarize the review so far");
  await sideInput.press("Enter");
  // Until the server takes the message the side thread shows it is sending (the text stays); the main thread is untouched.
  await expect(page.getByRole("button", { name: "Sending message" })).toBeVisible();
  await expect(sideInput).toHaveValue("Summarize the review so far");

  await page.getByRole("tablist", { name: "Threads" }).getByRole("tab", { name: "Main" }).click();
  const mainInput = page.getByRole("textbox", { name: "Message Portal" });
  await expect(page.getByRole("button", { name: "Sending message" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await mainInput.fill("And what else needs me?");
  await mainInput.press("Enter");
  await expect(page.getByText("Portal reply to: And what else needs me?")).toBeVisible();

  // The side thread's reply arrived while it was out of view, and its composer let go of the text.
  release();
  await page.getByRole("tablist", { name: "Threads" }).getByRole("tab", { name: reviewThread.title }).click();
  await expect(page.getByText("Portal reply to: Summarize the review so far")).toBeVisible();
  await expect(sideInput).toHaveValue("");
});

test("messages events refetch only their thread and mark other threads as having news", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: { threads, threadMessages } });
  await page.goto("/");
  await expect(page.getByText("What needs me today?")).toBeVisible();
  const loads = (path: string) => fixture.requests.filter((r) => r.method === "GET" && r.path === path).length;
  const mainLoads = loads("/api/portal/messages");
  fixture.appendPortalMessage(
    {
      id: "rt2",
      role: "assistant",
      metadata: { at: Date.now() },
      parts: [{ type: "text", text: "The review session finished with two findings." }],
    },
    reviewThread.id,
  );
  await emitPortal(page, { type: "messages", threadId: reviewThread.id });
  const tab = page.getByRole("tablist", { name: "Threads" }).getByRole("tab", { name: reviewThread.title });
  await expect(tab.getByLabel("New messages")).toBeVisible();
  expect(loads("/api/portal/messages")).toBe(mainLoads);
  await tab.click();
  await expect(page.getByText("The review session finished with two findings.")).toBeVisible();
  await expect(tab.getByLabel("New messages")).toHaveCount(0);
});

test("archived threads stay readable from the menu but take no messages", async ({ page }) => {
  await setupPortal(page, { portal: { threads, threadMessages } });
  await page.goto("/");
  await page.getByRole("button", { name: "Archived (1)" }).click();
  await page.getByRole("menuitem", { name: archivedThread.title }).click();
  await expect(page).toHaveURL(/\/threads\/t-old$/);
  await expect(page.getByText("Both merged worktrees are gone.")).toBeVisible();
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: `Message Portal in ${archivedThread.title}` });
  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute("placeholder", "This thread is archived");
});

test("the status line lists running work and links to its thread", async ({ page }) => {
  await setupPortal(page, {
    portal: {
      threads,
      threadMessages,
      status: {
        line: "Reviewing example/portal#42…",
        runs: [
          { id: "r1", kind: "helper", jobId: "j-pr42", threadId: reviewThread.id, startedAt: Date.now() - 65_000, summary: "Reviewing example/portal#42" },
        ],
      },
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Status: Reviewing example\/portal#42…/ }).click();
  const popover = page.getByRole("dialog");
  await expect(popover.getByText("Running now (1)")).toBeVisible();
  await expect(popover.getByText(/Helper · 1 min/)).toBeVisible();
  await popover.getByRole("button", { name: reviewThread.title }).click();
  await expect(page).toHaveURL(/\/threads\/t-review$/);

  // Idle again: the line shows what comes next with its countdown.
  await emitPortal(page, { type: "status", status: { ...portalStatus, nextJob: { id: "tick", title: "Check for changes", at: Date.now() + 3 * 60_000 } } });
  await expect(page.getByTestId("portal-status-line")).toContainText(/Idle · next: Check for changes· in [23] min/);
});
