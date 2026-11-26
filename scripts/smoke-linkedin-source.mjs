// Smoke test for the LinkedIn invisible-bookmark fix.
//
// Run: node scripts/smoke-linkedin-source.mjs
//
// Regression test for (2026-11-26): the user pasted a LinkedIn share link
// from the app, which is a short lnkd.in link. The site saved it (the
// duplicate check proved the row existed) but the library never counted
// it as LinkedIn and the card vanished under the LinkedIn filter:
// detectSource only matched 'linkedin.com', and short links were never
// resolved to the canonical URL. The row was invisible even though it
// was saved.
//
// Covers, with no external network:
//   1. detectSource classifies lnkd.in (and linkedin.com) as LinkedIn,
//      with no regressions for the other sources.
//   2. A row saved earlier with an lnkd.in URL is counted under LinkedIn
//      and shows in the LinkedIn-filtered list — no re-paste needed.
//   3. resolveShortUrl follows a same-host redirect, refuses a redirect
//      to a disallowed host, and passes non-short URLs through untouched.
//   4. Resolving the same short link twice gives the same canonical URL,
//      so the server-side duplicate check (exact URL match) catches a
//      re-paste.

import { createServer } from 'node:http';
import { detectSource } from '../lib/source-detect.ts';
import { resolveShortUrl } from '../lib/short-url.ts';

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// --- 1. Classification -------------------------------------------------
const classifyCases = [
  // [url, expected] — the reported bug: lnkd.in short links
  ['https://lnkd.in/dAbCdEf', 'linkedin'],
  ['http://lnkd.in/dAbCdEf', 'linkedin'],
  ['https://lnkd.in/dAbCdEf?utm_source=share&utm_medium=member_android', 'linkedin'],
  ['HTTPS://LNKD.IN/DABCDEF', 'linkedin'],
  ['https://www.linkedin.com/posts/someone_hello-123456789', 'linkedin'],
  ['https://www.linkedin.com/in/someone', 'linkedin'],
  ['https://linkedin.com/company/example', 'linkedin'],
  // No regressions for the other sources
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
  ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
  ['https://www.tiktok.com/@user/video/123', 'tiktok'],
  ['https://vt.tiktok.com/ZSs67hEm3/', 'tiktok'],
  ['https://vm.tiktok.com/ZM123/', 'tiktok'],
  ['https://www.facebook.com/watch/?v=123', 'facebook'],
  ['https://www.instagram.com/p/ABC123/', 'instagram'],
  ['https://x.com/user/status/123', 'x'],
  ['https://twitter.com/user/status/123', 'x'],
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
const bookmarks = [
  { id: '1', url: 'https://lnkd.in/dAbCdEf', title: 'LinkedIn post (short link)' },
  { id: '2', url: 'https://www.linkedin.com/posts/someone_hello-123', title: 'LinkedIn post' },
  { id: '3', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Video' },
  { id: '4', url: 'https://vt.tiktok.com/ZSs67hEm3/', title: 'Clip' },
  { id: '5', url: 'https://example.com/book.pdf', title: 'Book' },
];
const linkedinCount = bookmarks.filter((b) => detectSource(b.url) === 'linkedin').length;
check('linkedin count includes the old lnkd.in row', linkedinCount, 2);
const linkedinFiltered = bookmarks.filter((b) => detectSource(b.url) === 'linkedin');
check(
  'LinkedIn-filtered list contains the lnkd.in row',
  linkedinFiltered.some((b) => b.id === '1'),
  true
);
check(
  'LinkedIn-filtered list contains the linkedin.com row',
  linkedinFiltered.some((b) => b.id === '2'),
  true
);

// --- 3 + 4. Short-link resolution (local server, no external network) ---
const server = createServer((req, res) => {
  if (req.url === '/short') {
    res.writeHead(302, { Location: '/final' });
    res.end();
  } else if (req.url === '/trap') {
    res.writeHead(302, { Location: 'http://example.com/' });
    res.end();
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const isLocal = (h) => h === '127.0.0.1';

try {
  const resolved = await resolveShortUrl(`${base}/short`, ['127.0.0.1'], isLocal);
  check('same-host redirect resolves to the final URL', resolved, `${base}/final`);

  const trapped = await resolveShortUrl(`${base}/trap`, ['127.0.0.1'], isLocal);
  check('redirect to a disallowed host returns the original URL', trapped, `${base}/trap`);

  check(
    'non-short host passes through untouched',
    await resolveShortUrl('https://example.com/x', ['lnkd.in'], () => true),
    'https://example.com/x'
  );
  check(
    'invalid URL passes through untouched',
    await resolveShortUrl('not a url', ['lnkd.in'], () => true),
    'not a url'
  );

  // Duplicate detection is an exact match on the canonical URL, so the
  // same short link must always canonicalise to the same value.
  const first = await resolveShortUrl(`${base}/short`, ['127.0.0.1'], isLocal);
  const second = await resolveShortUrl(`${base}/short`, ['127.0.0.1'], isLocal);
  check('same short link canonicalises identically (duplicate is caught)', first === second, true);
  check('canonical URL is the resolved final URL', first, `${base}/final`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll LinkedIn source checks passed.');
