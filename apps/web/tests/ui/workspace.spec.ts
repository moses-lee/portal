import { expect, test, type Page } from "@playwright/test";
import { firstTitle, makeSession, secondTitle, sessions, setupPortal, thirdTitle } from "./fixtures";
import { pane, split, tab, workspaceOf } from "./workspace-fixtures";

/**
 * The workspace (docs/WORKSPACE.md): tabs and split panes on a desktop viewport. The fixture answers
 * `GET /api/workspace`, runs `POST /api/workspace/ops` through the shared reducer (ids `w1`, `w2`, ...
 * in the order the reducer draws them) and pushes the result on the portal stream, as the server does.
 */

const strip = (page: Page) => page.getByRole("tablist", { name: "Workspace tabs" });
const paneOf = (page: Page, id: string) => page.locator(`[data-pane="${id}"]`);
const frames = (page: Page) => page.locator("[data-pane-frame]");
/** The pane with the focus ring; none in a single-pane tab. */
const focusedFrame = (page: Page) => page.locator("[data-pane-frame][data-focused]");
const ops = (fixture: { requests: { path: string; body: unknown }[] }) =>
  fixture.requests.filter((request) => request.path === "/api/workspace/ops").map((request) => request.body);

test("sidebar rows open sessions as tabs; the strip shows each with its icon, and other open sessions get the glyph", async ({ page }) => {
  const fixture = await setupPortal(page);
  await page.goto("/sessions/s1");
  // The resolver opened a tab for the session (pane w1, tab w2) and rewrote the URL.
  await expect(page).toHaveURL(/\/tabs\/w2$/);
  const tabs = strip(page).getByRole("tab");
  await expect(tabs).toHaveCount(1);
  await page.getByRole("button", { name: secondTitle, exact: true }).click();
  await expect(page).toHaveURL(/\/tabs\/w4$/);
  await expect(tabs).toHaveCount(2);
  const first = strip(page).getByRole("tab", { name: firstTitle });
  const second = strip(page).getByRole("tab", { name: secondTitle });
  await expect(first).toHaveAttribute("aria-selected", "false");
  await expect(second).toHaveAttribute("aria-selected", "true");
  // Each icon: one cell holding the session's state dot, the sidebar's vocabulary.
  await expect(first.locator(".status-dot")).toHaveCount(1);
  await expect(second.locator(".status-dot")).toHaveCount(1);
  // The focused tab's pane is on screen; the other stays mounted but hidden.
  await expect(paneOf(page, "w3")).toBeVisible();
  await expect(paneOf(page, "w1")).toBeHidden();
  // Sidebar: the focused session is current; the other open one carries the tab glyph; a closed one neither.
  const firstRow = page.getByRole("button", { name: firstTitle, exact: true });
  const secondRow = page.getByRole("button", { name: secondTitle, exact: true });
  const thirdRow = page.getByRole("button", { name: thirdTitle, exact: true });
  await expect(secondRow).toHaveAttribute("aria-current", "page");
  await expect(firstRow).not.toHaveAttribute("aria-current", "page");
  await expect(firstRow.getByLabel("Open in the workspace")).toHaveCount(1);
  await expect(secondRow.getByLabel("Open in the workspace")).toHaveCount(0);
  await expect(thirdRow.getByLabel("Open in the workspace")).toHaveCount(0);
  // Opening a session that is already open focuses its tab instead of adding another.
  await firstRow.click();
  await expect(page).toHaveURL(/\/tabs\/w2$/);
  await expect(tabs).toHaveCount(2);
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(firstRow.getByLabel("Open in the workspace")).toHaveCount(0);
  await expect(secondRow.getByLabel("Open in the workspace")).toHaveCount(1);
  expect(ops(fixture)).toEqual([
    { op: "open", sessionId: "s1" },
    { op: "open", sessionId: "s2" },
  ]);
});

test("split right opens a start-page pane beside the session; pointer down in a pane moves the focus in the URL", async ({ page }) => {
  const fixture = await setupPortal(page, { workspace: workspaceOf([tab("t1", pane("p1", "s1"))]) });
  await page.goto("/tabs/t1");
  await expect(paneOf(page, "p1")).toBeVisible();
  // A single pane: no ring, no `?pane=`.
  await expect(focusedFrame(page)).toHaveCount(0);
  await paneOf(page, "p1").getByRole("button", { name: "Pane options" }).click();
  await page.getByRole("menuitem", { name: "Split right" }).click();
  // The new pane (w1) is a start page and takes the focus; the two sit side by side.
  await expect(page).toHaveURL(/\/tabs\/t1\?pane=w1$/);
  await expect(frames(page)).toHaveCount(2);
  await expect(paneOf(page, "w1").getByRole("textbox", { name: "First message" })).toBeVisible();
  await expect(focusedFrame(page)).toHaveAttribute("data-pane-frame", "w1");
  await expect(page.getByRole("separator", { name: "Resize panes side by side" })).toBeVisible();
  expect(ops(fixture)).toEqual([{ op: "open", sessionId: null, target: { tabId: "t1", paneId: "p1", edge: "right" } }]);
  // The strip's icon grew a cell (hollow for the start page).
  await expect(strip(page).getByRole("tab", { name: firstTitle }).locator("span[aria-hidden] > span")).toHaveCount(2);
  // Pointer down in the session's pane focuses it: the URL follows and the ring moves.
  await page.getByText("A calmer place to work", { exact: true }).click();
  await expect(page).toHaveURL(/\/tabs\/t1\?pane=p1$/);
  await expect(focusedFrame(page)).toHaveAttribute("data-pane-frame", "p1");
  // The sidebar's "Open beside current" splits the focused pane to the right with the session.
  await page.getByRole("button", { name: `Actions for ${secondTitle}` }).click();
  await page.getByRole("menuitem", { name: "Open beside current" }).click();
  await expect(frames(page)).toHaveCount(3);
  await expect(page).toHaveURL(/\/tabs\/t1\?pane=w3$/);
  await expect(paneOf(page, "w3")).toHaveAttribute("data-session", "s2");
  expect(ops(fixture).at(-1)).toEqual({ op: "open", sessionId: "s2", target: { tabId: "t1", paneId: "p1", edge: "right" } });
});

test("the pane menu disables splits the workspace would refuse: depth in a one-beside-two tab, the pane cap in a grid", async ({ page }) => {
  await setupPortal(page, {
    workspace: workspaceOf([
      tab("t1", split("x1", "row", [pane("p1", "s1"), split("x2", "column", [pane("p2", "s2"), pane("p3", "s3")])])),
      tab("t2", split("g1", "column", [split("g2", "row", [pane("q1", null), pane("q2", null)]), split("g3", "row", [pane("q3", null), pane("q4", null)])])),
    ]),
  });
  await page.goto("/tabs/t1?pane=p2");
  const splitRight = page.getByRole("menuitem", { name: "Split right" });
  const splitDown = page.getByRole("menuitem", { name: "Split down" });
  // p2 sits in a column under the root row: another row inside would nest three deep; a sibling below fits.
  await paneOf(page, "p2").getByRole("button", { name: "Pane options" }).click();
  await expect(splitRight).toHaveAttribute("aria-disabled", "true");
  await expect(splitDown).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  // p1 is a child of the root row: a sibling to its right, or a new column in its place, both fit.
  await paneOf(page, "p1").getByRole("button", { name: "Pane options" }).click();
  await expect(splitRight).not.toHaveAttribute("aria-disabled", "true");
  await expect(splitDown).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  // The grid is full: nothing splits, and the sidebar's "Open beside current" is off too.
  await page.goto("/tabs/t2?pane=q1");
  await paneOf(page, "q1").getByRole("button", { name: "Pane options" }).click();
  await expect(splitRight).toHaveAttribute("aria-disabled", "true");
  await expect(splitDown).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `Actions for ${firstTitle}` }).click();
  await expect(page.getByRole("menuitem", { name: "Open beside current" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("menuitem", { name: "Open in new tab" })).not.toHaveAttribute("aria-disabled", "true");
});

test("closing a pane shrinks its split, then collapses it; closing the last pane closes the tab", async ({ page }) => {
  const fixture = await setupPortal(page, {
    workspace: workspaceOf([tab("t1", split("x1", "row", [pane("p1", "s1"), pane("p2", "s2"), pane("p3", "s3")], [40, 30, 30]))]),
  });
  await page.goto("/tabs/t1?pane=p3");
  await expect(frames(page)).toHaveCount(3);
  await expect(focusedFrame(page)).toHaveAttribute("data-pane-frame", "p3");
  const separators = page.getByRole("separator", { name: "Resize panes side by side" });
  await expect(separators).toHaveCount(2);
  // Three to two: the row stays, one separator fewer; the focus falls back to the first pane.
  await paneOf(page, "p3").getByRole("button", { name: "Pane options" }).click();
  await page.getByRole("menuitem", { name: "Close pane" }).click();
  await expect(frames(page)).toHaveCount(2);
  await expect(separators).toHaveCount(1);
  await expect(focusedFrame(page)).toHaveAttribute("data-pane-frame", "p1");
  // Two to one: the split collapses into the pane.
  await paneOf(page, "p2").getByRole("button", { name: "Pane options" }).click();
  await page.getByRole("menuitem", { name: "Close pane" }).click();
  await expect(frames(page)).toHaveCount(1);
  await expect(paneOf(page, "p1")).toBeVisible();
  await expect(separators).toHaveCount(0);
  await expect(focusedFrame(page)).toHaveCount(0);
  // One tab, named after the remaining session, one cell in its icon.
  await expect(strip(page).getByRole("tab")).toHaveCount(1);
  await expect(strip(page).getByRole("tab", { name: firstTitle }).locator("span[aria-hidden] > span")).toHaveCount(1);
  expect(ops(fixture)).toEqual([
    { op: "close_pane", paneId: "p3" },
    { op: "close_pane", paneId: "p2" },
  ]);
  // The session itself is untouched.
  expect(fixture.requests.some((request) => request.method === "DELETE" && request.path.startsWith("/api/sessions/"))).toBe(false);
  // The last pane: the tab goes, and an empty workspace is the start page without a strip.
  await paneOf(page, "p1").getByRole("button", { name: "Pane options" }).click();
  await page.getByRole("menuitem", { name: "Close pane" }).click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(strip(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "First message" })).toBeVisible();
});

test("a tab is renamed inline from its menu; Escape cancels; the default name comes back on request", async ({ page }) => {
  const fixture = await setupPortal(page, { workspace: workspaceOf([tab("t1", split("x1", "row", [pane("p1", "s1"), pane("p2", "s2")]))]) });
  await page.goto("/tabs/t1");
  const combined = `${firstTitle} + ${secondTitle}`;
  await expect(strip(page).getByRole("tab", { name: combined })).toBeVisible();
  await strip(page).getByRole("tab", { name: combined }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: "Tab name" });
  await expect(field).toBeFocused();
  await field.fill("Review pair");
  await field.press("Enter");
  await expect(strip(page).getByRole("tab", { name: "Review pair" })).toBeVisible();
  await expect(strip(page).getByRole("tab")).toHaveCount(1);
  expect(ops(fixture)).toEqual([{ op: "rename_tab", tabId: "t1", title: "Review pair", source: "user" }]);
  // Escape leaves the name as it was and sends nothing.
  await strip(page).getByRole("tab", { name: "Review pair" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Tab name" }).fill("Discarded");
  await page.keyboard.press("Escape");
  await expect(strip(page).getByRole("tab", { name: "Review pair" })).toBeVisible();
  expect(ops(fixture)).toHaveLength(1);
  // Back to the default: the sessions' titles.
  await strip(page).getByRole("tab", { name: "Review pair" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Use the default name" }).click();
  await expect(strip(page).getByRole("tab", { name: combined })).toBeVisible();
  expect(ops(fixture).at(-1)).toEqual({ op: "rename_tab", tabId: "t1", title: null, source: "user" });
});

test("a layout preset from the tab menu rearranges the tab; a smaller preset moves the extra session to its own tab", async ({ page }) => {
  const fixture = await setupPortal(page, { workspace: workspaceOf([tab("t1", split("x1", "row", [pane("p1", "s1"), pane("p2", "s2")]))]) });
  await page.goto("/tabs/t1?pane=p2");
  await expect(page.getByRole("separator", { name: "Resize panes side by side" })).toBeVisible();
  const openLayouts = async () => {
    await strip(page).getByRole("tab", { selected: true }).click({ button: "right" });
    const layout = page.getByRole("menuitem", { name: "Layout" });
    await layout.hover();
    await layout.click();
  };
  // The presets are a radio group: the current layout is the checked item.
  await openLayouts();
  await expect(page.getByRole("menuitemradio", { name: "Two columns" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Two rows" }).click();
  await expect(page.getByRole("separator", { name: "Resize stacked panes" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize panes side by side" })).toHaveCount(0);
  // Both sessions stay, in order, in the rebuilt tab (split w1, panes w2 and w3); the focus lands on its first pane.
  await expect(page.locator("[data-pane][data-session]")).toHaveCount(2);
  await expect(paneOf(page, "w2")).toHaveAttribute("data-session", "s1");
  await expect(paneOf(page, "w3")).toHaveAttribute("data-session", "s2");
  await expect(page).toHaveURL(/\/tabs\/t1\?pane=w2$/);
  expect(ops(fixture)).toEqual([{ op: "arrange", tabId: "t1", preset: "rows-2", sessionIds: ["s1", "s2"] }]);
  // Single holds one: the second session overflows to a tab of its own, right after this one.
  await openLayouts();
  await expect(page.getByRole("menuitemradio", { name: "Two rows" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Single" }).click();
  const tabs = strip(page).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveText(firstTitle);
  await expect(tabs.nth(1)).toHaveText(secondTitle);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/tabs\/t1$/);
  await expect(frames(page)).toHaveCount(1);
  expect(ops(fixture).at(-1)).toEqual({ op: "arrange", tabId: "t1", preset: "single", sessionIds: ["s1"] });
});

test("a workspace event from another device rearranges the view; this device's focus stays where it was", async ({ page }) => {
  const fixture = await setupPortal(page, { workspace: workspaceOf([tab("t1", pane("p1", "s1")), tab("t2", pane("p2", "s2"))]) });
  await page.goto("/tabs/t1");
  await expect(strip(page).getByRole("tab", { name: firstTitle })).toHaveAttribute("aria-selected", "true");
  // The phone splits this tab beside a third session and names the other one; the stream carries the copy.
  await fixture.pushWorkspace(
    workspaceOf(
      [
        tab("t1", split("x1", "row", [pane("p1", "s1"), pane("p3", "s3")])),
        tab("t2", pane("p2", "s2"), { title: "From the phone", titleSource: "user" }),
      ],
      2,
    ),
  );
  await expect(frames(page)).toHaveCount(2);
  await expect(paneOf(page, "p3")).toHaveAttribute("data-session", "s3");
  await expect(strip(page).getByRole("tab", { name: "From the phone" })).toBeVisible();
  const renamed = strip(page).getByRole("tab", { name: `${firstTitle} + ${thirdTitle}` });
  await expect(renamed).toHaveAttribute("aria-selected", "true");
  // The URL did not move: still this tab, and its first pane has the focus.
  await expect(page).toHaveURL(/\/tabs\/t1$/);
  await expect(focusedFrame(page)).toHaveAttribute("data-pane-frame", "p1");
  expect(ops(fixture)).toHaveLength(0);
  // The other device closes the tab we are on: the first remaining tab takes over.
  await fixture.pushWorkspace(workspaceOf([tab("t2", pane("p2", "s2"), { title: "From the phone", titleSource: "user" })], 3));
  await expect(page).toHaveURL(/\/tabs\/t2$/);
  await expect(paneOf(page, "p2")).toBeVisible();
  await expect(strip(page).getByRole("tab")).toHaveCount(1);
});

test("/sessions/<id> focuses the tab and pane holding the session, or opens a tab, and rewrites the URL", async ({ page }) => {
  const fixture = await setupPortal(page, {
    sessions: [...sessions, makeSession("s4", "A fourth conversation")],
    workspace: workspaceOf([tab("t1", pane("p1", "s1")), tab("t2", split("x1", "row", [pane("p2", "s2"), pane("p3", "s3")]))]),
  });
  await page.goto("/sessions/s3");
  await expect(page).toHaveURL(/\/tabs\/t2\?pane=p3$/);
  await expect(strip(page).getByRole("tab", { name: `${secondTitle} + ${thirdTitle}` })).toHaveAttribute("aria-selected", "true");
  await expect(focusedFrame(page)).toHaveAttribute("data-pane-frame", "p3");
  await expect(paneOf(page, "p3").getByRole("combobox", { name: "Message Codex" })).toBeVisible();
  // A single-pane tab: no `?pane=`.
  await page.goto("/sessions/s1");
  await expect(page).toHaveURL(/\/tabs\/t1$/);
  await expect(paneOf(page, "p1").getByRole("combobox", { name: "Message Claude Code" })).toBeVisible();
  expect(ops(fixture)).toHaveLength(0);
  // A session open nowhere gets a tab at the end of the strip.
  await page.goto("/sessions/s4");
  await expect(page).toHaveURL(/\/tabs\/w2$/);
  await expect(strip(page).getByRole("tab")).toHaveCount(3);
  await expect(strip(page).getByRole("tab", { name: "A fourth conversation" })).toHaveAttribute("aria-selected", "true");
  expect(ops(fixture)).toEqual([{ op: "open", sessionId: "s4" }]);
});

test("/new opens a start-page tab whose pane becomes the new session's; + reuses the focused tab's start page, a later /new focuses the existing one", async ({ page }) => {
  const fixture = await setupPortal(page, { workspace: workspaceOf([tab("t1", pane("p1", "s1"))]) });
  await page.goto("/new");
  await expect(page).toHaveURL(/\/tabs\/w2$/);
  const tabs = strip(page).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveText("New session");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  const startPane = paneOf(page, "w1");
  await startPane.getByRole("textbox", { name: "First message" }).fill("Build a project dashboard");
  await startPane.getByRole("button", { name: "Send message", exact: true }).click();
  // Same tab, same pane, now the session's; the strip did not grow.
  await expect(page.locator('[data-pane="w1"][data-session="created"]')).toBeVisible();
  await expect(page).toHaveURL(/\/tabs\/w2$/);
  await expect(tabs).toHaveCount(2);
  await expect(startPane.getByRole("combobox", { name: "Message Claude Code" })).toBeVisible();
  expect(ops(fixture)).toEqual([
    { op: "open", sessionId: null },
    { op: "replace_pane", paneId: "w1", sessionId: "created" },
  ]);
  // The strip's + opens another start page (pane w3, tab w4). Every "new session" entry reuses a
  // start-page pane only when it is in the focused tab: + again stays on w4 with no op.
  await strip(page).getByRole("button", { name: "New tab" }).click();
  await expect(page).toHaveURL(/\/tabs\/w4$/);
  await expect(tabs).toHaveCount(3);
  await strip(page).getByRole("button", { name: "New tab" }).click();
  await expect(page).toHaveURL(/\/tabs\/w4$/);
  await expect(tabs).toHaveCount(3);
  // `/new` from another tab focuses the existing start page (decision 7): no new tab, no op.
  await tabs.nth(0).click();
  await expect(page).toHaveURL(/\/tabs\/t1$/);
  await page.evaluate(() => window.history.pushState(null, "", "/new"));
  await expect(page).toHaveURL(/\/tabs\/w4$/);
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(paneOf(page, "w3").getByRole("textbox", { name: "First message" })).toBeVisible();
  expect(ops(fixture)).toHaveLength(3);
});

test("a hidden tab gets the unread ring when its session's turn ends, and loses it when focused", async ({ page }) => {
  await setupPortal(page, { workspace: workspaceOf([tab("t1", pane("p1", "s1")), tab("t2", pane("p2", "s2"))]) });
  await page.goto("/tabs/t1");
  const first = strip(page).getByRole("tab", { name: firstTitle });
  const second = strip(page).getByRole("tab", { name: secondTitle });
  await expect(second).toBeVisible();
  const ring = second.locator("[data-unread]");
  await expect(ring).toHaveCount(0);
  // The session list reports that s2's turn ended (its agent answered while this tab was away).
  await page.evaluate(() => window.__portalEmit("/api/sessions/stream", { type: "updated", id: "s2", patch: { turnEndedAt: Date.now() } }, "message"));
  await expect(ring).toHaveCount(1);
  await expect(strip(page).getByRole("tab", { name: /, unread$/ })).toHaveCount(1);
  // The tab on screen is never news.
  await page.evaluate(() => window.__portalEmit("/api/sessions/stream", { type: "updated", id: "s1", patch: { turnEndedAt: Date.now() } }, "message"));
  await expect(first.locator("[data-unread]")).toHaveCount(0);
  // Focusing the tab reads it.
  await second.click();
  await expect(page).toHaveURL(/\/tabs\/t2$/);
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(ring).toHaveCount(0);
  await expect(strip(page).getByRole("tab", { name: /, unread$/ })).toHaveCount(0);
});

test("each pane has its own terminal: both can be open at once, and hiding one leaves the other", async ({ page }) => {
  const fixture = await setupPortal(page, { workspace: workspaceOf([tab("t1", split("x1", "row", [pane("p1", "s1"), pane("p2", "s2")]))]) });
  await page.goto("/tabs/t1?pane=p1");
  const left = paneOf(page, "p1");
  const right = paneOf(page, "p2");
  const leftTerminal = left.getByRole("region", { name: "Terminal" });
  const rightTerminal = right.getByRole("region", { name: "Terminal" });
  await left.getByRole("button", { name: "Show terminal" }).click();
  await expect(leftTerminal).toBeVisible();
  await expect(rightTerminal).toHaveCount(0);
  await expect(right.getByRole("button", { name: "Show terminal" })).toHaveAttribute("aria-expanded", "false");
  await right.getByRole("button", { name: "Show terminal" }).click();
  await expect(rightTerminal).toBeVisible();
  await expect(page.getByRole("region", { name: "Terminal" })).toHaveCount(2);
  // Each panel lists its own session's terminals.
  const listed = fixture.requests.filter((request) => request.path.endsWith("/terminals") && request.method === "GET").map((request) => request.path);
  expect(listed).toContain("/api/sessions/s1/terminals");
  expect(listed).toContain("/api/sessions/s2/terminals");
  // Hiding the left one from its panel leaves the right one; focus returns to the left toggle.
  await leftTerminal.getByRole("button", { name: "Hide terminal" }).click();
  await expect(leftTerminal).toHaveCount(0);
  await expect(rightTerminal).toBeVisible();
  await expect(left.getByRole("button", { name: "Show terminal" })).toBeFocused();
});

test("tabs reorder by dragging along the strip, or by Space and the arrow keys; each move is one move_tab", async ({ page }) => {
  const fixture = await setupPortal(page, {
    workspace: workspaceOf([tab("t1", pane("p1", "s1")), tab("t2", pane("p2", "s2")), tab("t3", pane("p3", "s3"))]),
  });
  await page.goto("/tabs/t1");
  const order = () => strip(page).getByRole("tab").evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-trigger")));
  await expect.poll(order).toEqual(["t1", "t2", "t3"]);
  // Every tab has one width, whatever its name.
  const widths = await strip(page).locator("[data-tab]").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  expect(new Set(widths).size).toBe(1);
  // Drag the last tab to the front.
  const from = (await strip(page).locator('[data-tab="t3"]').boundingBox())!;
  const to = (await strip(page).locator('[data-tab="t1"]').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 8, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(order).toEqual(["t3", "t1", "t2"]);
  expect(ops(fixture)).toEqual([{ op: "move_tab", tabId: "t3", index: 0 }]);
  // Keyboard: Space picks the focused tab up, an arrow moves it, Space drops it; the focus stays on it.
  const first = strip(page).getByRole("tab", { name: firstTitle });
  await first.focus();
  await page.keyboard.press("Space");
  await expect(strip(page).locator('[data-tab="t1"]')).toHaveAttribute("data-dragging", "true");
  await expect(page.getByRole("status").filter({ hasText: /^Tab .* moved to position 2 of 3\.$/ })).toHaveCount(1);
  // An arrow pressed before the sensor has measured the strip is dropped; at the end of the strip a repeat does nothing.
  await expect(async () => {
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("status").filter({ hasText: /^Tab .* moved to position 3 of 3\.$/ })).toHaveCount(1, { timeout: 500 });
  }).toPass();
  await page.keyboard.press("Space");
  await expect.poll(order).toEqual(["t3", "t2", "t1"]);
  expect(ops(fixture).at(-1)).toEqual({ op: "move_tab", tabId: "t1", index: 2 });
  await expect(first).toBeFocused();
  // A plain click still just selects.
  await strip(page).getByRole("tab", { name: secondTitle }).click();
  await expect(page).toHaveURL(/\/tabs\/t2$/);
  expect(ops(fixture)).toHaveLength(2);
  // A press on the close button never drags: sliding off it neither moves nor closes the tab.
  const close = (await strip(page).getByRole("button", { name: `Close tab ${secondTitle}` }).boundingBox())!;
  await page.mouse.move(close.x + close.width / 2, close.y + close.height / 2);
  await page.mouse.down();
  await page.mouse.move(close.x - 150, close.y + close.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(order).toEqual(["t3", "t2", "t1"]);
  expect(ops(fixture)).toHaveLength(2);
});

test("right-clicking a tab opens its menu without selecting it; Shift+F10 opens it from the keyboard; tabs have no … button", async ({ page }) => {
  const fixture = await setupPortal(page, { workspace: workspaceOf([tab("t1", pane("p1", "s1")), tab("t2", pane("p2", "s2"))]) });
  await page.goto("/tabs/t1");
  await expect(strip(page).getByRole("tab", { name: firstTitle })).toBeVisible();
  await expect(strip(page).getByRole("button", { name: /^Tab menu for / })).toHaveCount(0);
  // The keyboard way in: Shift+F10 on the focused tab, and Escape hands focus back to it.
  await strip(page).getByRole("tab", { name: firstTitle }).focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  // A right-click inside the open menu stays there: no second menu from the tab behind it.
  await page.getByRole("menuitem", { name: "Rename" }).click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(strip(page).getByRole("tab", { name: firstTitle })).toBeFocused();
  await strip(page).getByRole("tab", { name: secondTitle }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: "Tab name" });
  await expect(field).toBeFocused();
  await field.fill("Second");
  await field.press("Enter");
  await expect(strip(page).getByRole("tab", { name: "Second" })).toBeVisible();
  await expect(page).toHaveURL(/\/tabs\/t1$/);
  expect(ops(fixture)).toEqual([{ op: "rename_tab", tabId: "t2", title: "Second", source: "user" }]);
  // The same items as the … menu, Layout included.
  await strip(page).getByRole("tab", { name: "Second" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Layout" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Close tab" }).click();
  await expect(strip(page).getByRole("tab")).toHaveCount(1);
  expect(ops(fixture).at(-1)).toEqual({ op: "close_tab", tabId: "t2" });
});

test("a sidebar row and a pane header open their menus on right-click as well", async ({ page }) => {
  const fixture = await setupPortal(page, { workspace: workspaceOf([tab("t1", pane("p1", "s1"))]) });
  await page.goto("/tabs/t1");
  await page.getByRole("button", { name: secondTitle, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in new tab" }).click();
  await expect(strip(page).getByRole("tab")).toHaveCount(2);
  expect(ops(fixture)).toEqual([{ op: "arrange", preset: "single", sessionIds: ["s2"] }]);
  await page.goto("/tabs/t1");
  await paneOf(page, "p1").locator("header.workspace-header").click({ button: "right", position: { x: 4, y: 4 } });
  await page.getByRole("menuitem", { name: "Split right" }).click();
  await expect(page.getByRole("separator", { name: "Resize panes side by side" })).toBeVisible();
});
