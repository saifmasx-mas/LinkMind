// Smoke test for the fast pre-save link check, the beta badge, and
// the redirect-wrapper unwrap.
//
// Run: node scripts/smoke-link-check-beta.mjs
//
// Covers, with no external network:
//   1. parseHttpUrl — instant format validation (used by the paste
//      box before sending, and by the server pre-check).
//   1b. preferHttpsUrl — HTTP→HTTPS UPGRADE (2026-11-27): pasting the
//      Android 17 Blogger article as http:// failed with
//      CONTENT_UNAVAILABLE while the SAME link as https:// saved
//      immediately, so the save path upgrades the scheme before
//      fetching (the pasted http URL stays as a probe fallback for
//      http-only sites). The live paste of the http Blogger link is
//      the post-deploy check.
//   2. classifyProbeStatus / classifyProbeError — the pure decision
//      behind the HEAD probe: 404/410 and network failures refuse
//      the link fast, while any other status (403, 429, 500,
//      redirect…) proceeds to the real fetch stage, so a bot-blocked
//      host is never wrongly refused. The live HEAD request itself
//      is NOT covered here (it needs a public host); verify it by
//      pasting a dead link on the live site after deploy.
//   3. unwrapRedirectUrl — Meta wrappers (l.meta.ai, l.facebook.com,
//      lm.facebook.com) unwrap to the direct URL, repeatedly while
//      the `u` value is itself a wrapper; the mangled live card
//      (nested wrapper in the `h` hash slot) unwraps to its `u`
//      destination, because `h` is Meta's hash, not a destination.
//      Normal URLs are unchanged; fb.me cannot be unwrapped offline
//      (pure shortener, no `u` parameter) and stays as-is.
//   4. isBetaContent — the amber «محتوى تجريبي» badge: strong
//      keywords (beta / بيتا / تجريبي) count in title, URL or
//      summary; weak ones (preview / pre-release / experimental)
//      count only in title or URL, so "experimental results" in a
//      summary never badges a card. "Beta-blockers" is excluded.
//   5. Render-time repair: the 3 stored Blogger wrapper URLs render
//      as direct article links (no re-paste), and the wrapped URLs
//      still classify as Blogger (the `u` value carries 'blogspot.').

import { parseHttpUrl, preferHttpsUrl, classifyProbeStatus, classifyProbeError } from '../lib/link-check.ts';
import { unwrapRedirectUrl, isRedirectWrapperUrl } from '../lib/redirect-unwrap.ts';
import { isBetaContent } from '../lib/beta-content.ts';
import { detectSource } from '../lib/source-detect.ts';

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const parsed = (raw) => {
  const url = parseHttpUrl(raw);
  return url === null ? null : url.toString();
};

// --- 1. URL format validation -------------------------------------------
check('valid https URL parses', parsed('https://example.com/article'), 'https://example.com/article');
check('valid http URL parses', parsed('http://example.com/a'), 'http://example.com/a');
check('leading/trailing spaces are trimmed', parsed('  https://example.com/a  '), 'https://example.com/a');
check('bare domain without scheme is invalid', parsed('example.com'), null);
check('plain text is invalid', parsed('not a url'), null);
check('empty string is invalid', parsed(''), null);
check('ftp scheme is invalid', parsed('ftp://example.com/x'), null);
check('javascript: URL is invalid', parsed('javascript:alert(1)'), null);
check('URL with credentials is invalid', parsed('https://user:pass@example.com/'), null);

// --- 1b. HTTP→HTTPS upgrade --------------------------------------------
// LIVE (2026-11-27): pasting the Android 17 Blogger article as http://
// failed with CONTENT_UNAVAILABLE, while the SAME link as https://
// saved immediately with a full summary — the http→https hop does
// not survive the fetch path. The save path upgrades the scheme
// before fetching (with the pasted http URL kept as a probe fallback
// for genuinely http-only sites). These cases pin the upgrade itself;
// the live paste of the http Blogger link is the post-deploy check.
check(
  'http Blogger URL upgrades to https',
  preferHttpsUrl('http://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html'),
  'https://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html'
);
check(
  'https URL is unchanged by the upgrade',
  preferHttpsUrl('https://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html'),
  'https://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html'
);
check(
  'explicit :80 is dropped when upgrading',
  preferHttpsUrl('http://example.com:80/article'),
  'https://example.com/article'
);
check('non-http URL is unchanged by the upgrade', preferHttpsUrl('ftp://example.com/x'), 'ftp://example.com/x');
check('non-URL text is unchanged by the upgrade', preferHttpsUrl('not a url'), 'not a url');
// Any status that is not 404/410 means the host answered.
for (const status of [200, 201, 301, 302, 403, 405, 429, 500, 503]) {
  check(`probe status ${status} → reachable`, classifyProbeStatus(status), 'reachable');
}
check('probe status 404 → not-found', classifyProbeStatus(404), 'not-found');
check('probe status 410 → not-found', classifyProbeStatus(410), 'not-found');

// Failures: only timeouts are distinguished; everything else is a
// network error (DNS, refused, SSRF-guard rejection).
check('timeout error → timeout', classifyProbeError(new Error('Request timed out')), 'timeout');
check('TimeoutError → timeout', classifyProbeError(new Error('TimeoutError')), 'timeout');
check('DNS failure → network-error', classifyProbeError(new Error('getaddrinfo ENOTFOUND example.invalid')), 'network-error');
check('connection refused → network-error', classifyProbeError(new Error('connect ECONNREFUSED 1.2.3.4:443')), 'network-error');
check('private-IP guard rejection → network-error', classifyProbeError(new Error('URL host does not resolve exclusively to public IP addresses')), 'network-error');
check('unsupported URL → network-error', classifyProbeError(new Error('Unsupported URL')), 'network-error');

// --- 3. Redirect-wrapper unwrap -----------------------------------------
// The live Android 17 card (2026-11-27): stored as an l.meta.ai
// wrapper; clicking it stayed about:blank.
const card1Wrapped =
  'https://l.meta.ai/?u=http%3A%2F%2Fkarraraliraqii.blogspot.com%2F2026%2F10%2F17-qpr3-beta-1.html&h=AT123abc';
check('l.meta.ai wrapper → direct article URL', unwrapRedirectUrl(card1Wrapped), 'http://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html');
check('l.meta.ai wrapper is detected', isRedirectWrapperUrl(card1Wrapped), true);

// The live mangled second card: the `h` hash slot holds a second
// wrapper URL. The destination is the `u` value (moghazi2030) — `h`
// is Meta's hash, not a destination — so the unwrap ignores it.
// (Cards 2 and 3 then point at the same moghazi2030 article:
// probably the same article saved twice under different wrappers,
// since dedup compares exact stored URLs.)
const card2Mangled =
  'https://l.meta.ai/?u=http%3A%2F%2Fmoghazi2030.blogspot.com%2F2026%2F11%2Fblog-post_144.html' +
  '&h=https://l.meta.ai/?u=http%3A%2F%2Fkarraraliraqii.blogspot.com%2F2026%2F10%2F17-qpr3-beta-1.html&h=AT000';
check(
  'mangled nested wrapper → u destination (moghazi2030)',
  unwrapRedirectUrl(card2Mangled),
  'http://moghazi2030.blogspot.com/2026/11/blog-post_144.html'
);

// The live third card: a clean wrapper to the same moghazi2030 article.
const card3Wrapped =
  'https://l.meta.ai/?u=http%3A%2F%2Fmoghazi2030.blogspot.com%2F2026%2F11%2Fblog-post_144.html&h=AT999';
check('third card wrapper → same moghazi2030 URL', unwrapRedirectUrl(card3Wrapped), 'http://moghazi2030.blogspot.com/2026/11/blog-post_144.html');

check(
  'l.facebook.com wrapper → direct URL',
  unwrapRedirectUrl('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Farticle&h=AT1'),
  'https://example.com/article'
);
check(
  'lm.facebook.com wrapper → direct URL',
  unwrapRedirectUrl('https://lm.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Farticle&h=AT1'),
  'https://example.com/article'
);

// A wrapper whose `u` is itself a wrapper: unwrap repeatedly to the
// innermost direct URL.
const innerWrapped = `https://l.meta.ai/?u=${encodeURIComponent('http://example.com/article')}&h=xx`;
const doubleWrapped = `https://l.meta.ai/?u=${encodeURIComponent(innerWrapped)}&h=yy`;
check('double-wrapped → innermost direct URL', unwrapRedirectUrl(doubleWrapped), 'http://example.com/article');

// Unchanged: normal URLs, a wrapper without `u`, fb.me (pure
// shortener — no `u` parameter, cannot be unwrapped offline).
check('normal article URL unchanged', unwrapRedirectUrl('https://example.com/some-article'), 'https://example.com/some-article');
check('direct blogspot URL unchanged', unwrapRedirectUrl('https://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html'), 'https://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html');
check('YouTube URL unchanged', unwrapRedirectUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
check('wrapper without u param unchanged', unwrapRedirectUrl('https://l.meta.ai/?h=AT1'), 'https://l.meta.ai/?h=AT1');
check('fb.me shortener unchanged offline', unwrapRedirectUrl('https://fb.me/abc123'), 'https://fb.me/abc123');
check('non-URL text unchanged', unwrapRedirectUrl('not a url'), 'not a url');
check('unwrap is idempotent', unwrapRedirectUrl(unwrapRedirectUrl(card1Wrapped)), 'http://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html');

// --- 4. Beta badge ------------------------------------------------------
const beta = (over) => isBetaContent({ url: '', title: '', summary: '', ...over });
check(
  'Android 17 beta title (Arabic) badges',
  beta({ title: 'مراجعة وتحديثات نظام أندرويد التجريبي' }),
  true
);
check(
  'live re-added Android 17 card title badges (Beta in title)',
  beta({ title: 'كل ما تحتاج معرفته عن التحديث الجديد لنظام أندرويد 17 QPR3 Beta 1 والمميزات الجديدة' }),
  true
);
check('English beta in title badges', beta({ title: 'Android 17 QPR3 Beta 1 review' }), true);
check(
  'beta in URL badges',
  beta({ url: 'https://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html', title: 'Android 17 review' }),
  true
);
check('preview in title badges', beta({ title: 'New preview build is out' }), true);
check('experimental in title badges', beta({ title: 'Experimental features in Chrome' }), true);
check('pre-release in title badges', beta({ title: 'Pre-release version notes' }), true);
check('strong keyword in summary badges', beta({ title: 'Android 17 review', summary: 'This beta brings new features.' }), true);
check('بيتا in summary badges', beta({ title: 'مراجعة أندرويد', summary: 'هذه نسخة بيتا من النظام.' }), true);
check('تجريبي in summary badges', beta({ title: 'مراجعة أندرويد', summary: 'الإصدار التجريبي الجديد.' }), true);
check(
  'weak keyword in summary alone does NOT badge',
  beta({ title: 'Chrome features', summary: 'The experimental results show a speedup.' }),
  false
);
check(
  'preview in summary alone does NOT badge',
  beta({ title: 'Season recap', summary: 'A preview of next season.' }),
  false
);
check('ordinary Arabic title does NOT badge', beta({ title: 'كيف تنظم وقتك بفعالية' }), false);
check('ordinary Arabic title does NOT badge (2)', beta({ title: 'كيف تتعلم البرمجة من الصفر' }), false);
check('ordinary English title does NOT badge', beta({ title: 'How to bake sourdough bread' }), false);
check('"alphabet" does NOT match beta', beta({ title: 'Alphabet song for kids' }), false);
check('beta-blockers do NOT badge', beta({ title: 'Beta-blockers explained' }), false);
check('beta blockers (space) do NOT badge', beta({ title: 'Beta blockers and heart health' }), false);
check('empty input does NOT badge', beta({}), false);

// --- 5. Render-time repair of stored wrapper URLs ----------------------
// The card href is unwrapRedirectUrl(item.url). These are the wrapper
// URLs the 3 Blogger cards used to carry (the cards were since
// re-added live with direct links, but any wrapped card in any
// library still renders as a direct article link — no re-paste).
const storedBloggerUrls = [card1Wrapped, card2Mangled, card3Wrapped];
const renderedHrefs = storedBloggerUrls.map((u) => unwrapRedirectUrl(u));
check('rendered href 1 is the Android 17 article', renderedHrefs[0], 'http://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html');
check('rendered href 2 is the moghazi2030 article', renderedHrefs[1], 'http://moghazi2030.blogspot.com/2026/11/blog-post_144.html');
check('rendered href 3 is the moghazi2030 article', renderedHrefs[2], 'http://moghazi2030.blogspot.com/2026/11/blog-post_144.html');
check('rendered hrefs are all plain http(s) article URLs', renderedHrefs.every((h) => h.startsWith('http://') || h.startsWith('https://')), true);

// The wrapped URLs still classify as Blogger (the `u` value carries
// 'blogspot.'), which is why the badge and the filter already worked.
check('wrapped card 1 still classifies as blogger', detectSource(card1Wrapped), 'blogger');
check('wrapped card 2 still classifies as blogger', detectSource(card2Mangled), 'blogger');

// The Android 17 card gets the beta badge at render time.
check(
  'Android 17 card badges at render time',
  isBetaContent({
    url: renderedHrefs[0],
    title: 'مراجعة وتحديثات نظام أندرويد التجريبي',
    summary: 'يستعرض هذا المقال تفاصيل ومميزات الإصدار التجريبي الجديد من نظام التشغيل أندرويد.',
  }),
  true
);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll link-check + beta-badge + unwrap checks passed.');
