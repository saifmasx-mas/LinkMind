// LINK PROBE (2026-11-27): the network half of the fast pre-save
// link check. SERVER ONLY — it imports the SSRF-safe fetchPublicUrl
// (Node built-ins), so it must never be imported by a client
// component; the pure format/outcome helpers live in lib/link-check.ts
// (client-safe), and the paste box imports parseHttpUrl from there.
//
// The probe is one HEAD request (4s, no redirect following) through
// fetchPublicUrl (DNS pinning, private-IP block, response cap).
// Redirects are NOT followed: a 3xx already proves the host
// answered, and the real fetch stage follows the redirect itself.
// HEAD responses have no body, so the probe is cheap even for large
// pages.

import { fetchPublicUrl } from './safe-fetch';
import {
  LINK_PROBE_TIMEOUT_MS,
  LINK_DEAD_MESSAGE,
  INVALID_URL_MESSAGE,
  parseHttpUrl,
  classifyProbeStatus,
  classifyProbeError,
  type LinkCheckResult,
  type ProbeOutcome,
} from './link-check';

/** One HEAD probe; the outcome mapping is the pure classifier. */
export async function probeUrlReachable(
  url: string,
  timeoutMs: number = LINK_PROBE_TIMEOUT_MS
): Promise<ProbeOutcome> {
  try {
    const res = await fetchPublicUrl(url, 0, {
      method: 'HEAD',
      timeoutMs,
      followRedirects: false,
    });
    return classifyProbeStatus(res.status);
  } catch (error) {
    return classifyProbeError(error);
  }
}

/**
 * The whole pre-save check in one call: format first, then the
 * reachability probe. Call it in /api/analyze after the duplicate
 * check and before the fetch branches — every failure path returns
 * before any Gemini call, save or credit deduction.
 */
export async function checkLinkBeforeSave(rawUrl: string): Promise<LinkCheckResult> {
  const url = parseHttpUrl(rawUrl);
  if (!url) {
    return { ok: false, error: 'INVALID_URL', status: 400, message: INVALID_URL_MESSAGE };
  }
  const outcome = await probeUrlReachable(url.toString());
  if (outcome === 'not-found') {
    return { ok: false, error: 'LINK_NOT_FOUND', status: 404, message: LINK_DEAD_MESSAGE };
  }
  if (outcome === 'network-error' || outcome === 'timeout') {
    return { ok: false, error: 'LINK_UNREACHABLE', status: 503, message: LINK_DEAD_MESSAGE };
  }
  return { ok: true };
}
