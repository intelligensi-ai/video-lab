import fs from "node:fs";
import { describe, expect, it } from "vitest";

const referencePath =
  "docs/handover/longform-creator-workflow-to-john.md";
const goalPath = "docs/handover/john-production-platform-goal.md";

describe("John production-platform handover package", () => {
  it("pins the accepted generation baseline and remaining staging evidence", () => {
    const reference = fs.readFileSync(referencePath, "utf8");
    expect(reference).toContain(
      "sha256:e986a7c7bcb480ee7af065c459725ce1224cea959de825ded26727fbb4c13e14",
    );
    expect(reference).toContain(
      "639e86adb03960172b6e5a6eb6ecf4a2fd1e37ad",
    );
    expect(reference).toContain(
      "239cc67c6cb9dcf092d9d7d2c97e53079f476f11",
    );
    expect(reference).toContain("CWA8R3");
    expect(reference).not.toContain("PENDING CWA8R ACCEPTANCE");
    expect(reference).toContain("advanced/mobile staging browser replay");
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
