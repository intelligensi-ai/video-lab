import { isIP } from "node:net";
import type { CorsOptions } from "cors";
import type { Request, RequestHandler } from "express";
import { traceId } from "@video-lab/shared";

const localOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:5000",
  "http://localhost:5000",
]);

function ipv4Parts(hostname: string): number[] | undefined {
  if (isIP(hostname) !== 4) return undefined;
  return hostname.split(".").map(Number);
}

export function isPrivateRuntimeHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }

  const ipv4 = ipv4Parts(normalized);
  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }

  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  return false;
}

export function normalizeRuntimeOrigin(
  value: unknown,
  options: {
    production?: boolean;
    allowPrivate?: boolean;
    allowHttpInProduction?: boolean;
  } = {},
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const trimmed = value.trim();
    const url = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`,
    );
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    if (
      options.production &&
      url.protocol !== "https:" &&
      !options.allowHttpInProduction
    )
      return undefined;
    if (!options.allowPrivate && isPrivateRuntimeHostname(url.hostname))
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function runtimeOriginAllowed(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = (env.VIDEO_RUNTIME_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) =>
      normalizeRuntimeOrigin(entry, {
        production: env.NODE_ENV === "production",
      }),
    )
    .filter((entry): entry is string => Boolean(entry));
  if (env.NODE_ENV === "production" && configured.length === 0) return false;
  return configured.length === 0 || configured.includes(origin);
}

export function corsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  const configured = new Set(
    (env.VIDEO_LAB_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  if (env.NODE_ENV !== "production") {
    for (const origin of localOrigins) configured.add(origin);
  }
  return {
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "idempotency-key",
      "x-request-id",
      "x-firebase-appcheck",
    ],
    exposedHeaders: ["retry-after", "x-request-id"],
    maxAge: 600,
    origin(origin, callback) {
      if (!origin || configured.has(origin)) callback(null, true);
      else callback(new Error("Origin is not allowed"));
    },
  };
}

export const securityHeaders: RequestHandler = (req, res, next) => {
  const requestId =
    String(req.header("x-request-id") ?? "").match(
      /^[A-Za-z0-9_-]{8,100}$/,
    )?.[0] ?? traceId();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  next();
};

type RateBucket = { startedAt: number; count: number };
const rateBuckets = new Map<string, RateBucket>();
const maximumRateBuckets = 10_000;
let nextRateBucketSweepAt = 0;

function sweepRateBuckets(now: number, windowMs: number) {
  if (now < nextRateBucketSweepAt && rateBuckets.size < maximumRateBuckets) return;
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.startedAt >= windowMs) rateBuckets.delete(key);
  }
  while (rateBuckets.size >= maximumRateBuckets) {
    const oldest = rateBuckets.keys().next().value as string | undefined;
    if (!oldest) break;
    rateBuckets.delete(oldest);
  }
  nextRateBucketSweepAt = now + Math.min(windowMs, 60_000);
}

export function rateLimit(options: {
  name: string;
  limit: number;
  windowMs?: number;
  key?: (req: Request) => string;
  consume?: (input: {
    name: string;
    identity: string;
    limit: number;
    windowMs: number;
    now: number;
  }) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}): RequestHandler {
  const windowMs = options.windowMs ?? 60_000;
  return async (req, res, next) => {
    const now = Date.now();
    const identity =
      options.key?.(req) ??
      String(res.locals.principal?.uid ?? req.ip ?? "unknown");
    if (options.consume) {
      try {
        const result = await options.consume({
          name: options.name,
          identity,
          limit: options.limit,
          windowMs,
          now,
        });
        if (result.allowed) {
          next();
          return;
        }
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
        res.status(429).type("application/problem+json").json({
          type: "https://video-lab.intelligensi.ai/problems/rate_limited",
          title: "rate limited",
          status: 429,
          detail: "Too many requests. Please wait before trying again.",
          code: "rate_limited",
          traceId: res.locals.requestId,
        });
        return;
      } catch {
        res.status(503).type("application/problem+json").json({
          type: "https://video-lab.intelligensi.ai/problems/rate_limit_unavailable",
          title: "rate limit unavailable",
          status: 503,
          detail: "Request limits could not be verified. Please retry shortly.",
          code: "rate_limit_unavailable",
          traceId: res.locals.requestId,
        });
        return;
      }
    }
    sweepRateBuckets(now, windowMs);
    const key = `${options.name}:${identity}`;
    const existing = rateBuckets.get(key);
    const bucket =
      !existing || now - existing.startedAt >= windowMs
        ? { startedAt: now, count: 0 }
        : existing;
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > options.limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((bucket.startedAt + windowMs - now) / 1_000),
      );
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).type("application/problem+json").json({
        type: "https://video-lab.intelligensi.ai/problems/rate_limited",
        title: "rate limited",
        status: 429,
        detail: "Too many requests. Please wait before trying again.",
        code: "rate_limited",
        traceId: res.locals.requestId,
      });
      return;
    }
    next();
  };
}
