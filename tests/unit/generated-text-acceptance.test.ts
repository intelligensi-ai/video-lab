import { describe, expect, it } from "vitest";
import { defaultGeneratedTextPolicy } from "@video-lab/contracts";
import { requireGeneratedTextAcceptance } from "../../apps/api/src/index.js";

const generation = {
  settings: { generatedTextPolicy: defaultGeneratedTextPolicy() },
};

describe("generated-text output acceptance", () => {
  it("accepts output when the runtime did not return validation evidence", () => {
    expect(() =>
      requireGeneratedTextAcceptance(generation as never, undefined),
    ).not.toThrow();
  });

  it("accepts media when OCR or stream validation did not pass", () => {
    expect(() =>
      requireGeneratedTextAcceptance(generation as never, {
        version: "generated-text-qc-v1",
        advisory: false,
        score: 0,
        recommendation: "review",
        checks: [
          {
            id: "generated_text_policy",
            status: "failed",
            confidence: 0.99,
            detail: "Potential burned-in text was detected.",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts forbidden-text output only with an explicit passing check", () => {
    expect(() =>
      requireGeneratedTextAcceptance(generation as never, {
        version: "generated-text-qc-v1",
        advisory: false,
        score: 100,
        recommendation: "recommended",
        checks: [
          {
            id: "generated_text_policy",
            status: "passed",
            confidence: 1,
          },
        ],
      }),
    ).not.toThrow();
  });
});
