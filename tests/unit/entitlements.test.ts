import { describe, expect, it } from "vitest";
import { creatorEntitlementMode } from "../../apps/api/src/index.js";

describe("creator entitlement policy", () => {
  it("uses local allowances only outside production", () => {
    expect(
      creatorEntitlementMode({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    ).toBe("local");
    expect(
      creatorEntitlementMode({
        NODE_ENV: "development",
        VIDEO_LAB_ENTITLEMENT_MODE: "firestore",
      } as NodeJS.ProcessEnv),
    ).toBe("local");
  });

  it("fails closed to Firestore entitlement verification in production", () => {
    expect(
      creatorEntitlementMode({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBe("firestore");
    expect(
      creatorEntitlementMode({
        NODE_ENV: "production",
        VIDEO_LAB_ENTITLEMENT_MODE: "disabled",
      } as NodeJS.ProcessEnv),
    ).toBe("invalid");
  });

  it("permits an explicit staging allow-list mode without enabling payments", () => {
    expect(
      creatorEntitlementMode({
        NODE_ENV: "production",
        VIDEO_LAB_ENTITLEMENT_MODE: "staging_allowlist",
      } as NodeJS.ProcessEnv),
    ).toBe("staging_allowlist");
  });

  it("can allow any authenticated production user during open access", () => {
    expect(
      creatorEntitlementMode({
        NODE_ENV: "production",
        VIDEO_LAB_ENTITLEMENT_MODE: "authenticated",
      } as NodeJS.ProcessEnv),
    ).toBe("authenticated");
  });
});
