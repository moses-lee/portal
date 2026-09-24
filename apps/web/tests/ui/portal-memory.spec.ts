import { expect, test } from "@playwright/test";
import { emitPortal, setupPortal } from "./fixtures";
import { globalEntity, memoryRecords, memoryRevisions, octoEntity, repoEntity } from "./orchestrator-fixtures";

const portal = () => ({
  entities: [repoEntity, octoEntity, globalEntity],
  records: memoryRecords,
  revisions: memoryRevisions,
  status: { counts: { needsYou: 1, inbox: 1, approvals: 0, intents: 0 } },
});

test("the memory browser groups entities by type and shows each record with its provenance", async ({ page }, info) => {
  await setupPortal(page, { portal: portal() });
  await page.goto("/portal");
  await page.getByRole("navigation", { name: "Portal views" }).getByRole("button", { name: /Memory/ }).click();
  await expect(page).toHaveURL(/\/portal\/memory$/);
  const nav = page.getByRole("navigation", { name: "Memory" });
  // Contract order: global, people, repositories; each with its active-record total.
  const groups = nav.getByRole("group");
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0)).toHaveAccessibleName("Global");
  await expect(groups.nth(1)).toHaveAccessibleName("People");
  await expect(groups.nth(2)).toHaveAccessibleName("Repositories");
  await expect(groups.nth(2)).toContainText("2");
  await expect(nav.getByRole("button", { name: /Inbox/ })).toContainText("1");

  await nav.getByRole("button", { name: /example\/portal/ }).click();
  await expect(page).toHaveURL(/\/portal\/memory\/e-repo$/);
  const pane = page.getByRole("region", { name: "example/portal" });
  await expect(pane.getByRole("heading", { name: "example/portal" })).toBeVisible();
  await expect(pane.getByText("The Portal monorepo.")).toBeVisible();

  const inForce = pane.getByRole("region", { name: "In force (2)" });
  const tests = inForce.getByRole("article", { name: /^test-command/ });
  await expect(tests).toContainText("Run pnpm -r test before pushing.");
  await expect(tests).toContainText("You confirmed");
  await expect(tests).toContainText("Added in Portal");
  // Lineage: the superseded version, then this one.
  await expect(tests.getByLabel("Lineage")).toContainText("superseded");
  await expect(tests.getByLabel("Lineage")).toContainText("this");

  const ci = inForce.getByRole("article", { name: /^ci-provider/ });
  await expect(ci).toContainText("Observed");
  await expect(ci).toContainText("trust 60%");
  await expect(ci).toContainText("From a pull request");
  await expect(ci).toContainText("Workflow: ci.yml");
  await expect(ci.getByRole("link", { name: /Open/ })).toHaveAttribute("href", "https://github.com/example/portal/pull/42");
  await expect(ci).toContainText("review overdue since");
  // Only what the user said or confirmed can be pinned.
  await expect(ci.getByRole("button", { name: "Pin" })).toBeDisabled();

  // History is folded away but there.
  const history = pane.getByRole("region", { name: "History (1)" });
  await history.getByRole("button", { name: /History/ }).click();
  await expect(history.getByRole("article")).toContainText("Run pnpm test before pushing.");
  await page.screenshot({ animations: "disabled", fullPage: true, path: info.outputPath("memory.png") });

  // The revisions timeline shows who changed what.
  await tests.getByRole("button", { name: "Revisions" }).click();
  const timeline = tests.getByRole("list", { name: "Revisions of test-command" });
  await expect(timeline).toContainText("Superseded");
  await expect(timeline).toContainText("by user");
  await expect(timeline).toContainText("“The workspace needs -r”");
});

test("the inbox approves and rejects proposed records", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: portal() });
  await page.goto("/portal/memory");
  const inbox = page.getByRole("region", { name: "Memory browser" });
  const proposed = inbox.getByRole("article", { name: /^merge-style/ });
  await expect(proposed).toContainText("Prefers squash merges.");
  await expect(proposed).toContainText("octocat");
  await expect(proposed).toContainText("please squash this");
  // A repeat sighting from another source shows with the proposal, so the user sees the claim recur.
  await expect(proposed).toContainText("Seen 2 times");
  await expect(proposed).toContainText("squash on merge, as usual");
  await expect(proposed.getByText("From a pull request")).toBeVisible();
  await proposed.getByRole("button", { name: "Approve" }).click();
  await expect(inbox.getByText("Nothing waiting for review.")).toBeVisible();
  expect(fixture.requests.some((r) => r.path === "/api/portal/memory/records/r-prop/approve" && r.method === "POST")).toBe(true);

  // Another proposal arrives (a `memory` event refetches); reject it with a reason.
  fixture.orchestrator.records.push({ ...memoryRecords[4], id: "r-prop2", key: "timezone", body: "Works in CET.", status: "proposed" });
  await emitPortal(page, { type: "memory", recordIds: ["r-prop2"] });
  const next = inbox.getByRole("article", { name: /^timezone/ });
  await next.getByRole("button", { name: "Reject" }).click();
  await next.getByRole("textbox", { name: "Why reject it (optional)" }).fill("Not true");
  await next.getByRole("button", { name: "Reject" }).click();
  await expect(next).toHaveCount(0);
  expect(fixture.requests.find((r) => r.path === "/api/portal/memory/records/r-prop2/reject")?.body).toEqual({ reason: "Not true" });
});

test("editing supersedes, forgetting archives with a reason, and a new record can be added", async ({ page }) => {
  const fixture = await setupPortal(page, { portal: portal() });
  await page.goto("/portal/memory/e-global");
  const pane = page.getByRole("region", { name: "Global" });
  const style = pane.getByRole("article", { name: /^review-style/ });
  await expect(style.getByLabel("Pinned into CORE.md")).toBeVisible();
  await style.getByRole("button", { name: "Edit" }).click();
  await style.getByRole("textbox", { name: "Edit review-style" }).fill("Keep reviews short; blockers first, nits last.");
  await style.getByRole("button", { name: "Save" }).click();
  const updated = pane.getByRole("region", { name: "In force (1)" }).getByRole("article");
  await expect(updated).toContainText("Keep reviews short; blockers first, nits last.");
  await expect(updated.getByLabel("Lineage")).toContainText("superseded");
  expect(fixture.requests.find((r) => r.path === "/api/portal/memory/records/r-style" && r.method === "PATCH")?.body).toEqual({
    body: "Keep reviews short; blockers first, nits last.",
  });

  await updated.getByRole("button", { name: "Forget" }).click();
  await updated.getByRole("textbox", { name: "Why forget it (optional)" }).fill("No longer true");
  await updated.getByRole("button", { name: "Forget" }).click();
  await expect(pane.getByRole("region", { name: /In force/ })).toHaveCount(0);
  expect(fixture.requests.find((r) => r.path.endsWith("/forget"))?.body).toEqual({ reason: "No longer true" });

  await page.getByRole("button", { name: "Add record" }).click();
  const dialog = page.getByRole("dialog", { name: "Add to memory" });
  await dialog.getByRole("textbox", { name: "Key" }).fill("language");
  await dialog.getByRole("textbox", { name: "What to remember" }).fill("Answer in English.");
  await dialog.getByRole("switch", { name: "Pin into CORE.md" }).click();
  await dialog.getByRole("button", { name: "Add record" }).click();
  await expect(dialog).toHaveCount(0);
  const created = fixture.requests.find((r) => r.path === "/api/portal/memory/records" && r.method === "POST");
  expect(created?.body).toMatchObject({
    entity: { type: "global", key: "global" },
    type: "preference",
    key: "language",
    body: "Answer in English.",
    pinned: true,
    source: { kind: "ui" },
  });
  await expect(pane.getByRole("article", { name: /^language/ })).toContainText("Answer in English.");
});
