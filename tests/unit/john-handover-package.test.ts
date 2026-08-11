import fs from "node:fs";
import { describe, expect, it } from "vitest";

const referencePath =
  "docs/handover/longform-creator-workflow-to-john.md";
const goalPath = "docs/handover/john-production-platform-goal.md";

describe("John production-platform handover package", () => {
  it("pins the generation baseline and distinguishes pending live evidence", () => {
    const reference = fs.readFileSync(referencePath, "utf8");
    expect(reference).toContain(
      "sha256:88fe06ac59ca1804d58be3034aa5f08d6eeabf405d64da515de742323a1cfb46",
    );
    expect(reference).toContain(
      "e8a736c3d2290d7dfdef4d222641f19ac894fab4",
    );
    expect(reference).toContain(
      "7710577a1d1b0a3bbed8621532119d8c402826ba",
    );
    expect(reference).toMatch(/PENDING CWA2|Gate CWA2[^\n]*passed/i);
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
