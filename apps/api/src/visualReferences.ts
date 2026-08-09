import { createHash } from "node:crypto";
import sharp from "sharp";

export const MAX_REFERENCE_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_REFERENCE_SOURCE_PIXELS = 24_000_000;
export const MAX_REFERENCE_EDGE = 1_024;
export const MAX_REFERENCE_OUTPUT_BYTES = 1_500_000;
export const MAX_DIRECTOR_VISUAL_REFERENCES = 6;
export const MAX_DIRECTOR_VISUAL_BYTES = 4 * 1024 * 1024;

export type SupportedReferenceContentType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface NormalizedVisualReference {
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  sourcePixelCount: number;
  bytes: Buffer;
  contentType: "image/jpeg";
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  pixelCount: number;
}

function signatureMatches(bytes: Buffer, contentType: SupportedReferenceContentType) {
  if (contentType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function formatContentType(format: string | undefined) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return undefined;
}

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function normalizeVisualReference(
  input: Uint8Array,
  declaredContentType: SupportedReferenceContentType,
): Promise<NormalizedVisualReference> {
  const source = Buffer.from(input);
  if (
    source.byteLength < 1 ||
    source.byteLength > MAX_REFERENCE_SOURCE_BYTES ||
    !signatureMatches(source, declaredContentType)
  ) {
    throw new Error("reference_image_invalid");
  }

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(source, {
      animated: false,
      failOn: "warning",
      limitInputPixels: MAX_REFERENCE_SOURCE_PIXELS,
    }).metadata();
  } catch (error) {
    throw new Error("reference_image_invalid", { cause: error });
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const pages = metadata.pages ?? 1;
  const detectedContentType = formatContentType(metadata.format);
  if (
    !width ||
    !height ||
    width * height > MAX_REFERENCE_SOURCE_PIXELS ||
    pages !== 1 ||
    detectedContentType !== declaredContentType
  ) {
    throw new Error(pages !== 1 ? "reference_image_animated" : "reference_image_invalid");
  }

  try {
    const { data, info } = await sharp(source, {
      animated: false,
      failOn: "warning",
      limitInputPixels: MAX_REFERENCE_SOURCE_PIXELS,
    })
      .autoOrient()
      .resize({
        width: MAX_REFERENCE_EDGE,
        height: MAX_REFERENCE_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .jpeg({
        quality: 85,
        chromaSubsampling: "4:2:0",
        progressive: false,
        optimiseCoding: true,
      })
      .toBuffer({ resolveWithObject: true });
    if (
      !info.width ||
      !info.height ||
      data.byteLength > MAX_REFERENCE_OUTPUT_BYTES ||
      !signatureMatches(data, "image/jpeg")
    ) {
      throw new Error("reference_image_normalized_too_large");
    }
    return {
      sourceSha256: sha256(source),
      sourceWidth: width,
      sourceHeight: height,
      sourcePixelCount: width * height,
      bytes: data,
      contentType: "image/jpeg",
      byteLength: data.byteLength,
      sha256: sha256(data),
      width: info.width,
      height: info.height,
      pixelCount: info.width * info.height,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "reference_image_normalized_too_large") {
      throw error;
    }
    throw new Error("reference_image_invalid", { cause: error });
  }
}
