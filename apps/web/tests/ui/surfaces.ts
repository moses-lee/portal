import { expect, type Page } from "@playwright/test";

type PageView = "attention" | "watches" | "activity" | "memory" | "system";
const titles: Record<PageView, string> = {
  attention: "Needs your attention",
  watches: "Watches",
  activity: "Activity",
  memory: "Memory",
  system: "System",
};

/** Open a page through the same sidebar controls the user has, preserving the workspace URL. */
export async function showPage(page: Page, view: PageView) {
  const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
  if (view === "attention") {
    await sidebar.getByRole("button", { name: /Needs your attention|All caught up|Work in progress/ }).click();
  } else {
    await sidebar.getByRole("navigation", { name: "Portal", exact: true }).getByRole("button", { name: titles[view], exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: titles[view], level: 1, exact: true })).toBeVisible();
}

export async function openPage(page: Page, view: PageView) {
  await page.goto("/");
  await showPage(page, view);
}

export async function showAgent(page: Page) {
  await page.getByRole("complementary", { name: "Workspace sidebar" }).getByRole("button", { name: /^Agent/ }).click();
  await expect(page.getByRole("main", { name: "Agent", exact: true })).toBeVisible();
}

export async function showSettings(page: Page, section: string) {
  await page.getByRole("complementary", { name: "Workspace sidebar" }).getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: section, exact: true }).click();
  return dialog;
}

/** Enter Palace mode with the sidebar's logo (docs/GLASS.md) and wait for the panels to have gone. */
export async function enterPalace(page: Page) {
  await page.getByRole("complementary", { name: "Workspace sidebar" }).getByRole("button", { name: "Show the room" }).click();
  await expect(page.getByRole("button", { name: "Back to workspace" })).toBeFocused();
  await expect(page.locator(".portal-shell")).toHaveAttribute("data-palace-mode", "away");
}
