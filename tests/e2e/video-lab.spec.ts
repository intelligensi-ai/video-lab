import { expect, test } from "@playwright/test";

test("landing page presents the creator entry point", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /intelligensi\.ai Video Lab/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Start creating" }),
  ).toBeVisible();
});

test("storyboard exposes editable Gemma and frame controls", async ({
  page,
}) => {
  await page.goto("/storyboard");
  const brief = page.getByLabel("Overall artistic goal");
  await brief.fill("A musician follows a blue light through a rain-dark city.");
  await expect(
    page.getByRole("button", { name: /Enhance and plan 2 shots/ }),
  ).toBeEnabled();
  await expect(
    page.getByText(/Suggestions come from the local Gemma enhancer/),
  ).toBeVisible();
  await page.getByText("First frame / last frame", { exact: true }).click();
  await page.getByRole("button", { name: "Expand scene 2" }).click();
  await page.getByText("First frame / last frame", { exact: true }).nth(1).click();
  const firstFrameButtons = page.getByRole("button", {
    name: "Generate first frame",
  });
  const lastFrameButtons = page.getByRole("button", {
    name: "Generate last frame",
  });
  await expect(firstFrameButtons).toHaveCount(2);
  await expect(firstFrameButtons.first()).toBeVisible();
  await expect(lastFrameButtons).toHaveCount(2);
  await expect(lastFrameButtons.first()).toBeVisible();
  await page.getByRole("button", { name: /Add scene/ }).click();
  await expect(
    page.getByRole("button", { name: /Enhance and plan 3 shots/ }),
  ).toBeVisible();
  await expect(page.getByText("3/24")).toBeVisible();
  await page.getByRole("button", { name: "New project" }).first().click();
  await expect(page.getByLabel("Open storyboard project")).toBeVisible();
  await expect(page.getByLabel("Project title")).toBeEditable();
  await page.getByRole("button", { name: "Close project dialog" }).click();
  await expect(
    page.getByRole("button", { name: /Project references/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Sound behaviour")).toHaveValue("intent_only");
  await expect(page.getByLabel("Drafts per scene")).toHaveValue("3");
  await expect(
    page.getByRole("button", { name: "Assemble accepted clips" }),
  ).toBeDisabled();
});

test("mobile storyboard has no page-level horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/storyboard");
  await expect(page.getByLabel("Overall artistic goal")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
});
