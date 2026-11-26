// REDIRECT-WRAPPER UNWRAP (2026-11-27): a link pasted from
// Facebook/Meta arrives wrapped —
//   https://l.meta.ai/?u=<encoded real URL>&h=<hash>
// — and the stored card then points at Meta's redirect shim instead
// of the article. Live incident: clicking «فتح الرابط» on the
// Android 17 Blogger card opened a new tab that stayed about:blank
// (0 elements, 20s) — the shim never redirected. The direct Blogger
// URL underneath works (HTTP 200, real page).
//
// WHY THE SHIM STAYS BLANK: Meta's shim is a JS-gated interstitial
// that only redirects when its `h` hash validates (and usually with
// a Facebook session). With a stale or mangled hash it serves a
// blank page instead of the article. The card renders a plain
// <a href target="_blank"> with no click interception anywhere, so
// the wrapper URL itself is the problem — unwrapping it fixes the
// click, because the direct URL navigates normally.
//
// The destination is the `u` parameter — `h` is Meta's integrity
// hash, NOT a destination. One live card has a MANGLED hash whose
// value is itself a wrapped Android 17 link; that garbage is
// ignored on purpose: following it would point the card at the wrong
// article (its `u` is a moghazi2030 article, and the third Blogger
// card unwraps to the same moghazi2030 article — the two cards are
// probably the same article saved twice under different wrappers,
// since the duplicate check compares exact stored URLs; worth the
// user deleting one). Unwrapping repeats while the `u` value is
// itself a wrapper (a link copied out of Facebook twice), and stops
// at the first non-wrapper URL.
//
// fb.me is a pure shortener with no `u` parameter, so it cannot be
// unwrapped offline — it is left as-is on purpose: the normal fetch
// stage follows its redirect, and the link still opens in a browser.

const WRAPPER_HOSTS = new Set([
  'l.meta.ai',
  'l.facebook.com',
  'lm.facebook.com',
  'l.messenger.com',
]);

/** True when the URL is a Meta redirect wrapper (has a `u` target). */
export function isRedirectWrapperUrl(raw: string): boolean {
  let host = '';
  try {
    host = new URL(raw.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  return WRAPPER_HOSTS.has(host);
}

/**
 * Return the direct URL behind a Meta redirect wrapper, or the input
 * unchanged when it is not a wrapper (or the wrapper is unusable).
 * Pure and offline — safe to use at save time and at render time.
 * Idempotent: unwrapping an already-direct URL returns it unchanged.
 */
export function unwrapRedirectUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  let current = trimmed;
  // Repeat while the destination is itself a wrapper; cap the hops so
  // a pathological loop can never hang a save or a render.
  for (let hop = 0; hop < 5; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return current;
    }
    if (!WRAPPER_HOSTS.has(url.hostname.toLowerCase())) return current;
    const target = url.searchParams.get('u');
    if (!target) return current;
    let decoded: URL;
    try {
      decoded = new URL(target.trim());
    } catch {
      return current;
    }
    if (decoded.protocol !== 'http:' && decoded.protocol !== 'https:') return current;
    current = decoded.toString();
  }
  return current;
}
