// FAST PRE-SAVE LINK CHECK (2026-11-27): fail a dead or malformed
// link fast, before the heavy fetch stage.
//
// DIAGNOSIS: a dead link used to be detected only inside the fetch
// stage of /api/analyze — a general page waited out fetchPublicUrl
// (8s timeout) plus ONE retry with a browser User-Agent, so up to
// ~16s, before the generic CONTENT_UNAVAILABLE 503; YouTube waited
// out its three parallel calls (~10s) and TikTok its two fetches.
// The error also never said "this link does not work", only that no
// content could be fetched. The probe (lib/link-probe.ts) runs
// BEFORE any of that: a short HEAD request (4s) that only answers
// "is the host there at all?". A DNS failure, a refused connection,
// a timeout or a 404/410 fails fast with an honest message — no
// Gemini call, no save, no credit deduction. Any other status (403,
// 429, 500, redirect…) proceeds: the fetch stage and the content
// gate still decide those, so a host that blocks bots is never
// wrongly refused here.
//
// The content gate (lib/content-gate.ts) stays the second layer: a
// reachable page with no real content still gets CONTENT_UNAVAILABLE.
//
// CLIENT-SAFE: this module is pure (no Node imports) — the paste box
// in app/page.tsx imports parseHttpUrl from here for instant format
// validation. The network probe lives in lib/link-probe.ts (server
// only), because it imports the SSRF-safe fetchPublicUrl.

// LINK PROBE TIMEOUT (2026-11-27): 4s — half of one fetchPublicUrl
// attempt, so a dead link is refused in seconds instead of ~16s.
export const LINK_PROBE_TIMEOUT_MS = 4_000;

/**
 * Parse + validate a pasted link. Returns the URL, or null when the
 * format is wrong: unparsable, not http(s), or carrying credentials.
 * Pure (no network) — the browser uses the same function for instant
 * validation in the paste box before sending anything.
 */
export function parseHttpUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url;
}

export type ProbeOutcome = 'reachable' | 'not-found' | 'network-error' | 'timeout';

/**
 * Pure mapping of a probe HTTP status to an outcome. 404/410 mean the
 * resource is gone; anything else means the host answered, so the
 * real fetch stage decides (a 403/429/500 must never refuse a link
 * here — TikTok and YouTube both block bots sometimes, and their
 * oEmbed/API paths still work).
 */
export function classifyProbeStatus(status: number): ProbeOutcome {
  if (status === 404 || status === 410) return 'not-found';
  return 'reachable';
}

/** Pure mapping of a probe failure to an outcome. */
export function classifyProbeError(error: unknown): ProbeOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out/i.test(message)) return 'timeout';
  return 'network-error';
}

export type LinkCheckResult =
  | { ok: true }
  | {
      ok: false;
      error: 'INVALID_URL' | 'LINK_NOT_FOUND' | 'LINK_UNREACHABLE';
      status: number;
      message: string;
    };

export const LINK_DEAD_MESSAGE =
  'هذا الرابط لا يعمل أو غير متاح حالياً — تحقّق من الرابط وحاول مجدداً.';
export const INVALID_URL_MESSAGE =
  'الرابط غير صحيح — تأكّد أنه يبدأ بـ http:// أو https:// ثم حاول مجدداً.';

/**
 * HTTP→HTTPS UPGRADE (2026-11-27): many sites (Blogger included)
 * 301-redirect plain http to https — and live (2026-11-27) the http
 * paste of the Android 17 Blogger article failed with
 * CONTENT_UNAVAILABLE while the SAME link as https saved immediately
 * with a full summary. The http→https hop evidently does not survive
 * the fetch path (from the server the redirect chain is longer —
 * Google consent hops eat the redirect budget), so the save path
 * upgrades the scheme before fetching instead of relying on the
 * redirect. Pure (no network). The caller keeps the original http
 * URL as a fallback: if the https probe fails, the http URL is tried
 * too, so genuinely http-only sites still work.
 */
export function preferHttpsUrl(raw: string): string {
  const url = parseHttpUrl(raw);
  if (!url || url.protocol !== 'http:') return raw;
  // An explicit :80 belongs to the http scheme, not to https.
  if (url.port === '80') url.port = '';
  url.protocol = 'https:';
  return url.toString();
}
