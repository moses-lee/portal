import { expect, test, type Page } from "@playwright/test";
import { portalMessages, setupPortal, tabUrl } from "./fixtures";
import type { OrchestratorMessage } from "../../src/lib/orchestrator/types";

/**
 * The search dialog's Portal tab (docs/SEARCH.md, "Portal tab"): ⌘J / Ctrl+J opens the
 * orchestrator's main thread over any page; ⌘K / Ctrl+K and ⌘J switch between the tabs, and the
 * open tab's own key closes the dialog.
 */

const palette = (page: Page) => page.locator("[data-search-dialog]");
const tab = (page: Page, name: "Search" | "Portal") => palette(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const portalComposer = (page: Page) => palette(page).getByRole("textbox", { name: "Message Portal" });
const searchInput = (page: Page) => palette(page).getByRole("combobox", { name: "Search" });
/** The sidebar's shortcut hint renders only once the page has hydrated, and the shortcut listener with it. */
const hydrated = (page: Page) => expect(page.getByText(/^(⌘K|Ctrl K)$/)).toBeVisible();

test("⌘J opens Portal over a session, sends with the session in view, and ⌘J closes it back to the composer", async ({ page }) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  await expect(page).toHaveURL(tabUrl);
  const composer = page.getByLabel("Message Claude Code", { exact: true });
  await hydrated(page);
  await composer.click();
  await expect(composer).toBeFocused();
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByRole("dialog", { name: "Portal" })).toBeVisible();
  await expect(tab(page, "Portal")).toHaveAttribute("aria-selected", "true");
  // The main thread's history, and its composer focused.
  await expect(palette(page).getByText("Nothing yet. I will keep an eye on your pull requests.")).toBeVisible();
  await expect(portalComposer(page)).toBeFocused();
  await page.keyboard.type("What is this session doing?");
  await page.keyboard.press("Enter");
  await expect(palette(page).getByText("Portal reply to: What is this session doing?")).toBeVisible();
  await expect(portalComposer(page)).toHaveValue("");
  const sent = fixture.requests.filter((request) => request.path === "/api/portal/messages" && request.method === "POST");
  expect(sent).toHaveLength(1);
  // What the user is looking at goes with the message, as from the Portal page.
  expect((sent[0].body as { view: { sessionId: string | null } }).view.sessionId).toBe("s1");
  await page.keyboard.press("ControlOrMeta+j");
  await expect(palette(page)).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
});

test("⌘K and ⌘J switch tabs; each tab keeps its state while the dialog stays open", async ({ page }) => {
  await setupPortal(page);
  await page.goto("/");
  await hydrated(page);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(searchInput(page)).toBeFocused();
  await expect(tab(page, "Search")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.type("chat");
  // ⌘J from the search box: Portal, its composer focused.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(tab(page, "Portal")).toHaveAttribute("aria-selected", "true");
  await expect(searchInput(page)).toBeHidden();
  await expect(portalComposer(page)).toBeFocused();
  await page.keyboard.type("half a thought");
  // ⌘K back: the query is still there; clicking Portal: so is the draft.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(searchInput(page)).toBeFocused();
  await expect(searchInput(page)).toHaveValue("chat");
  await tab(page, "Portal").click();
  await expect(portalComposer(page)).toHaveValue("half a thought");
  // Arrow keys move along the tab strip.
  await tab(page, "Portal").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Search")).toBeFocused();
  await expect(tab(page, "Search")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  // The draft is the thread's: the Portal page under the dialog has it too.
  await expect(page.getByRole("textbox", { name: "Message Portal" })).toHaveValue("half a thought");
});

test("an in-app link in a reply closes the dialog and goes there", async ({ page }) => {
  const linked: OrchestratorMessage = {
    id: "m-link",
    role: "assistant",
    metadata: { at: Date.now() - 60_000 },
    parts: [{ type: "text", text: "The [second session](/sessions/s2) is waiting on you." }],
  };
  await setupPortal(page, { portal: { messages: [...portalMessages, linked] } });
  await page.goto("/watches");
  await hydrated(page);
  await page.keyboard.press("ControlOrMeta+j");
  await palette(page).getByRole("link", { name: "second session" }).click();
  await expect(palette(page)).toHaveCount(0);
  await expect(page).toHaveURL(tabUrl);
  await expect(page.locator('[data-pane][data-session="s2"]')).toBeVisible();
});
