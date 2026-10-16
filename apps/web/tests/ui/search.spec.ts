import { expect, test, type Page } from "@playwright/test";
import { firstTitle, secondTitle, setupPortal, tabUrl, thirdTitle } from "./fixtures";

/**
 * Global search (docs/SEARCH.md): the slash shortcut opens it; sessions and projects
 * match on the client, message hits and PR-linked sessions come from a mocked `GET /api/search`.
 */

const dialog = (page: Page) => page.getByRole("dialog", { name: "Search" });
const input = (page: Page) => dialog(page).getByRole("combobox", { name: "Search" });
const group = (page: Page, name: string) => dialog(page).getByRole("group", { name, exact: true });
const strip = (page: Page) => page.getByRole("tablist", { name: "Workspace tabs" });
/** The sidebar's shortcut hint renders only once the page has hydrated, and the shortcut listener with it. */
const hydrated = (page: Page) => expect(page.getByText(/^(⌘K|Ctrl K)$/)).toBeVisible();
const openSearch = async (page: Page) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("/");
};

test("slash opens search; esc closes it; the empty query lists recent sessions", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  await hydrated(page);
  await openSearch(page);
  await expect(input(page)).toBeFocused();
  const recent = group(page, "Recent sessions");
  await expect(recent.getByRole("option")).toHaveCount(3);
  await expect(recent.getByRole("option", { name: firstTitle })).toBeVisible();
  // Nothing opened from search yet: no Recent section.
  await expect(group(page, "Recent")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("slash stays in a focused composer and opens search after focus leaves it", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/sessions/s1");
  await expect(page).toHaveURL(/\/tabs\/w2$/);
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await hydrated(page);
  await composer.click();
  await page.keyboard.press("/");
  await expect(composer).toHaveValue("/");
  await expect(dialog(page)).toHaveCount(0);
  await openSearch(page);
  await expect(input(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(composer).toHaveValue("/");
});

test("a query lists projects, sessions (with PR hits), and messages from the server", async ({ page }) => {
  await setupPortal(page, {
    search: (q) =>
      q === "chat"
        ? {
            messages: [{ sessionId: "s2", seq: 4, role: "user", ts: Date.now() - 60_000, snippet: "make the chat calmer" }],
            pulls: [{ sessionId: "s3", via: "branch", pull: { repo: "o/portal", number: 42, url: "https://x", title: "Chat polish" } }],
          }
        : { messages: [], pulls: [] },
  });
  const asked: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/search") asked.push(url.searchParams.get("q") ?? "");
  });
  await page.goto("/");
  await hydrated(page);
  await openSearch(page);
  // Typed faster than the debounce: one request, for the whole word.
  await input(page).pressSequentially("chat", { delay: 30 });
  await expect(group(page, "Projects").getByRole("option")).toHaveText([/improve-chat-experience/]);
  const sessionsGroup = group(page, "Sessions");
  // The PR hit joins as strongly as a title prefix; the local matches follow.
  await expect(sessionsGroup.getByRole("option")).toHaveText([/Review the pull request/, /Improve the chat/, /Investigate long session/]);
  await expect(sessionsGroup.getByRole("option", { name: thirdTitle })).toContainText("PR #42 · Chat polish");
  const message = group(page, "Messages").getByRole("option");
  await expect(message).toHaveCount(1);
  await expect(message).toContainText("make the chat calmer");
  await expect(message).toContainText(secondTitle);
  await expect(message.locator("mark")).toHaveText("chat");
  // The order of sections on screen: Projects, Sessions, Messages.
  await expect(dialog(page).getByRole("group")).toHaveText([/^Projects/, /^Sessions/, /^Messages/]);
  expect(asked).toEqual(["chat"]);
  await input(page).fill("zzzz-nothing");
  await expect(dialog(page)).toContainText("No results for “zzzz-nothing”");
});

test("a failing search route counts as no hits; local matches still show", async ({ page }) => {
  await setupPortal(page);
  await page.route("**/api/search**", (route) => route.fulfill({ status: 500, body: "boom" }));
  await page.goto("/");
  await hydrated(page);
  await openSearch(page);
  await input(page).fill("investigate");
  await expect(group(page, "Sessions").getByRole("option")).toHaveText([/Investigate long session/]);
  await expect(group(page, "Messages")).toHaveCount(0);
});

test("arrow down and enter open a session, which then leads the Recent section", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  await hydrated(page);
  await openSearch(page);
  await input(page).fill("chat");
  // The project row is selected first; one step down is the first session.
  await expect(group(page, "Projects").getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(group(page, "Sessions").getByRole("option", { name: firstTitle })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/tabs\/w2$/);
  await expect(strip(page).getByRole("tab", { name: firstTitle })).toHaveAttribute("aria-selected", "true");
  // Reopened: the session is under Recent, and arrow up wraps to the last row.
  await openSearch(page);
  await expect(group(page, "Recent").getByRole("option")).toHaveText([new RegExp(firstTitle)]);
  await page.keyboard.press("ArrowUp");
  await expect(group(page, "Recent sessions").getByRole("option").last()).toHaveAttribute("aria-selected", "true");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("slash opens search as a bottom sheet", async ({ page }) => {
    await setupPortal(page);
    await page.goto("/sessions/s1");
    await expect(page).toHaveURL(tabUrl);
    await openSearch(page);
    await expect(input(page)).toBeFocused();
    await input(page).fill("investigate");
    await group(page, "Sessions").getByRole("option", { name: secondTitle }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(tabUrl);
    await expect(page.locator('[data-pane][data-session="s2"]')).toBeVisible();
  });
});

test("a pending query shows neither the last query's PR hits nor an empty state", async ({ page }) => {
  await setupPortal(page, {
    search: (q) =>
      q === "42"
        ? { messages: [], pulls: [{ sessionId: "s3", via: "branch", pull: { repo: "o/portal", number: 42, url: "https://x" } }] }
        : { messages: [], pulls: [] },
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  // `423` answers only when the test says so; the fixture answers everything else.
  await page.route((url) => url.pathname === "/api/search" && url.searchParams.get("q") === "423", async (route) => {
    await held;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ q: "423", messages: [], pulls: [] }) });
  });
  await page.goto("/");
  await hydrated(page);
  await openSearch(page);
  await input(page).fill("42");
  await expect(group(page, "Sessions").getByRole("option", { name: thirdTitle })).toContainText("PR #42");
  await input(page).fill("423");
  // The PR hit was for #42: gone at once, so Enter cannot open it; no "No results" while #423 is asked.
  await expect(group(page, "Sessions")).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(dialog(page)).not.toContainText("No results");
  release();
  await expect(dialog(page)).toContainText("No results for “423”");
});

test("slash and command-K do nothing while Settings is open", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  await hydrated(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await openSearch(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.waitForTimeout(200);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("[data-search-dialog], [data-agent-dialog]")).toHaveCount(0);
  await expect(settings).toBeVisible();
});
