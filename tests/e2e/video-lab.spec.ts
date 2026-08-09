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
  await page.goto("/videolab");
  const brief = page.getByLabel("Overall artistic goal");
  await brief.fill("A musician follows a blue light through a rain-dark city.");
  await expect(
    page.getByRole("button", { name: "Polish brief" }),
  ).toBeEnabled();
  await page.getByText("First frame / last frame", { exact: true }).click();
  const firstFrameButtons = page.getByRole("button", {
    name: "Generate first frame",
  });
  const lastFrameButtons = page.getByRole("button", {
    name: "Generate last frame",
  });
  await expect(firstFrameButtons).toHaveCount(1);
  await expect(firstFrameButtons.first()).toBeVisible();
  await expect(lastFrameButtons).toHaveCount(1);
  await expect(lastFrameButtons.first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Project references/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Advanced/ }),
  ).toHaveAttribute("href", "/storyboard/advanced");
});

test("mobile storyboard has no page-level horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/videolab");
  await expect(page.getByLabel("Overall artistic goal")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
});

test("Director workspace uses real project state and reviewable proposals", async ({
  page,
}) => {
  await page.goto("/storyboard/advanced");
  await expect(
    page.getByRole("heading", { name: "What would you like to make?" }),
  ).toBeVisible();
  await expect(page.getByText("Interactive prototype")).toHaveCount(0);
  await expect(page.getByText("Identity stable")).toHaveCount(0);

  const brief = page.getByRole("textbox", {
    name: "Describe your idea in your own words",
  });
  await brief.fill(
    "A lone inventor follows a teal signal through a rain-dark city.",
  );

  const director = page.getByRole("textbox", { name: "Message the Director" });
  await director.fill("What is currently blocking this film?");
  await page.getByRole("button", { name: "Send direction" }).click();
  await expect(page.getByText(/Before final assembly/)).toBeVisible();

  await director.fill(
    "Make this scene more tense without changing the other scenes.",
  );
  await page.getByRole("button", { name: "Send direction" }).click();
  await expect(
    page.getByText("Proposed change to Scene 1", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Text only", { exact: true })).toBeVisible();
  await expect(page.getByText("Before", { exact: true })).toBeVisible();
  await expect(
    page
      .locator(".vlx-diff p")
      .filter({ hasText: "Directed revision for scene 1" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("Discarded", { exact: true })).toBeVisible();

  await director.fill("Generate three draft candidates for this scene.");
  await page.getByRole("button", { name: "Send direction" }).click();
  await expect(page.getByText("Draft inference", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Generate 3 draft candidates for Scene 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm and continue" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "A reliable time or cost estimate is unavailable until the connected runtime reports one.",
    ),
  ).toBeVisible();
});

test("mobile Director workspace switches between the canvas and Director without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/storyboard/advanced");
  await expect(page.getByRole("button", { name: /Director$/ })).toBeVisible();
  await page.getByRole("button", { name: /Director$/ }).click();
  await expect(page.getByRole("textbox", { name: "Message the Director" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
});
