import { describe, expect, it } from "vitest";
import {
  isPrivateRuntimeHostname,
  normalizeRuntimeOrigin,
  runtimeOriginAllowed,
} from "../../apps/api/src/security.js";

describe("runtime origin security", () => {
  it("rejects loopback, link-local and private network targets", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.8",
      "172.20.0.4",
      "192.168.1.2",
      "169.254.169.254",
      "::1",
      "fd00::1",
    ]) {
      expect(isPrivateRuntimeHostname(host)).toBe(true);
    }
  });

  it("requires an exact HTTPS origin in production", () => {
    expect(
      normalizeRuntimeOrigin("https://runtime.example/path", {
        production: true,
      }),
    ).toBeUndefined();
    expect(
      normalizeRuntimeOrigin("http://runtime.example", { production: true }),
    ).toBeUndefined();
    expect(
      normalizeRuntimeOrigin("https://runtime.example", { production: true }),
    ).toBe("https://runtime.example");
  });

  it("allows public HTTP runtime origins only when explicitly opted in", () => {
    expect(
      normalizeRuntimeOrigin("209.20.158.174", {
        production: true,
        allowHttpInProduction: true,
      }),
    ).toBe("http://209.20.158.174");
    expect(
      normalizeRuntimeOrigin("http://209.20.158.174:7860", {
        production: true,
        allowHttpInProduction: true,
      }),
    ).toBe("http://209.20.158.174:7860");
    expect(
      normalizeRuntimeOrigin("http://10.0.0.8", {
        production: true,
        allowHttpInProduction: true,
      }),
    ).toBeUndefined();
  });

  it("enforces an explicit origin allow-list when configured", () => {
    expect(
      runtimeOriginAllowed("https://runtime.example", {
        VIDEO_RUNTIME_ALLOWED_ORIGINS: "https://runtime.example",
        NODE_ENV: "production",
      }),
    ).toBe(true);
    expect(
      runtimeOriginAllowed("https://other.example", {
        VIDEO_RUNTIME_ALLOWED_ORIGINS: "https://runtime.example",
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("fails closed when production has no runtime allow-list", () => {
    expect(
      runtimeOriginAllowed("https://runtime.example", {
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("does not accept an HTTP production allow-list entry", () => {
    expect(
      runtimeOriginAllowed("http://runtime.example", {
        VIDEO_RUNTIME_ALLOWED_ORIGINS: "http://runtime.example",
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });
});
