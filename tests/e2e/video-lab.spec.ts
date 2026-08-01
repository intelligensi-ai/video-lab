import { expect, test } from "@playwright/test";

test("landing page presents the creator entry point", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Intelligensi.ai Showcase Trial")).toBeVisible();
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
    page.getByRole("button", { name: /Enhance and plan 1 shot/ }),
  ).toBeEnabled();
  await expect(
    page.getByText(/Suggestions come from the local Gemma enhancer/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate first frame" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate last frame" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Add scene/ }).click();
  await expect(
    page.getByRole("button", { name: /Enhance and plan 2 shots/ }),
  ).toBeVisible();
  await expect(page.getByText("2/6")).toBeVisible();
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
