import { describe, expect, it } from "vitest";
import {
  buildSulphurPayload,
  initialForm,
} from "../../apps/web/src/LtxSulphurGenerator.js";

describe("Sulphur generator prompt enhancement", () => {
  it("defaults runtime prompt enhancement off", () => {
    const form = initialForm();

    expect(form.enhancePrompt).toBe(false);
    expect(
      buildSulphurPayload({
        ...form,
        prompt: "A strict prompt that should be sent without automatic enhancement.",
      }).enhancePrompt,
    ).toBe(false);
  });

  it("still sends enhancement when the user opts in", () => {
    const form = {
      ...initialForm(),
      prompt: "A prompt that can be expanded by the runtime.",
      enhancePrompt: true,
    };

    expect(buildSulphurPayload(form).enhancePrompt).toBe(true);
  });
});
