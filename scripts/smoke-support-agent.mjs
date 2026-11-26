// Smoke test for the Telegram support agent (lib/support-knowledge.ts,
// the purchase-intent message in lib/admin.ts, and the support branch in
// app/api/telegram/route.ts).
//
// Run: node scripts/smoke-support-agent.mjs
//
// No Supabase, no Telegram and no network needed: it tests the pure
// helpers the webhook depends on — purchase-intent detection, language
// detection, the knowledge-grounded prompt, the purchase handoff and
// fallback replies, and what the admin is notified about — plus static
// checks that a question reaches the support branch (linked or not),
// that link saving still requires a linked account with a credit check,
// and that /start linking is untouched. The route itself is verified by
// `tsc --noEmit` and `next build`, and the live behaviour (a real
// question and a real purchase message to @saifmas_bot) still needs a
// test on the deployed site.
//
// Regression test for: the bot answered every non-link message with
// "send a valid link", so it could not answer customer questions, and
// a buyer who wanted to pay had no path to the owner.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Compile the two lib files the same way smoke-admin-signup.mjs does.
const outDir = mkdtempSync(join(process.cwd(), '.tmp-support-agent-test-'));
try {
  execSync(
    `./node_modules/.bin/tsc lib/support-knowledge.ts lib/admin.ts --outDir ${outDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --declaration false`,
    { stdio: 'pipe' }
  );
} catch (error) {
  console.error(
    'Failed to compile lib/support-knowledge.ts and lib/admin.ts:',
    error.stdout?.toString(),
    error.stderr?.toString()
  );
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}
const support = await import(join(outDir, 'support-knowledge.js'));
const adminLib = await import(join(outDir, 'admin.js'));
const {
  detectPurchaseIntent,
  detectSupportLanguage,
  buildSupportPrompt,
  buildPurchaseHandoffReply,
  buildSupportFallbackReply,
  SUPPORT_KNOWLEDGE,
  WHATSAPP_LINK,
} = support;
const { buildPurchaseIntentTelegramMessage } = adminLib;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 1. Purchase intent: a decision to buy or pick a plan hands off to the owner.
check('buy decision (ar) is purchase intent', detectPurchaseIntent('أريد شراء باقة الطلاب') === true);
check('subscribe decision (ar) is purchase intent', detectPurchaseIntent('بدي اشترك بالباقة الذهبية') === true);
check('choose a plan (ar) is purchase intent', detectPurchaseIntent('أريد خطة صناع المحتوى') === true);
check('how to pay (ar) is purchase intent', detectPurchaseIntent('كيف أدفع؟') === true);
check('buy decision (en) is purchase intent', detectPurchaseIntent('I want to buy the student plan') === true);
check('subscribe (en) is purchase intent', detectPurchaseIntent('How do I subscribe?') === true);
// ...while a facts-only question about a price or a plan stays with the bot.
check('price question (ar) is NOT purchase intent', detectPurchaseIntent('كم سعر باقة الطلاب؟') === false);
check('plans question (ar) is NOT purchase intent', detectPurchaseIntent('ما هي الباقات المتوفرة؟') === false);
check('know-the-price (ar) is NOT purchase intent', detectPurchaseIntent('أريد أن أعرف سعر الباقة') === false);
check('price question (en) is NOT purchase intent', detectPurchaseIntent('How much is the student plan?') === false);
check('what-is question is NOT purchase intent', detectPurchaseIntent('ما هو موقع LinkMind؟') === false);
check('how-it-works is NOT purchase intent', detectPurchaseIntent('كيف يعمل الموقع؟') === false);

// 2. Language detection: reply in the sender's language.
check('Arabic detected', detectSupportLanguage('كيف أحفظ رابط يوتيوب؟') === 'ar');
check('English detected', detectSupportLanguage('What is LinkMind?') === 'en');
check('Turkish detected by diacritics', detectSupportLanguage('LinkMind nasıl çalışır?') === 'tr');
check('Turkish detected by word', detectSupportLanguage('Fiyat nedir?') === 'tr');
check('English plan question stays English', detectSupportLanguage('What is the plan price?') === 'en');
check('empty/emoji defaults to Arabic', detectSupportLanguage('👍') === 'ar');

// 3. The knowledge base the bot may answer from: prices, plans, payment.
check('KB has the student plan price', SUPPORT_KNOWLEDGE.includes('$5') || SUPPORT_KNOWLEDGE.includes('5 دولارات'));
check('KB has the creators plan price', SUPPORT_KNOWLEDGE.includes('$12') || SUPPORT_KNOWLEDGE.includes('12 دولاراً'));
check('KB says payment is manual', SUPPORT_KNOWLEDGE.includes('يدوي'));
check('KB lists the supported sources', ['YouTube', 'TikTok', 'LinkedIn', 'PDF'].every((s) => SUPPORT_KNOWLEDGE.includes(s)));
check('KB has the WhatsApp link', SUPPORT_KNOWLEDGE.includes(WHATSAPP_LINK));

// 4. The Gemini prompt grounds the answer: KB + question + no invention.
const prompt = buildSupportPrompt('كم سعر باقة الطلاب؟', 'ar');
check('prompt contains the knowledge base', prompt.includes(SUPPORT_KNOWLEDGE));
check('prompt contains the question', prompt.includes('كم سعر باقة الطلاب؟'));
check('prompt forbids inventing prices', /do not invent prices/i.test(prompt));
check('prompt forbids promising automated payment', /do not promise automated payment/i.test(prompt));
check('prompt answers in Arabic for an Arabic question', prompt.includes('Answer the user\'s question in Arabic'));

// 5. Purchase handoff: the buyer is told the owner will contact them,
// and gets the WhatsApp link — in their own language.
for (const lang of ['ar', 'en', 'tr']) {
  const reply = buildPurchaseHandoffReply(lang);
  check(`handoff reply (${lang}) has the WhatsApp link`, reply.includes(WHATSAPP_LINK));
  check(`handoff reply (${lang}) says the owner will contact them`, /صاحب الموقع|site owner|site sahibi/i.test(reply));
  check(`handoff reply (${lang}) never promises automated payment`, !/automatic|automated|تلقائي|otomatik/i.test(reply));
}

// 6. Fallback reply (Gemini unavailable) still points to WhatsApp.
for (const lang of ['ar', 'en', 'tr']) {
  check(`fallback reply (${lang}) has the WhatsApp link`, buildSupportFallbackReply(lang).includes(WHATSAPP_LINK));
}

// 7. Admin notification for a purchase intent: buyer's exact words + time.
const purchaseMsg = buildPurchaseIntentTelegramMessage('أريد شراء باقة الطلاب', 987654321, Date.parse('2026-11-26T20:00:00+03:00'));
check('admin purchase message contains the buyer words', purchaseMsg.includes('أريد شراء باقة الطلاب'));
check('admin purchase message marks it as a purchase', purchaseMsg.includes('شراء'));
check('admin purchase message carries the chat id', purchaseMsg.includes('987654321'));
check('admin purchase message carries the time', purchaseMsg.includes('2026'));

// 8. Static checks on the webhook: support answers any sender, link
// saving still requires a linked account and a credit check, /start
// linking is untouched.
const route = readFileSync('app/api/telegram/route.ts', 'utf8');
check(
  'route checks purchase intent before answering',
  route.indexOf('detectPurchaseIntent') < route.indexOf('answerSupportQuestion') &&
    route.includes('notifyAdminOfPurchaseIntent')
);
check(
  'route answers non-link messages via support (no link required)',
  route.includes('if (!url)') && route.includes('answerSupportQuestion(text)')
);
check(
  'route no longer tells questioners to send a link',
  !route.includes('أرسل رابطاً عاماً صحيحاً')
);
check(
  'route still requires a linked account before saving a link',
  route.includes("اربط حسابك من داخل موقع LinkMind قبل إرسال الروابط")
);
check('route still checks credits before saving', route.includes('deductCredit'));
check('route still dedupes saved links', route.includes('this link is already saved') || route.includes('محفوظ لديك مسبقاً'));
check('route still handles /start linking', route.includes('/start') && route.includes('telegram_link_tokens'));
check('route reuses the shared Telegram sender', route.includes("from '@/lib/telegram-send'"));
check('route reuses the admin helpers', route.includes("from '@/lib/admin'"));

rmSync(outDir, { recursive: true, force: true });

console.log(failures === 0 ? '\nAll support-agent checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
