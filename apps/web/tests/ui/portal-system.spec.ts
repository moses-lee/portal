import { expect, test } from "@playwright/test";
import { emitPortal, setupPortal } from "./fixtures";
import { coreDocument, grants, worldResponse } from "./orchestrator-fixtures";

test("System shows CORE.md and the world exactly as the model sees them, with readable tables", async ({ page }, info) => {
  const fixture = await setupPortal(page, { portal: { grants } });
  await page.goto("/system");
  const view = page.getByRole("region", { name: "System" });
  await expect(view.getByLabel("CORE.md contents")).toHaveText(coreDocument.text);
  await expect(view.getByText(/64 tokens · generated 5 min ago/)).toBeVisible();

  await expect(view.getByText(/1.4k tokens · built 2 min ago/)).toBeVisible();
  const projects = view.getByRole("table", { name: "Projects" });
  await expect(projects.getByRole("row")).toHaveCount(3);
  await expect(projects).toContainText("improve-chat-experience");
  await expect(projects).toContainText("Dirty");
  const sessions = view.getByRole("table", { name: "Sessions" });
  await expect(sessions).toContainText("Improve the chat experience");
  await expect(sessions).toContainText("working");
  const pulls = view.getByRole("table", { name: "Pull requests" });
  await expect(pulls.getByRole("link", { name: /example\/portal#42/ })).toHaveAttribute("href", "https://github.com/example/portal/pull/42");
  await expect(pulls).toContainText("failing");
  await page.screenshot({ animations: "disabled", fullPage: true, path: info.outputPath("system.png") });

  await view.getByRole("tab", { name: "As the model sees it" }).click();
  await expect(view.getByLabel("World as the model sees it")).toHaveText(worldResponse.rendered);

  await view.getByRole("button", { name: "Refresh" }).click();
  await expect(view.getByText(/tokens · built just now/)).toBeVisible();
  expect(fixture.requests.some((r) => r.path === "/api/portal/world/refresh" && r.method === "POST")).toBe(true);

  // A `world` event from a rebuild elsewhere refetches.
  const loads = () => fixture.requests.filter((r) => r.path === "/api/portal/world" && r.method === "GET").length;
  const before = loads();
  await emitPortal(page, { type: "world", at: Date.now() + 1000 });
  await expect.poll(loads).toBe(before + 1);
});

test("approval grants in force are listed and revocable", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: { grants } });
  await page.goto("/system");
  const view = page.getByRole("region", { name: "System" });
  // The revoked grant is not listed.
  const grant = view.getByRole("listitem", { name: "Grant for remove_worktree" });
  await expect(grant).toContainText("In example/portal");
  await expect(view.getByRole("listitem", { name: "Grant for run_shell" })).toHaveCount(0);
  await grant.getByRole("button", { name: "Revoke" }).click();
  await expect(grant).toHaveCount(0);
  await expect(view.getByText("No standing grants. Every gated action asks first.")).toBeVisible();
  expect(fixture.requests.some((r) => r.path === "/api/portal/approvals/grants/g1" && r.method === "DELETE")).toBe(true);
});
