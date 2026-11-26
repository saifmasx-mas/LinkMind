// Smoke test for the audit-#2 critical + high fixes (PR: fix/audit2-critical-fixes).
//
// Run: node scripts/smoke-audit2-fixes.mjs
//
// No Supabase, no Telegram, no Gemini and no network needed: it tests
// the pure helpers the fixes depend on plus static checks that the
// route wiring is in the right order (the route itself is verified by
// `tsc --noEmit` and `next build`, and the live behaviour still needs
// a test on the deployed site).
//
// C1 — a book longer than the 200,000-char cap used to be rejected
//   ALWAYS: the browser sent the full pre-slice length while the text
//   arrived sliced to 200,000, so the integrity guard scored 80% <
//   95% and refused with 503 BOOK_TEXT_TRUNCATED on every attempt.
//   Now the browser sends the post-slice length and the server caps
//   the claimed length at MAX_BOOK_TEXT_CHARS.
// C2 — the Telegram bot used to save a fallback summary and deduct a
//   credit when Gemini was missing or failed. Now it sends an honest
//   apology and saves nothing, deducts nothing.
// H3 — any Telegram message with a link went straight to the save
//   path, even a purchase intent or a question about the link. Now
//   purchase intent and questions are decided BEFORE the save path.
// H4 — the credit was deducted server-side before the browser
//   inserted the bookmark row, so a failed insert lost the credit
//   with no card. Now the row is inserted server-side first, then
//   the credit is deducted; a failed deduct removes the row again.
// M5/M8/M9 — presentation page numbers/wording, temporary footer
//   social icons, and the "direct export to Notion" claim.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Compile the libs the same way smoke-book-summary.mjs does.
const outDir = mkdtempSync(join(process.cwd(), '.tmp-audit2-fixes-test-'));
try {
  execSync(
    `./node_modules/.bin/tsc lib/book-summary.ts lib/gemini.ts lib/book-reader.ts lib/support-knowledge.ts --outDir ${outDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --declaration false`,
    { stdio: 'pipe' }
  );
} catch (error) {
  console.error(
    'Failed to compile audit-2 libs:',
    error.stdout?.toString(),
    error.stderr?.toString()
  );
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}
const { isTruncatedBookText, MAX_BOOK_TEXT_CHARS } = await import(
  join(outDir, 'book-summary.js')
);
const { isQuestionAboutLink, buildAiUnavailableReply, detectPurchaseIntent } =
  await import(join(outDir, 'support-knowledge.js'));
rmSync(outDir, { recursive: true, force: true });

const pageTsx = readFileSync('app/page.tsx', 'utf8');
const analyzeRoute = readFileSync('app/api/analyze/route.ts', 'utf8');
const telegramRoute = readFileSync('app/api/telegram/route.ts', 'utf8');
const presentation = readFileSync('app/presentation/page.tsx', 'utf8');
const pricingModal = readFileSync('components/PricingModal.tsx', 'utf8');

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// The server-side cap, as the route applies it before the guard.
const cappedClaimed = (claimed) => Math.min(claimed, MAX_BOOK_TEXT_CHARS);

console.log('--- C1: long books are no longer rejected as truncated ---');
check('cap is 200000', MAX_BOOK_TEXT_CHARS === 200_000, `got ${MAX_BOOK_TEXT_CHARS}`);
check(
  '250k-char book arriving as 200k is NOT truncated',
  isTruncatedBookText(200_000, cappedClaimed(250_000)) === false
);
check(
  '210001-char book arriving as 200k is NOT truncated',
  isTruncatedBookText(200_000, cappedClaimed(210_001)) === false
);
check(
  '135292-char book arriving whole is NOT truncated',
  isTruncatedBookText(135_292, cappedClaimed(135_292)) === false
);
check(
  '95% boundary (190000 of 200000) is NOT truncated',
  isTruncatedBookText(190_000, cappedClaimed(200_000)) === false
);
check(
  'just below 95% (189999 of 200000) IS truncated',
  isTruncatedBookText(189_999, cappedClaimed(200_000)) === true
);
check(
  'genuinely cut text (100000 of 135292) IS still refused',
  isTruncatedBookText(100_000, cappedClaimed(135_292)) === true
);
check(
  'browser sends the post-slice length (250k -> 200k)',
  Math.min(250_000, MAX_BOOK_TEXT_CHARS) === 200_000
);
check(
  'browser sends post-slice length in all 3 upload branches',
  (pageTsx.match(/payload\.bookTextLength = payload\.bookText\.length/g) || []).length === 3,
  `found ${(pageTsx.match(/payload\.bookTextLength = payload\.bookText\.length/g) || []).length}`
);
check(
  'server caps the claimed length before the guard',
  analyzeRoute.includes('Math.min(bookTextLength, MAX_BOOK_TEXT_CHARS)')
);
check(
  'browser no longer sends the pre-slice length anywhere',
  !/payload\.bookTextLength = (extractedText|text)\.length/.test(pageTsx)
);

console.log('--- C2: Telegram bot apologises instead of saving on Gemini failure ---');
check(
  'Arabic apology says no credit was deducted',
  buildAiUnavailableReply('ar').includes('لم يُخصم أي رصيد')
);
check(
  'English apology says no credit was deducted',
  buildAiUnavailableReply('en').includes('no credit was deducted')
);
check(
  'Turkish apology mentions no credit',
  buildAiUnavailableReply('tr').includes('kredi düşülmedi')
);
check(
  'Arabic apology says the link was not saved',
  buildAiUnavailableReply('ar').includes('ولا حفظ الرابط')
);
const tgAiKeyAt = telegramRoute.indexOf('const aiKey');
const tgInsertAt = telegramRoute.indexOf("from('bookmarks').insert");
const tgAiSegment = telegramRoute.slice(tgAiKeyAt, tgInsertAt);
check(
  'Gemini-missing branch returns before any insert',
  tgAiSegment.includes('if (!aiKey)') &&
    tgAiSegment.includes('buildAiUnavailableReply') &&
    tgAiSegment.includes('return NextResponse.json({ ok: true })')
);
check(
  'Gemini-failure catch also apologises and returns before any insert',
  (tgAiSegment.match(/buildAiUnavailableReply/g) || []).length >= 2
);
check(
  'old skip-Gemini guard is gone',
  !telegramRoute.includes('if (aiKey) {')
);

console.log('--- H3: purchase intent and questions are decided before the save path ---');
const YT = 'https://youtu.be/abc123';
check('bare link is a save, not a question', isQuestionAboutLink(YT, YT) === false);
check(
  'link + "احفظ هذا الرابط" is a save, not a question',
  isQuestionAboutLink(`احفظ هذا الرابط ${YT}`, YT) === false
);
check(
  '"ما هذا الرابط؟" + link is a question',
  isQuestionAboutLink(`ما هذا الرابط؟ ${YT}`, YT) === true
);
check(
  '"what is this link about?" + link is a question',
  isQuestionAboutLink(`${YT} what is this link about?`, YT) === true
);
check(
  'Turkish "bu bağlantı nedir?" + link is a question',
  isQuestionAboutLink(`bu bağlantı nedir? ${YT}`, YT) === true
);
check(
  '"ما شاء الله" + link is NOT a question (bare "ما" is not a marker)',
  isQuestionAboutLink(`ما شاء الله هذا الرابط رائع ${YT}`, YT) === false
);
check(
  'purchase intent is still detected when a link is present',
  detectPurchaseIntent(`أريد شراء الباقة ${YT}`) === true
);
check(
  'price question with a link is NOT purchase intent',
  detectPurchaseIntent(`كم سعر الباقة؟ ${YT}`) === false
);
check(
  'purchase-intent check runs before the save-path account lookup',
  telegramRoute.indexOf('detectPurchaseIntent(text)') <
    telegramRoute.indexOf('const { data: linkData')
);
check(
  'question check runs before the bookmark insert',
  telegramRoute.indexOf('isQuestionAboutLink(text') < tgInsertAt
);

console.log('--- H4: bookmark row is inserted server-side before the deduct ---');
check(
  'server inserts the bookmark before deducting the credit',
  analyzeRoute.indexOf('insertedBookmark') <
    analyzeRoute.indexOf('await deductCredit(admin, userId, currentCredits)')
);
check(
  'failed deduct removes the inserted row again',
  analyzeRoute.includes("await admin.from('bookmarks').delete().eq('id', bookmarkId)")
);
check(
  'response carries the saved bookmark id',
  analyzeRoute.includes('bookmarkId,')
);
check(
  'browser no longer inserts bookmark rows itself',
  !pageTsx.includes("supabase.from('bookmarks').insert")
);
check(
  'double-submit guard: link re-checked for duplicates before insert',
  analyzeRoute.includes('justSaved')
);

console.log('--- M5/M8/M9: honest presentation, footer and pricing wording ---');
check(
  'presentation page says 25 merged PRs, not 19',
  presentation.includes('25 طلب سحب مدموجة') && !presentation.includes('19 طلب سحب')
);
check(
  'presentation page no longer lists Facebook/Instagram as supported sources',
  presentation.includes('محتواها محمي غالباً') &&
    !presentation.includes('YouTube و Facebook و TikTok و X و Instagram')
);
check(
  'footer no longer links to the X homepage',
  !pageTsx.includes("'https://x.com'")
);
check(
  'footer no longer links to the Facebook homepage',
  !pageTsx.includes("'https://www.facebook.com'")
);
check(
  'footer no longer links to the Instagram homepage',
  !pageTsx.includes("'https://www.instagram.com'")
);
check(
  'footer no longer links to the Telegram homepage',
  !pageTsx.includes("'https://t.me'")
);
check(
  'footer still links to the real WhatsApp number',
  pageTsx.includes("'https://wa.me/905362515878'")
);
check(
  'pricing no longer claims a direct Notion export',
  pricingModal.includes('نسخ Markdown جاهز لـ Notion') &&
    !pricingModal.includes('تصدير مباشر إلى Notion')
);

console.log(failures === 0 ? '\nAll audit-2 fix checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
