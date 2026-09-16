import type { NextFunction, Request, Response } from "express";

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

export function rateLimit(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const now = Date.now();
  const key = request.ip ?? "unknown";
  const existing = buckets.get(key);
  const bucket =
    !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + WINDOW_MS }
      : existing;

  bucket.count += 1;
  buckets.set(key, bucket);

  response.setHeader(
    "RateLimit-Reset",
    Math.ceil((bucket.resetAt - now) / 1000),
  );
  if (bucket.count > MAX_REQUESTS) {
    response.status(429).json({ error: "rate limit exceeded" });
    return;
  }

  next();
}
