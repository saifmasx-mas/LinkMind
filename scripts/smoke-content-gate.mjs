// Smoke test for the shared content gate (lib/content-gate.ts).
//
// Run: node scripts/smoke-content-gate.mjs
//
// Regression test for (2026-11-26): the CONTENT_UNAVAILABLE gate from
// PR #6 covered YouTube, TikTok and LinkedIn only. A general article or
// blog link whose fetch failed reached Gemini as a bare URL and was saved
// with an invented summary — and a credit was deducted. The Telegram bot
// save path had no gate at all, and never resolved short links before
// the duplicate check.
//
// What this test proves, with no external network:
//   1. hasRealLinkContent refuses a general page whose fetch failed, or
//      that brought back no real title, no real description and no body
//      text — the exact decision the 503 CONTENT_UNAVAILABLE path in
//      /api/analyze and in the Telegram bot hinges on. Both routes call
//      the gate BEFORE any Gemini call, save or credit deduction, so a
//      refusal means nothing is saved and nothing is charged.
//   2. Real articles still pass (title, description, or long body text),
//      and the YouTube / TikTok / LinkedIn rules are unchanged.
//   3. extractYouTubeId recognises every YouTube URL form the web and
//      bot paths accept.
//   4. resolveShortUrl canonicalises a short link to one final URL, so
//      the bot's duplicate check (exact URL match) catches a re-paste.

import { createServer } from 'node:http';
import { hasRealLinkContent, isLoginWallTitle } from '../lib/content-gate.ts';
import { extractYouTubeId } from '../lib/youtube.ts';
import { resolveShortUrl } from '../lib/short-url.ts';

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const general = (over = {}) =>
  hasRealLinkContent({
    kind: 'general',
    fetchFailed: false,
    hasRealTitle: false,
    hasRealDescription: false,
    hasTranscript: false,
    bodyTextLength: 0,
    title: '',
    ...over,
  });
const youtube = (over = {}) => general({ kind: 'youtube', ...over });
const tiktok = (over = {}) => general({ kind: 'tiktok', ...over });
const linkedin = (over = {}) => general({ kind: 'linkedin', ...over });

// --- 1. General pages: the bug this PR fixes ---------------------------
// A failed fetch must be refused even if a stale title were present.
check('general: failed fetch is refused', general({ fetchFailed: true }), false);
check(
  'general: failed fetch with a title is still refused',
  general({ fetchFailed: true, hasRealTitle: true, title: 'Old title' }),
  false
);
// The bare URL alone is not content.
check(
  'general: bare URL (no title, no text) is refused',
  general({ title: 'https://example.com/some-article' }),
  false
);
// Real content still passes.
check(
  'general: real title is enough',
  general({ hasRealTitle: true, title: 'How the brain learns reading' }),
  true
);
check(
  'general: real description is enough',
  general({ hasRealDescription: true, title: 'https://example.com/x' }),
  true
);
check('general: long body text is enough', general({ bodyTextLength: 5400 }), true);
check('general: 50 chars of body alone is not enough', general({ bodyTextLength: 50 }), false);
check('general: 100 chars of body alone is enough', general({ bodyTextLength: 100 }), true);

// --- 2. YouTube / TikTok: no regression --------------------------------
check('youtube: transcript only passes', youtube({ hasTranscript: true, bodyTextLength: 900 }), true);
check(
  'youtube: API title + description passes',
  youtube({ hasRealTitle: true, hasRealDescription: true, title: 'My video' }),
  true
);
check('youtube: nothing at all is refused', youtube({}), false);
check(
  'tiktok: page description passes',
  tiktok({ hasRealTitle: true, hasRealDescription: true }),
  true
);
check('tiktok: nothing at all is refused', tiktok({}), false);

// --- 3. LinkedIn: no regression ----------------------------------------
check('linkedin: failed fetch is refused', linkedin({ fetchFailed: true }), false);
check(
  'linkedin: wall title is refused',
  linkedin({ hasRealTitle: true, bodyTextLength: 300, title: 'LinkedIn' }),
  false
);
check(
  'linkedin: sign-up wall title is refused',
  linkedin({ hasRealTitle: true, bodyTextLength: 300, title: 'Sign Up | LinkedIn' }),
  false
);
check(
  'linkedin: login wall title is refused',
  linkedin({ hasRealTitle: true, bodyTextLength: 300, title: 'Log in | LinkedIn' }),
  false
);
check(
  'linkedin: specific title + body passes',
  linkedin({ hasRealTitle: true, bodyTextLength: 1200, title: 'Sara on LinkedIn: hiring designers' }),
  true
);
check(
  'linkedin: specific title but no body is refused',
  linkedin({ hasRealTitle: true, bodyTextLength: 0, title: 'Sara on LinkedIn: hiring designers' }),
  false
);
check('isLoginWallTitle: plain LinkedIn', isLoginWallTitle('LinkedIn'), true);
check('isLoginWallTitle: real post title', isLoginWallTitle('Sara on LinkedIn: hiring'), false);

// --- 4. YouTube id extraction (shared by web + bot) --------------------
check(
  'extractYouTubeId watch',
  extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
  'dQw4w9WgXcQ'
);
check('extractYouTubeId youtu.be', extractYouTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
check(
  'extractYouTubeId shorts',
  extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'),
  'dQw4w9WgXcQ'
);
check(
  'extractYouTubeId non-youtube',
  extractYouTubeId('https://example.com/watch?v=dQw4w9WgXcQ'),
  null
);

// --- 5. Short-link resolution for the bot (local server) ---------------
const server = createServer((req, res) => {
  if (req.url === '/lnkd') {
    res.writeHead(302, { Location: '/in/post' });
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
  const resolved = await resolveShortUrl(`${base}/lnkd`, ['127.0.0.1'], isLocal);
  check('bot: short link resolves to canonical URL', resolved, `${base}/in/post`);

  // Duplicate detection is an exact match on the canonical URL, so the
  // same short link must always canonicalise to the same value.
  const again = await resolveShortUrl(`${base}/lnkd`, ['127.0.0.1'], isLocal);
  check('bot: same short link canonicalises identically (dedup catches re-paste)', resolved === again, true);

  const trapped = await resolveShortUrl(`${base}/trap`, ['127.0.0.1'], isLocal);
  check('bot: redirect to a disallowed host returns the original URL', trapped, `${base}/trap`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll content-gate checks passed.');
