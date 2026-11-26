/**
 * Support knowledge base for the Telegram support agent (2026-11-26).
 *
 * The bot answers customer questions ONLY from the facts below. Prices,
 * plans and payment methods change rarely and are deliberately kept as
 * plain constants here (not in the database), so the bot can never invent
 * a price or promise a payment method that does not exist. When a price
 * or a plan changes on the site, update SUPPORT_KNOWLEDGE in this file
 * and the pricing modal together.
 *
 * Everything in this file is dependency-free and unit-testable:
 * purchase-intent detection, language detection and reply builders are
 * pure functions, exercised by scripts/smoke-support-agent.mjs.
 */

export const WHATSAPP_LINK = 'https://wa.me/905362515878';
export const SITE_URL = 'https://link-mind-bay.vercel.app';
export const TELEGRAM_BOT_USERNAME = 'saifmas_bot';

/**
 * The facts the support agent may use. Written in Arabic (the site's
 * primary language); the Gemini prompt instructs the model to answer in
 * the sender's language, translating these facts without adding any.
 */
export const SUPPORT_KNOWLEDGE = `LinkMind — ذاكرة سحابية ذكية للروابط والكتب:
- يلصق المستخدم رابطاً أو يرفع كتاباً، فيحوّله الذكاء الاصطناعي إلى ملخص وخطوات عملية محفوظة في مكتبة سحابية قابلة للبحث.
- المصادر المدعومة: YouTube و Facebook و TikTok و X (تويتر) و Instagram والمقالات والمدونات وملفات PDF و Word.
- LinkedIn غير قابل للتلخيص: LinkedIn يمنع جلب محتواه (جدار تسجيل دخول)، فالموقع يخبر المستخدم بذلك بصراحة بدل إنشاء ملخص.
- الرصيد المجاني: كل حساب جديد يحصل على 5 شروحات مجانية عند التسجيل.
- الباقات:
  • باقة الطلاب: 5 دولارات مقابل 50 شرحاً، دفعة واحدة، والرصيد لا تنتهي صلاحيته أبداً.
  • باقة صناع المحتوى والمدربين: 12 دولاراً شهرياً، شروحات وكتب غير محدودة.
- الدفع: لا توجد بوابة دفع آلية بعد. الدفع حالياً يدوي عبر واتساب أو تيليجرام، وتُفعَّل الباقة يدوياً بعد إتمام الدفع.
- كيفية حفظ رابط من الموقع: الصق الرابط في خانة الحفظ واضغط «حفظ وتلخيص».
- كيفية حفظ رابط من تيليجرام: اربط حسابك أولاً من الموقع (زر «ربط Telegram») ثم أرسل الرابط إلى هذا البوت.
- كيفية ربط تيليجرام: افتح موقع LinkMind وسجّل دخولك، اضغط زر «ربط Telegram»، ثم أرسل /start إلى بوت @saifmas_bot.
- كيفية رفع كتاب: من الموقع اضغط «رفع كتاب» واختر ملف PDF أو Word؛ يحصل الكتاب على ملخص شامل فصلاً بفصل.
- التواصل المباشر والدفع: واتساب ${WHATSAPP_LINK}
- الموقع: ${SITE_URL}`;

export type SupportLanguage = 'ar' | 'en' | 'tr';

/**
 * Detect the sender's language from their message. Arabic if it contains
 * Arabic letters, Turkish if it contains Turkish-specific letters or
 * common Turkish words, English otherwise. Arabic is the default for
 * anything else (emoji-only, numbers, a bare link).
 */
export function detectSupportLanguage(text: string): SupportLanguage {
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (
    /[çğıöşüÇĞİÖŞÜ]/.test(text) ||
    /\b(merhaba|nasıl|nedir|nasil|fiyat|paket|satın|satın almak|abone|kredi|özet|nasıl çalışır|istiyorum|yardım)\b/i.test(
      text
    )
  ) {
    return 'tr';
  }
  if (/[a-zA-Z]/.test(text)) return 'en';
  return 'ar';
}

// A question that only asks for facts (a price, the plans, how the site
// works) is answered by the bot from the knowledge base — it is NOT a
// purchase decision, even though it mentions a plan or a price.
const INFO_QUESTION_PATTERN =
  /(كم|ما\s|ماذا|شو|ايش|وش|هل|أخبرني|اخبرني|ما\sهي|ما\sهو|how much|what (is|are)|what's|tell me about)\b[^.؟?]{0,60}(سعر|أسعار|باقة|باقات|خطة|خطط|اشتراك|price|plan|subscription)/i;

// The same for "I want to know the price" — a request for information,
// not a decision to buy.
const KNOW_PRICE_PATTERN =
  /(أريد|اريد|بدي|أبغى|ابغى|أرغب|ارغب|حابب|حابة).{0,25}(أعرف|اعرف|معرفة|أن أعرف|ان أعرف).{0,25}(سعر|أسعار|باقة|باقات|خطة|خطط|price|plan)/i;

// Buying-decision signals: the sender says they want to buy, subscribe,
// pay or activate a plan, or asks how to pay. Any of these hands the
// conversation to the owner (Saif) — the bot never handles payment.
const PURCHASE_DECISION_PATTERNS: RegExp[] = [
  // Arabic: "I want / let me / I will" + buy / subscribe / pay / activate / plan.
  /(أريد|اريد|بدي|أبغى|ابغى|أرغب|ارغب|حابب|حابة|ممكن|خليني|أبغي|ابغي|أود|اود).{0,30}(شراء|اشتري|اشترك|اشتراك|أدفع|ادفع|دفع|خطة|باقة|تفعيل|فعّل|فعل)/i,
  // Arabic: standalone decision verbs, with or without "I will".
  /(سأشتري|ساشتري|سأدفع|سادفع|سأشترك|ساشترك|سأفعّل|سافعل|اشتري|اشترك|ادفع|فعّل|فعل لي|اشترك لي|أريد تفعيل|اريد تفعيل)/i,
  // Arabic: asking how to pay / buy / subscribe.
  /كيف.{0,20}(أدفع|ادفع|أشتري|اشتري|أشترك|اشترك|أدفع|ادفع|أدخل|اشترك|الدفع|الشراء|الاشتراك)/i,
  // English: want / would like / going to + buy / subscribe / get a plan / pay.
  /(i want to|i'd like to|i would like to|i'm going to|im going to|i wanna|let me|i need to).{0,30}(buy|subscribe|pay|activate|get (the|a) .*plan|sign ?up)/i,
  // English: bare buy / subscribe / pay / plan words (per the spec's
  // keyword list), except when the message is a price/info question
  // (handled above).
  /\b(buy|subscribe|subscription|checkout|payment|pay now|activate (the|my|a) plan|i want the .*plan|sign ?me ?up)\b/i,
];

export function detectPurchaseIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Facts-only questions stay with the bot even when they mention a
  // plan or a price.
  if (INFO_QUESTION_PATTERN.test(trimmed) || KNOW_PRICE_PATTERN.test(trimmed)) {
    return false;
  }
  return PURCHASE_DECISION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

const PURCHASE_HANDOFF_REPLIES: Record<SupportLanguage, string> = {
  ar: `تمام، وصل طلبك! صاحب الموقع سيتواصل معك شخصياً لإتمام الدفع وتفعيل باقتك.\n\nويمكنك أيضاً مراسلته مباشرة على واتساب: ${WHATSAPP_LINK}`,
  en: `Got it! The site owner will contact you personally to complete the payment and activate your plan.\n\nYou can also reach him directly on WhatsApp: ${WHATSAPP_LINK}`,
  tr: `Tamam, isteğiniz alındı! Site sahibi ödemeyi tamamlamak ve paketinizi etkinleştirmek için sizinle bizzat iletişime geçecek.\n\nWhatsApp üzerinden doğrudan da ulaşabilirsiniz: ${WHATSAPP_LINK}`,
};

/** Buyer-facing reply for a purchase decision: no payment handled here. */
export function buildPurchaseHandoffReply(language: SupportLanguage): string {
  return PURCHASE_HANDOFF_REPLIES[language];
}

const SUPPORT_FALLBACK_REPLIES: Record<SupportLanguage, string> = {
  ar: `عذراً، تعذّر الرد على سؤالك حالياً. جرّب مرة أخرى بعد قليل، أو راسلنا مباشرة على واتساب: ${WHATSAPP_LINK}`,
  en: `Sorry, I could not answer your question right now. Please try again in a bit, or message us directly on WhatsApp: ${WHATSAPP_LINK}`,
  tr: `Üzgünüz, sorunuza şu anda cevap veremedim. Lütfen biraz sonra tekrar deneyin veya WhatsApp üzerinden bize yazın: ${WHATSAPP_LINK}`,
};

/** Reply when the AI answer is unavailable (no key, or Gemini failed). */
export function buildSupportFallbackReply(language: SupportLanguage): string {
  return SUPPORT_FALLBACK_REPLIES[language];
}

/**
 * Gemini prompt for a support question. The model must answer ONLY from
 * SUPPORT_KNOWLEDGE: no invented prices, features or payment methods,
 * no promise of automated payment or instant activation, and no claim
 * to be human. If the question is outside the knowledge base, it says
 * so and points to WhatsApp.
 */
export function buildSupportPrompt(question: string, language: SupportLanguage): string {
  const languageName = language === 'ar' ? 'Arabic' : language === 'tr' ? 'Turkish' : 'English';
  return `You are LinkMind's support assistant on Telegram. Answer the user's question in ${languageName}, briefly (a few short lines at most), using ONLY the facts below. Do not invent prices, features or payment methods. Do not promise automated payment or instant activation — payment is manual via WhatsApp or Telegram and the plan is activated manually afterwards. Do not claim to be human; you are LinkMind's automated support assistant. If the question is outside these facts, say you do not know and suggest contacting us on WhatsApp: ${WHATSAPP_LINK}.

KNOWLEDGE BASE:
${SUPPORT_KNOWLEDGE}

USER QUESTION:
${question}`;
}
