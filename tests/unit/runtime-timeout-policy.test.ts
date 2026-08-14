import { describe, expect, it } from "vitest";
import fs from "node:fs";

function envValue(file: string, key: string) {
  const match = fs
    .readFileSync(file, "utf8")
    .match(new RegExp(`^${key}=(\\d+)$`, "m"));
  return match ? Number(match[1]) : undefined;
}

describe("Director timeout policy", () => {
  it.each([".env.example", "infra/lambda-labs/video-lab-runtime.env.example"])(
    "keeps %s above the managed runtime and gateway budgets",
    (file) => {
      const publicApiBudget = envValue(file, "VIDEO_STORYBOARD_ENHANCER_TIMEOUT_MS");
      expect(publicApiBudget).toBe(250_000);
      expect(publicApiBudget).toBeGreaterThan(230_000);
    },
  );
});
