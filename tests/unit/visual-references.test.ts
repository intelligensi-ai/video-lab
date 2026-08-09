import { describe, expect, it } from "vitest";
import {
  MAX_REFERENCE_SOURCE_BYTES,
  normalizeVisualReference,
} from "../../apps/api/src/visualReferences.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("Director visual-reference normalisation", () => {
  it("normalises a valid still image deterministically without enlarging it", async () => {
    const first = await normalizeVisualReference(onePixelPng, "image/png");
    const second = await normalizeVisualReference(onePixelPng, "image/png");
    expect(first).toMatchObject({
      contentType: "image/jpeg",
      sourceWidth: 1,
      sourceHeight: 1,
      sourcePixelCount: 1,
      width: 1,
      height: 1,
      pixelCount: 1,
    });
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("rejects a MIME declaration that disagrees with decoded image content", async () => {
    await expect(
      normalizeVisualReference(onePixelPng, "image/jpeg"),
    ).rejects.toThrow("reference_image_invalid");
  });

  it("rejects an oversized source before image decoding", async () => {
    await expect(
      normalizeVisualReference(
        Buffer.alloc(MAX_REFERENCE_SOURCE_BYTES + 1, 0),
        "image/png",
      ),
    ).rejects.toThrow("reference_image_invalid");
  });
});
