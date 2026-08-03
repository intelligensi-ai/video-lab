import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readSourceFiles(directory: string): string {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return [readSourceFiles(fullPath)];
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) return [];
      return [fs.readFileSync(fullPath, "utf8")];
    })
    .join("\n");
}

describe("runtime API key boundary", () => {
  it("keeps the Deploy Studio runtime API key out of browser source", () => {
    const webSource = readSourceFiles(path.resolve("apps/web/src"));
    expect(webSource).not.toContain("VIDEO_RUNTIME_API_TOKEN");
    expect(webSource).not.toContain("X-Intelligensi-API-Key");
    expect(webSource).not.toContain("discovery.baseUrl");
    expect(webSource).not.toMatch(/https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/);
  });
});
