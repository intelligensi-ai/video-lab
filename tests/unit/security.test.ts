import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  isPrivateRuntimeHostname,
  normalizeRuntimeOrigin,
  rateLimit,
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

  it("uses the injected distributed counter and returns owned retry timing", async () => {
    const app = express();
    app.get(
      "/limited",
      rateLimit({
        name: "distributed-test",
        limit: 1,
        key: () => "owner-1",
        consume: async (input) => {
          expect(input).toMatchObject({
            name: "distributed-test",
            identity: "owner-1",
            limit: 1,
          });
          return { allowed: false, retryAfterSeconds: 17 };
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );
    const response = await request(app).get("/limited").expect(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(response.body.code).toBe("rate_limited");
  });

  it("fails closed when the distributed rate store is unavailable", async () => {
    const app = express();
    app.get(
      "/limited",
      rateLimit({
        name: "distributed-test",
        limit: 1,
        consume: async () => {
          throw new Error("store unavailable");
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );
    const response = await request(app).get("/limited").expect(503);
    expect(response.body.code).toBe("rate_limit_unavailable");
  });
});
