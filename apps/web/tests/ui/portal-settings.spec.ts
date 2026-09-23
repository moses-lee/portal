import { expect, test } from "@playwright/test";
import { setupPortal } from "./fixtures";

test("settings pick a chat model and a bookkeeping model; a provider change resets that role's model", async ({ page }, info) => {
  const fixture = await setupPortal(page);
  await page.goto("/portal");
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("portal:open-settings", { detail: { section: "orchestrator" } })),
  );
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("heading", { name: "Talk to Portal" })).toBeVisible();
  const chatModel = dialog.getByRole("textbox", { name: "Chat model" });
  const bookkeepingModel = dialog.getByRole("textbox", { name: "Bookkeeping model" });
  await expect(chatModel).toHaveValue("claude-opus-5-5");
  await expect(bookkeepingModel).toHaveValue("claude-haiku-4-5");
  await dialog.screenshot({ animations: "disabled", path: info.outputPath("settings-models.png") });

  const patches = () =>
    fixture.requests.filter((r) => r.path === "/api/settings" && r.method === "PATCH").map((r) => r.body);

  await dialog.getByRole("combobox", { name: "Bookkeeping provider" }).click();
  await page.getByRole("option", { name: "OpenAI" }).click();
  await expect(bookkeepingModel).toHaveValue("gpt-5-mini");
  expect(patches().at(-1)).toEqual({ orchestrator: { bookkeeping: { provider: "openai" } } });

  await bookkeepingModel.fill("gpt-5-nano");
  await bookkeepingModel.press("Tab");
  await expect.poll(() => patches().at(-1)).toEqual({ orchestrator: { bookkeeping: { model: "gpt-5-nano" } } });

  await dialog.getByRole("combobox", { name: "Chat provider" }).click();
  await page.getByRole("option", { name: "OpenAI" }).click();
  await expect(chatModel).toHaveValue("gpt-5");
  expect(patches().at(-1)).toEqual({ orchestrator: { provider: "openai" } });
  await expect(dialog.getByText("API keys", { exact: true })).toBeVisible();
});
