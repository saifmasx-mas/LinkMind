/**
 * Simple per-key rate limiter (in-memory token bucket).
 *
 * SECURITY (2026-11-24 audit): sensitive routes had no rate limiting at all,
 * so one user or bot could hammer /api/analyze, /api/ask and the Telegram
 * webhook and burn the Gemini quota.
 *
 * LIMITATION — read this before launch: this limiter lives in the memory of
 * a single serverless instance. On Vercel Hobby each request may land on a
 * different instance, so a determined attacker can get roughly
 * (limit x number of instances) requests per window instead of `limit`.
 * That is still far better than unlimited, and it costs nothing. For a real
 * global limit in production, replace the store with Upstash Redis / Vercel
 * KV (one counter per key with an expiry) — the call sites only use
 * `checkRateLimit(key, limit, windowMs)`, so the swap is a one-file change.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }

  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
}

/** Drop expired buckets occasionally so the map cannot grow forever. */
export function pruneRateLimitBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Keep the map bounded even under a key-flood attack.
  if (buckets.size > 10_000) {
    const keys = [...buckets.keys()].slice(0, buckets.size - 10_000);
    for (const key of keys) buckets.delete(key);
  }
}
