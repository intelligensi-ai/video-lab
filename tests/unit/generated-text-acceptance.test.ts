import { describe, expect, it } from "vitest";
import { defaultGeneratedTextPolicy } from "@video-lab/contracts";
import { requireGeneratedTextAcceptance } from "../../apps/api/src/index.js";

const generation = {
  settings: { generatedTextPolicy: defaultGeneratedTextPolicy() },
};

describe("generated-text output acceptance", () => {
  it("fails closed when the runtime did not return validation evidence", () => {
    let rejection: unknown;
    try {
      requireGeneratedTextAcceptance(generation as never, undefined);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      status: 502,
      code: "generated_text_validation_missing",
      detail: expect.stringMatching(/visible-text validation did not run/i),
    });
  });

  it("rejects media when OCR or stream validation did not pass", () => {
    let rejection: unknown;
    try {
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
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      status: 422,
      code: "generated_text_policy_failed",
      detail: expect.stringMatching(/may contain unwanted captions/i),
    });
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
