import fs from "node:fs";
import { describe, expect, it } from "vitest";

const referencePath =
  "docs/handover/longform-creator-workflow-to-john.md";
const goalPath = "docs/handover/john-production-platform-goal.md";

describe("John production-platform handover package", () => {
  it("pins the generation baseline and distinguishes pending live evidence", () => {
    const reference = fs.readFileSync(referencePath, "utf8");
    expect(reference).toContain(
      "sha256:e986a7c7bcb480ee7af065c459725ce1224cea959de825ded26727fbb4c13e14",
    );
    expect(reference).toContain(
      "4131cbfe2a2debce8c86b333f49ac4b0a7509505",
    );
    expect(reference).toContain(
      "65c0f857394ec492ed3797fdecdcb62df890ab7f",
    );
    expect(reference).toMatch(
      /PENDING CWA8R ACCEPTANCE|CWA8R[^\n]*passed/i,
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
