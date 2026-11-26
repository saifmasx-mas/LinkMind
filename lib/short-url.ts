// Short-link resolver: follows up to 3 manual redirects, validating each
// hop stays within the allowed destination hosts BEFORE requesting it,
// so resolving a short link can never become an SSRF hop to an internal
// address. The response body is never read — only the final URL is
// returned. Returns the original URL on any failure, so callers can fall
// back to saving the pasted link as-is.
//
// SECURITY (2026-11-24 audit): redirects are followed MANUALLY, one hop
// at a time: each Location is validated (must stay within the allowed
// destinations) BEFORE the next request is made, at most 3 hops, and the
// response body is never read — only the final URL is returned. The
// actual page fetch afterwards still goes through fetchPublicUrl.
export async function resolveShortUrl(
  url: string,
  shortHosts: string[],
  isAllowedDestination: (host: string) => boolean
): Promise<string> {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  if (!shortHosts.includes(host)) return url;
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    let res: Response;
    try {
      res = await fetch(current, {
        method: 'GET',
        // Manual redirects: validate each hop before following it.
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        },
      });
    } catch {
      return url;
    }
    const location = res.headers.get('location');
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    if (!isRedirect || !location) {
      // Not a redirect: `current` is the final URL. Discard the body.
      try {
        await res.body?.cancel();
      } catch {
        // Body already consumed or unavailable; nothing to do.
      }
      return current;
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return url;
    }
    const nextHost = next.hostname.toLowerCase();
    if (!isAllowedDestination(nextHost)) {
      return url;
    }
    current = next.toString();
  }
  return current;
}
