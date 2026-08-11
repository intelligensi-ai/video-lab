import fs from "node:fs";
import { describe, expect, it } from "vitest";

const referencePath =
  "docs/handover/longform-creator-workflow-to-john.md";
const goalPath = "docs/handover/john-production-platform-goal.md";

describe("John production-platform handover package", () => {
  it("pins the generation baseline and distinguishes pending live evidence", () => {
    const reference = fs.readFileSync(referencePath, "utf8");
    expect(reference).toContain(
      "sha256:33311a0af9f9acf9b7a5eeb44920d16174a1136a9e9a9c0afa6153a27f4260c8",
    );
    expect(reference).toContain(
      "25ba86cfc93eb737c490867fc4f62e1b879b5e69",
    );
    expect(reference).toContain(
      "07c3030bcb52dff0aef4547845a25345f0d98328",
    );
    expect(reference).toMatch(
      /PENDING SUCCESSOR ACCEPTANCE|successor[^\n]*passed/i,
    );
    expect(reference).toContain("contracts/video-lab.openapi.yaml");
    expect(reference).toContain("intelligensi-runtime-api.openapi.yaml");
  });

  it("gives John an executable goal for every non-model production boundary", () => {
    const goal = fs.readFileSync(goalPath, "utf8");
    expect(goal.startsWith("/goal ")).toBe(true);
    for (const requirement of [
      "Production Firebase Authentication",
      "Firestore and Storage",
      "Distributed rate and concurrency limits",
      "Entitlement and financial boundary",
      "Storage quotas, retention, deletion, and recovery",
      "Monitoring and operations",
      "Staging acceptance",
      "Production rollout",
      "Completion threshold",
    ]) {
      expect(goal).toContain(requirement);
    }
    expect(goal).toContain(
      "Do not rerun paid inference merely to test Firebase UI",
    );
    expect(goal).toContain(
      "Do not claim production readiness from configuration files or unit tests alone.",
    );
  });
});
