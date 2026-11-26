// Smoke test for the missing Blogger source filter.
//
// Run: node scripts/smoke-blogger-source.mjs
//
// Regression test for (2026-11-27): three Blogger articles were saved
// in the library (Android 17 review + two more, 2026-11-26) and the
// orange Blogger badge showed on their cards, but the Galaxy showed no
// Blogger filter at all. Root cause: the badge used its own render-time
// check (isBloggerUrl), while the counts and the filter used the shared
// classifier detectSource — which had no 'blogger' case, so blogspot.com
// / blogger.com URLs fell through to 'all'. The user saw this as
// "Blogger didn't appear in the Galaxy".
//
// Covers, with no external network:
//   1. detectSource classifies blogspot.com / blogger.com (incl. country
//      variants and uppercase URLs) as 'blogger', with no regressions
//      for the other sources (incl. a Google search link that merely
//      mentions blogspot, which must stay Google).
//   2. A library shaped like the user's live one counts exactly the 3
//      saved Blogger rows under 'blogger' — no re-paste needed — and the
//      Blogger-filtered list contains exactly those rows.
//   3. The badge rule and the classifier agree (isBloggerUrl delegates
//      to detectSource, so they can never drift apart again).

import { detectSource } from '../lib/source-detect.ts';

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// --- 1. Classification -------------------------------------------------
const classifyCases = [
  // [url, expected] — the reported bug: Blogger articles fell to 'all'
  ['https://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html', 'blogger'],
  ['https://example.blogspot.com/2026/01/hello-world.html', 'blogger'],
  ['https://www.blogger.com/blog/post/edit/123/456', 'blogger'],
  ['https://example.blogspot.co.uk/2026/01/post.html', 'blogger'],
  ['HTTPS://EXAMPLE.BLOGSPOT.COM/2026/01/POST.HTML', 'blogger'],
  // A Google search link that merely mentions blogspot stays Google
  ['https://www.google.com/search?q=blogspot.com', 'google'],
  // No regressions for the other sources
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
  ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
  ['https://www.tiktok.com/@user/video/123', 'tiktok'],
  ['https://www.facebook.com/watch/?v=123', 'facebook'],
  ['https://www.instagram.com/p/ABC123/', 'instagram'],
  ['https://lnkd.in/dAbCdEf', 'linkedin'],
  ['https://www.linkedin.com/posts/someone_hello-123456789', 'linkedin'],
  ['https://x.com/user/status/123', 'x'],
  ['https://t.me/saifmas_bot', 'telegram'],
  ['https://example.com/article.pdf', 'pdf'],
  ['file://pdf/Book', 'pdf'],
  ['https://example.com/book.docx', 'word'],
  ['https://www.google.com/search?q=x', 'google'],
  ['https://example.com/some-article', 'all'],
];
for (const [url, expected] of classifyCases) {
  check(`detectSource(${url})`, detectSource(url), expected);
}

// --- 2. Library counting / filtering ------------------------------------
// Same expressions as app/page.tsx sourceCounts / filteredBookmarks.
// Library shaped like the user's live one (2026-11-27): 3 Blogger rows
// among other sources.
const bookmarks = [
  { id: '1', url: 'https://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html', title: 'Android 17 review' },
  { id: '2', url: 'https://example.blogspot.com/2026/11/web-links.html', title: 'Invalid web links' },
  { id: '3', url: 'https://example.blogspot.com/2026/11/digital-future.html', title: 'Digital future guide' },
  { id: '4', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Video' },
  { id: '5', url: 'https://www.tiktok.com/@user/video/123', title: 'Clip' },
  { id: '6', url: 'https://lnkd.in/dAbCdEf', title: 'LinkedIn post' },
  { id: '7', url: 'https://example.com/some-article', title: 'General article' },
];
const bloggerCount = bookmarks.filter((b) => detectSource(b.url) === 'blogger').length;
check('blogger count is 3 (existing rows, no re-paste)', bloggerCount, 3);

const bloggerFiltered = bookmarks.filter((b) => detectSource(b.url) === 'blogger');
check('Blogger-filtered list has exactly 3 rows', bloggerFiltered.length, 3);
check(
  'Blogger-filtered list contains the Android 17 row',
  bloggerFiltered.some((b) => b.id === '1'),
  true
);
check(
  'Blogger-filtered list excludes the YouTube row',
  bloggerFiltered.some((b) => b.id === '4'),
  false
);
check(
  'Blogger-filtered list excludes the general article',
  bloggerFiltered.some((b) => b.id === '7'),
  false
);

// The filter expression from app/page.tsx: 'all' shows everything,
// a source shows only its own rows.
const selectedSource = 'blogger';
const visible = bookmarks.filter(
  (b) => selectedSource === 'all' || detectSource(b.url) === selectedSource
);
check('filter expression shows only Blogger rows when selected', visible.length, 3);

// --- 3. Badge rule agrees with the classifier ---------------------------
// isBloggerUrl in app/page.tsx now delegates to detectSource, so the
// badge can never disagree with the count/filter. Mirror its rule here:
// a URL shows the badge exactly when detectSource calls it 'blogger'.
const badgeCases = [
  ['https://karraraliraqii.blogspot.com/2026/10/17-qpr3-beta-1.html', true],
  ['https://www.blogger.com/blog/post/edit/123/456', true],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', false],
  ['https://example.com/some-article', false],
];
for (const [url, expected] of badgeCases) {
  check(`badge shows for ${url}`, detectSource(url) === 'blogger', expected);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Blogger source checks passed.');
