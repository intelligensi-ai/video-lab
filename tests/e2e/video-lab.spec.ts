import { expect, test } from "@playwright/test";

const apiBaseUrl = process.env.VIDEO_LAB_E2E_API_BASE_URL ?? "http://127.0.0.1:5101";

test("landing page presents the creator entry point", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /intelligensi\.ai Video Lab/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Start creating" }),
  ).toBeVisible();
});

test("minimal VideoLab exposes only Director, preview, generation and three output choices", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("vl_token", "e2e-minimal-video-user"),
  );
  await page.route("**/api/v1/storyboard-enhancements", async (route) => {
    const request = route.request().postDataJSON() as {
      shotCount: number;
      masterPrompt: string;
    };
    const result = {
      contractVersion: "2",
      polishedMasterPrompt: `Director plan: ${request.masterPrompt}`,
      negativePrompt: "blur, flicker, malformed anatomy, duplicate subjects, unwanted visible text",
      continuityBible: {
        characters: "One recurring musician.", wardrobe: "A dark raincoat.", props: "A blue hand light.", location: "A rain-dark city.", sceneGeometry: "Travel continues left to right.", timeOfDay: "Night.", lighting: "Blue practical light and warm windows.", palette: "Blue and amber.", lens: "35mm.", cameraPosition: "Eye level.", cameraMovement: "Measured tracking.", visualStyle: "Grounded cinematic realism.", audio: "No audio unless requested.",
      },
      referenceUsagePlan: [],
      assumptions: ["The blue light is handheld."],
      shots: Array.from({ length: request.shotCount }, (_, index) => ({
        shotNumber: index + 1,
        title: `Director scene ${index + 1}`,
        narrativePurpose: `Advance story beat ${index + 1}.`,
        prompt: `The musician follows the blue light in scene ${index + 1}.`,
        firstFramePrompt: `Opening composition for scene ${index + 1}.`,
        lastFramePrompt: `Closing composition for scene ${index + 1}.`,
        continuityNotes: "Preserve the musician, raincoat, blue light and direction of travel.",
        referenceIds: [],
        recommendedControls: [],
        audioIntent: { mode: "silent", reason: "No sound was requested." },
        generatedTextIntent: { mode: "none", visibleText: [], reason: "Visible text is forbidden." },
        candidateVariations: ["Measured tracking variation."],
      })),
      visualReferenceAnalyses: [],
      vision: { mode: "planning_only", attachedReferenceIds: [], textOnlyReferenceIds: [] },
      provider: "mock",
      model: "e2e-director",
      instructionBundle: {
        directorVersion: "e2e",
        enhancerVersion: "e2e",
        framePromptVersion: "e2e",
        hash: "0".repeat(64),
      },
    };
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        id: "enhance_e2e_01",
        kind: "storyboard_enhancement",
        status: "completed",
        stage: "completed",
        projectId: "e2e-project",
        attempt: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        result,
        links: { self: "/v1/storyboard-enhancements/enhance_e2e_01", cancel: null },
      }),
    });
  });
  await page.goto("/videolab");
  const brief = page.getByLabel("Overall artistic goal");
  await expect(brief).toBeEnabled();
  await brief.fill("A musician follows a blue light through a rain-dark city.");
  await expect(
    page.getByRole("button", { name: "Improve with Director" }),
  ).toBeEnabled();
  await page.getByLabel("Aspect ratio").selectOption("16:9");
  await page.getByLabel("Resolution").selectOption("1280x720");
  await page.getByLabel("Video length").fill("5");
  await expect(page.getByLabel("Aspect ratio")).toHaveValue("16:9");
  await expect(page.getByLabel("Resolution")).toHaveValue("1280x720");
  await expect(page.getByLabel("Sound behaviour")).toHaveValue("intent_only");
  await expect(page.getByLabel("Video length")).toHaveValue("5");
  await page.getByLabel("Aspect ratio").selectOption("9:16");
  await expect(page.getByLabel("Resolution")).toHaveValue("720x1280");
  await page.getByLabel("Video length").fill("8");
  await expect(page.getByLabel("Video length")).toHaveValue("8");
  await page.getByRole("button", { name: "Improve with Director" }).click();
  await expect(brief).toHaveValue(/Director plan:/);
  await expect(page.getByLabel("Scene 1 title")).toHaveValue("Director scene 1");
  await expect(page.getByLabel("Shared negative prompt").first()).toHaveValue(/unwanted visible text/);
  await page.getByText("Scene purpose, continuity and sound").first().click();
  await expect(page.getByLabel("Scene 1 narrative purpose")).toHaveValue("Advance story beat 1.");
  await expect(page.getByLabel("Scene 1 continuity notes")).toHaveValue(/Preserve the musician/);
  await expect(page.getByLabel("Scene 1 sound intent")).toHaveValue("silent");
  await expect(page.getByText("Project references")).toHaveCount(0);
  await expect(page.getByText("Scene direction")).toBeVisible();
  await expect(page.getByText("First frame / last frame")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "3 · Generate video" }),
  ).toBeDisabled();
  await expect(page.getByText(/Generate and review the first and last frame/)).toBeVisible();
  await expect(page.getByRole("button", { name: "2 · Generate missing previews" })).toBeEnabled();
  await expect(page.getByRole("link", { name: /Advanced/ })).toHaveAttribute(
    "href",
    "/storyboard/advanced",
  );
});

test("Video Lab exposes LTX 2.5 only when the managed runtime advertises it", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("vl_token", "e2e-ltx25-model-user"),
  );
  await page.route("**/api/v1/runtime/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "verified-test-runtime",
        status: "healthy",
        acceptingSubmissions: true,
        killSwitch: false,
        queueDepth: 0,
        updatedAt: new Date().toISOString(),
        capabilities: {
          defaultVideoModel: "ltx-2.3",
          videoModels: [
            {
              id: "ltx-2.3",
              label: "LTX 2.3",
              status: "proven",
              available: true,
              recommended: true,
              workflowModes: ["text", "start", "start_end"],
            },
            {
              id: "ltx-2.5",
              label: "LTX 2.5",
              status: "preview",
              available: true,
              recommended: false,
              reason: "Available on the approved preview runtime.",
              workflowModes: ["text", "start", "start_end"],
            },
          ],
        },
      }),
    });
  });

  await page.goto("/videolab");
  const selector = page.getByLabel("Video model");
  await expect(selector).toHaveValue("ltx-2.3");
  await expect(selector.locator('option[value="ltx-2.5"]')).toBeEnabled();
  await expect(selector.locator('option[value="ltx-2.5"]')).toHaveText(
    "LTX 2.5 - Preview",
  );

  await selector.selectOption("ltx-2.5");
  await expect(selector).toHaveValue("ltx-2.5");
});

test("minimal VideoLab restores the accepted completed video for a reopened project", async ({
  page,
  request,
}) => {
  const token = "e2e-reopen-completed-video-user";
  const headers = { authorization: `Bearer ${token}` };
  const projectForm = (acceptedVideoGenerationId?: string) => ({
    overallGoal: "A lighthouse beam crosses a storm-dark sea at night.",
    negativePrompt: "",
    resolution: "1280x720",
    fps: 24,
    imageSteps: 4,
    guidanceScale: 1,
    startFrameStrength: 1,
    endFrameStrength: 0.85,
    enhancePrompt: true,
    postProcess: "none",
    outputFormat: "mp4",
    globalVisualAnchorEnabled: false,
    globalSeed: 1337,
    seedPolicy: "global_locked",
    scenes: [
      {
        id: "scene-1",
        title: "The lighthouse",
        prompt: "A lighthouse beam crosses a storm-dark sea at night.",
        duration: 4,
        trimStart: 0,
        trimEnd: 4,
        seed: 1337,
        transition: "cut",
        transitionDuration: 0.75,
        carryPreviousFrame: false,
        ...(acceptedVideoGenerationId ? { acceptedVideoGenerationId } : {}),
      },
    ],
  });
  const created = await request.post(
    `${apiBaseUrl}/v1/storyboards/projects`,
    {
      headers,
      data: {
        title: "Reopened lighthouse film",
        form: projectForm(),
      },
    },
  );
  expect(created.status()).toBe(201);
  const project = await created.json();
  const submitted = await request.post(
    `${apiBaseUrl}/v1/generations`,
    {
      headers: {
        ...headers,
        "Idempotency-Key": `e2e-reopen-video-${Date.now()}`,
      },
      data: {
        prompt: "A lighthouse beam crosses a storm-dark sea at night.",
        settings: {
          runtime: "longform-ltx-storyboard-studio",
          projectId: project.id,
          operationScope: "scene",
          operationSceneId: "scene-1",
          aspectRatio: "16:9",
          durationSeconds: 4,
          quality: "draft",
          storyboard: [
            {
              id: "scene-1",
              title: "The lighthouse",
              prompt: "A lighthouse beam crosses a storm-dark sea at night.",
              duration: 4,
              trimStart: 0,
              trimEnd: 4,
              seed: 1337,
              transition: "cut",
              transitionDuration: 0.75,
              carryPreviousFrame: false,
            },
          ],
        },
        inputAssets: [],
      },
    },
  );
  expect(submitted.status()).toBe(201);
  const generation = await submitted.json();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await request.get(
      `${apiBaseUrl}/v1/generations/${generation.id}`,
      { headers },
    );
    const body = await current.json();
    if (body.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const completed = await request.get(
    `${apiBaseUrl}/v1/generations/${generation.id}`,
    { headers },
  );
  expect((await completed.json()).status).toBe("completed");

  const updated = await request.put(
    `${apiBaseUrl}/v1/storyboards/projects/${project.id}`,
    {
      headers,
      data: {
        title: "Reopened lighthouse film",
        form: projectForm(generation.id),
      },
    },
  );
  expect(updated.status()).toBe(200);

  await page.addInitScript((authToken) => {
    localStorage.setItem("vl_token", authToken);
  }, token);
  await page.goto("/videolab");

  await expect(page.getByLabel("Overall artistic goal")).toHaveValue(
    "A lighthouse beam crosses a storm-dark sea at night.",
  );
  await expect(page.locator(".lf-screen video")).toBeVisible();
  await expect(page.getByRole("link", { name: /Download video/ })).toBeVisible();

  await page.reload();
  await expect(page.locator(".lf-screen video")).toBeVisible();
  await expect(page.getByRole("link", { name: /Download video/ })).toBeVisible();
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
  await page.addInitScript(() =>
    localStorage.setItem("vl_token", "e2e-director-workspace-user"),
  );
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
  await expect(
    page.getByText("Draft inference", { exact: true }),
  ).toBeVisible();
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

test("Director exposes intermediate frame anchors only after runtime capability proof", async ({
  page,
}) => {
  await page.route("**/api/v1/runtime/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "verified-test-runtime",
        status: "healthy",
        acceptingSubmissions: true,
        killSwitch: false,
        queueDepth: 0,
        updatedAt: new Date().toISOString(),
        capabilities: {
          workflowModes: ["text", "start", "start_end", "multi_keyframe"],
          intermediateKeyframes: true,
          maxIntermediateKeyframes: 6,
        },
      }),
    });
  });

  await page.goto("/storyboard/advanced");
  await page.getByRole("button", { name: "3 Board" }).click();

  const control = page.getByText("Intermediate frame anchors", {
    exact: true,
  });
  await expect(control).toBeVisible();
  await expect(page.getByText("0/6", { exact: true })).toBeVisible();
  await control.click();
  await expect(
    page.getByText(
      "Guide exact compositions between the approved first and last frames. Existing anchors are never retimed automatically.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add intermediate frame" }),
  ).toBeVisible();
});

test("mobile Director workspace switches between the canvas and Director without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/storyboard/advanced");
  await expect(page.getByRole("button", { name: /Director$/ })).toBeVisible();
  await page.getByRole("button", { name: /Director$/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Message the Director" }),
  ).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
});
