import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import { GoogleGenAI, Type } from '@google/genai';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { fetchPublicUrl } from '@/lib/safe-fetch';
import { resolveShortUrl } from '@/lib/short-url';
import {
  fetchYouTubeApiMetadata,
  fetchYouTubeOEmbed,
  extractYouTubeId,
} from '@/lib/youtube';
import { fetchTikTokPageMetadata, fetchTikTokOEmbed } from '@/lib/tiktok';
import { hasRealLinkContent } from '@/lib/content-gate';
import { generateContentWithFallback } from '@/lib/gemini';
import { deductCredit } from '@/lib/credits';
import { checkRateLimit, pruneRateLimitBuckets } from '@/lib/rate-limit';
import { sendTelegramMessage } from '@/lib/telegram-send';
import {
  ADMIN_EMAIL,
  findAuthUserByEmail,
  buildPurchaseIntentTelegramMessage,
} from '@/lib/admin';
import {
  detectPurchaseIntent,
  detectSupportLanguage,
  buildPurchaseHandoffReply,
  buildSupportFallbackReply,
  buildSupportPrompt,
} from '@/lib/support-knowledge';

export const runtime = 'nodejs';

// I3: the default Hobby limit is 10s; Gemini + embedding + page fetch need
// the same 60s budget the analyze route already uses.
export const maxDuration = 60;

interface TelegramMessage {
  chat?: { id?: number };
  text?: string;
}

// SUPPORT AGENT (2026-11-26): one purchase-intent notification per buyer
// chat per 10 minutes. A buyer mashing "buy" must not flood the owner
// with a message per tap; a repeat after 10 minutes is a new attempt.
const PURCHASE_NOTIFY_WINDOW_MS = 10 * 60 * 1000;
const purchaseNotifiedChats = new Map<number, number>();

/**
 * Best-effort admin notification for a purchase intent. Resolves the
 * admin's linked Telegram chat exactly like /api/admin/notify-signup
 * does (admin email → auth user id → telegram_links). When the admin
 * has no linked chat yet, nothing is sent — the buyer still gets the
 * handoff reply and the WhatsApp link, so this never fails the reply.
 */
async function notifyAdminOfPurchaseIntent(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  buyerMessage: string,
  buyerChatId: number,
  botToken: string
): Promise<void> {
  const now = Date.now();
  const lastNotified = purchaseNotifiedChats.get(buyerChatId);
  if (lastNotified && now - lastNotified < PURCHASE_NOTIFY_WINDOW_MS) return;
  try {
    const adminUser = await findAuthUserByEmail(admin.auth.admin, ADMIN_EMAIL);
    if (!adminUser) return;
    const { data: tgLink } = await admin
      .from('telegram_links')
      .select('chat_id')
      .eq('user_id', adminUser.id)
      .maybeSingle();
    if (!tgLink) {
      console.warn(
        'purchase-intent: admin has no linked Telegram chat yet — buyer got the WhatsApp link only'
      );
      return;
    }
    await sendTelegramMessage(
      tgLink.chat_id,
      buildPurchaseIntentTelegramMessage(buyerMessage, buyerChatId, now),
      botToken
    );
    purchaseNotifiedChats.set(buyerChatId, now);
    if (purchaseNotifiedChats.size > 1_000) {
      for (const [chatId, at] of purchaseNotifiedChats) {
        if (now - at >= PURCHASE_NOTIFY_WINDOW_MS) purchaseNotifiedChats.delete(chatId);
      }
    }
  } catch (error) {
    console.error(
      'purchase-intent: failed to notify admin:',
      (error as Error).message
    );
  }
}

/**
 * Answer a support question from the LinkMind knowledge base with
 * Gemini. Never throws: on a missing key or a Gemini failure the
 * caller still gets the static fallback reply (with the WhatsApp
 * link), and the webhook returns { ok: true }.
 */
async function answerSupportQuestion(question: string): Promise<string> {
  const language = detectSupportLanguage(question);
  const aiKey = process.env.GEMINI_API_KEY?.trim();
  if (!aiKey) return buildSupportFallbackReply(language);
  try {
    const ai = new GoogleGenAI({ apiKey: aiKey });
    const response = await generateContentWithFallback(ai, {
      contents: buildSupportPrompt(question, language),
    });
    const answer = (response.text || '').trim();
    if (!answer) return buildSupportFallbackReply(language);
    // Telegram caps a message at 4096 characters; stay safely under it.
    return answer.slice(0, 4000);
  } catch (error) {
    console.error('Telegram support answer failed:', (error as Error).message);
    return buildSupportFallbackReply(language);
  }
}

function isValidHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      (url.port &&
        ((url.protocol === 'http:' && url.port !== '80') ||
          (url.protocol === 'https:' && url.port !== '443')))
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const receivedSecret = request.headers.get('x-telegram-bot-api-secret-token') ?? '';

  if (!botToken || !webhookSecret) {
    return NextResponse.json({ error: 'Telegram webhook is not configured' }, { status: 503 });
  }
  const receivedBytes = Buffer.from(receivedSecret);
  const expectedBytes = Buffer.from(webhookSecret);
  if (
    receivedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(receivedBytes, expectedBytes)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let update: { message?: TelegramMessage };
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();
  if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || !text) {
    return NextResponse.json({ ok: true });
  }

  // SECURITY (2026-11-24 audit): 20 updates per minute per chat, so one
  // chat cannot flood the webhook and burn the Gemini quota. Telegram
  // retries a 429 with backoff; the duplicate-link guard below prevents
  // a retry from saving (or charging) twice.
  pruneRateLimitBuckets();
  const telegramLimit = checkRateLimit(`telegram:${chatId}`, 20, 60_000);
  if (!telegramLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((telegramLimit.resetAt - Date.now()) / 1000)) },
      }
    );
  }

  try {
    const admin = createSupabaseAdminClient();

    if (/^\/start(?:@\w+)?(?:\s|$)/.test(text)) {
      const token = text.split(/\s+/)[1];
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
        await sendTelegramMessage(
          chatId,
          'أهلاً بك في LinkMind! افتح الموقع واضغط على زر ربط Telegram لإنشاء رابط آمن.\nويمكنك أيضاً سؤالي هنا عن LinkMind: الباقات والأسعار وكيفية الاستخدام.',
          botToken
        );
        return NextResponse.json({ ok: true });
      }

      const tokenHash = createHash('sha256').update(token).digest('hex');
      const { data: tokenData, error: tokenError } = await admin
        .from('telegram_link_tokens')
        .delete()
        .eq('token_hash', tokenHash)
        .gt('expires_at', new Date().toISOString())
        .select('user_id')
        .maybeSingle();

      if (tokenError) {
        console.error('Failed to consume Telegram link token:', tokenError.message);
        return NextResponse.json({ error: 'Could not verify Telegram link' }, { status: 500 });
      }
      if (!tokenData) {
        await sendTelegramMessage(
          chatId,
          'انتهت صلاحية رابط الربط أو استُخدم من قبل. أنشئ رابطاً جديداً من LinkMind.',
          botToken
        );
        return NextResponse.json({ ok: true });
      }

      // N9: never silently steal a chat that is already linked to another
      // user. The previous owner must unlink first.
      const { data: existingLink } = await admin
        .from('telegram_links')
        .select('user_id')
        .eq('chat_id', chatId)
        .maybeSingle();
      if (existingLink && existingLink.user_id !== tokenData.user_id) {
        await sendTelegramMessage(
          chatId,
          'هذا الحساب في Telegram مربوط بمستخدم آخر في LinkMind. ألغِ الربط أولاً ثم حاول مجدداً.',
          botToken
        );
        return NextResponse.json({ ok: true });
      }

      const { error: linkError } = await admin
        .from('telegram_links')
        .upsert({ chat_id: chatId, user_id: tokenData.user_id }, { onConflict: 'chat_id' });

      if (linkError) {
        console.error('Failed to link Telegram account:', linkError.message);
        return NextResponse.json({ error: 'Could not link Telegram account' }, { status: 500 });
      }

      await sendTelegramMessage(
        chatId,
        '✅ تم ربط حسابك بنجاح! أرسل رابطاً عاماً لحفظه في مكتبتك.',
        botToken
      );
      return NextResponse.json({ ok: true });
    }

    // SUPPORT AGENT (2026-11-26): decide link vs. question BEFORE the
    // link lookup. A message with no link is a support question, answered
    // for ANY sender — linked or not — because a prospective customer is
    // not a user yet. Only saving a link still requires a linked account.
    const urlMatch = text.match(/https?:\/\/[^\s<>]+/i);
    const candidateUrl = urlMatch?.[0].replace(/[),.!?]+$/, '');
    const url = candidateUrl ? isValidHttpUrl(candidateUrl) : null;

    if (!url) {
      // Purchase decision: the bot never handles payment. Tell the buyer
      // the owner will contact them personally, notify the owner
      // (best-effort), and give the WhatsApp link as a direct channel.
      if (detectPurchaseIntent(text)) {
        await notifyAdminOfPurchaseIntent(admin, text, chatId, botToken);
        await sendTelegramMessage(
          chatId,
          buildPurchaseHandoffReply(detectSupportLanguage(text)),
          botToken
        );
        return NextResponse.json({ ok: true });
      }

      // Any other question: answer from the LinkMind knowledge base.
      await sendTelegramMessage(chatId, await answerSupportQuestion(text), botToken);
      return NextResponse.json({ ok: true });
    }

    // SHORT LINKS (2026-11-26): resolve lnkd.in / vm|vt.tiktok.com to the
    // canonical URL BEFORE the duplicate check and the save, so the same
    // link pasted short once and full once is recognised as one link, and
    // the saved row carries a URL the library classifies correctly.
    // On any failure the pasted URL is kept as-is.
    let canonicalUrl = url;
    const urlHost = url.hostname.toLowerCase();
    if (urlHost === 'lnkd.in') {
      const resolved = await resolveShortUrl(
        url.toString(),
        ['lnkd.in'],
        (h) => h === 'linkedin.com' || h.endsWith('.linkedin.com')
      );
      canonicalUrl = isValidHttpUrl(resolved) ?? url;
    } else if (urlHost === 'vm.tiktok.com' || urlHost === 'vt.tiktok.com') {
      const resolved = await resolveShortUrl(
        url.toString(),
        ['vm.tiktok.com', 'vt.tiktok.com'],
        (h) => h === 'tiktok.com' || h.endsWith('.tiktok.com')
      );
      canonicalUrl = isValidHttpUrl(resolved) ?? url;
    }

    const { data: linkData, error: lookupError } = await admin
      .from('telegram_links')
      .select('user_id')
      .eq('chat_id', chatId)
      .maybeSingle();

    if (lookupError) {
      console.error('Failed to look up Telegram link:', lookupError.message);
      return NextResponse.json({ error: 'Could not look up Telegram account' }, { status: 500 });
    }
    if (!linkData) {
      await sendTelegramMessage(
        chatId,
        '⚠️ اربط حسابك من داخل موقع LinkMind قبل إرسال الروابط.',
        botToken
      );
      return NextResponse.json({ ok: true });
    }

    // I5: do not save the same link twice for the same user. Checked here,
    // BEFORE any Gemini call, so a duplicate never spends AI quota.
    const { data: existingBookmark } = await admin
      .from('bookmarks')
      .select('id')
      .eq('user_id', linkData.user_id)
      .eq('url', canonicalUrl.toString())
      .maybeSingle();
    if (existingBookmark) {
      await sendTelegramMessage(
        chatId,
        `📌 هذا الرابط محفوظ لديك مسبقاً:\n\n${canonicalUrl.toString()}`,
        botToken
      );
      return NextResponse.json({ ok: true });
    }

    // SECURITY (2026-11-24 audit, high): the webhook used to call Gemini
    // and save bookmarks with no credit check at all. Check the balance
    // BEFORE spending any AI quota; deduct once, after the bookmark is
    // actually saved (see below). PRO users are exempt, like /api/analyze.
    let { data: tgProfile, error: tgProfileError } = await admin
      .from('user_profiles')
      .select('credits, plan_type')
      .eq('user_id', linkData.user_id)
      .maybeSingle();
    if (tgProfileError) {
      console.error('Failed to load Telegram user profile:', tgProfileError.message);
      await sendTelegramMessage(chatId, 'تعذر التحقق من رصيدك حالياً. حاول مرة أخرى لاحقاً.', botToken);
      return NextResponse.json({ ok: true });
    }
    if (!tgProfile) {
      const { data: newProfile, error: insertError } = await admin
        .from('user_profiles')
        .insert({ user_id: linkData.user_id, credits: 5, plan_type: 'free' })
        .select('credits, plan_type')
        .single();
      if (insertError || !newProfile) {
        console.error('Failed to create Telegram user profile:', insertError?.message);
        await sendTelegramMessage(chatId, 'تعذر التحقق من رصيدك حالياً. حاول مرة أخرى لاحقاً.', botToken);
        return NextResponse.json({ ok: true });
      }
      tgProfile = newProfile;
    }
    const tgIsPro = tgProfile?.plan_type === 'pro';
    const tgCredits = tgProfile?.credits ?? 0;
    if (!tgIsPro && tgCredits <= 0) {
      await sendTelegramMessage(
        chatId,
        '⚠️ انتهى رصيدك المجاني. افتح LinkMind وترقَّ إلى PRO لمتابعة حفظ الروابط.',
        botToken
      );
      return NextResponse.json({ ok: true });
    }

    await sendTelegramMessage(chatId, '⏳ جاري تحليل الرابط وحفظه...', botToken);

    // CONTENT GATE (2026-11-26): fetch the best real source per kind —
    // the same sources /api/analyze uses — and refuse honestly when the
    // fetch stage brings back no real content. Previously the bot called
    // Gemini with the bare URL on any fetch failure and saved the invented
    // summary (and charged a credit for it).
    const canonicalHost = canonicalUrl.hostname.toLowerCase();
    const isYouTubeBotLink =
      canonicalHost === 'youtube.com' ||
      canonicalHost.endsWith('.youtube.com') ||
      canonicalHost === 'youtu.be';
    const isTikTokBotLink =
      canonicalHost === 'tiktok.com' || canonicalHost.endsWith('.tiktok.com');
    const isLinkedInBotLink =
      canonicalHost === 'linkedin.com' ||
      canonicalHost.endsWith('.linkedin.com') ||
      canonicalHost === 'lnkd.in';

    let rawTitle = '';
    let rawDescription = '';
    let image = '';
    let bodyText = '';
    let tgHasRealTitle = false;
    let tgHasRealDescription = false;
    let tgFetchFailed = false;

    if (isYouTubeBotLink) {
      const videoId = extractYouTubeId(canonicalUrl.toString());
      if (videoId) {
        const apiKey = process.env.YOUTUBE_API_KEY?.trim() || undefined;
        const [apiMeta, oembed] = await Promise.all([
          fetchYouTubeApiMetadata(videoId, apiKey),
          fetchYouTubeOEmbed(canonicalUrl.toString()),
        ]);
        if (apiMeta) {
          tgHasRealTitle = true;
          if (apiMeta.description) tgHasRealDescription = true;
          rawTitle = apiMeta.title;
          rawDescription = [
            apiMeta.channelTitle ? `Channel: ${apiMeta.channelTitle}` : '',
            apiMeta.description,
            apiMeta.tags.length > 0 ? `Tags: ${apiMeta.tags.join(', ')}` : '',
            apiMeta.duration ? `Duration: ${apiMeta.duration}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        } else if (oembed) {
          tgHasRealTitle = true;
          rawTitle = oembed.title;
          rawDescription = `Channel: ${oembed.authorName || 'YouTube'}`;
        }
        if (oembed?.thumbnailUrl) image = oembed.thumbnailUrl;
      }
    } else if (isTikTokBotLink) {
      const cleanTikTokUrl = canonicalUrl.toString().split('?')[0];
      const [pageMeta, ttOembed] = await Promise.all([
        fetchTikTokPageMetadata(cleanTikTokUrl),
        fetchTikTokOEmbed(cleanTikTokUrl),
      ]);
      if (pageMeta) {
        tgHasRealTitle = true;
        tgHasRealDescription = true;
        rawTitle = pageMeta.title;
        rawDescription = [
          pageMeta.description,
          pageMeta.author
            ? `Author: ${pageMeta.authorNickname || pageMeta.author} (@${pageMeta.author})`
            : '',
          pageMeta.musicTitle ? `Music: ${pageMeta.musicTitle}` : '',
          pageMeta.tags.length > 0
            ? `Hashtags: ${pageMeta.tags.map((t) => `#${t}`).join(' ')}`
            : '',
          `Views: ${pageMeta.playCount}, likes: ${pageMeta.likeCount}, comments: ${pageMeta.commentCount}`,
        ]
          .filter(Boolean)
          .join('\n');
        bodyText = rawDescription;
      } else if (ttOembed) {
        tgHasRealTitle = true;
        rawTitle = ttOembed.title;
        rawDescription = `TikTok Video by ${ttOembed.authorName || ''} (@${ttOembed.authorUniqueId || ''}): ${ttOembed.title}`;
        bodyText = rawDescription;
      }
      if (ttOembed?.thumbnailUrl) image = ttOembed.thumbnailUrl;
    } else {
      // Generic page (article, blog, LinkedIn, ...): same extraction as
      // /api/analyze — og title/description/image plus body text.
      try {
        const pageResponse = await fetchPublicUrl(canonicalUrl);
        const contentType = pageResponse.headers['content-type'] || '';
        if (
          pageResponse.status >= 200 &&
          pageResponse.status < 300 &&
          contentType.includes('text/html')
        ) {
          const html = pageResponse.body.toString('utf8');
          const $ = cheerio.load(html);
          const pageTitle =
            $('meta[property="og:title"]').attr('content') || $('title').text() || '';
          if (pageTitle) tgHasRealTitle = true;
          rawTitle = pageTitle || canonicalUrl.toString();
          rawDescription =
            $('meta[property="og:description"]').attr('content') ||
            $('meta[name="description"]').attr('content') ||
            '';
          if (rawDescription) tgHasRealDescription = true;
          image = $('meta[property="og:image"]').attr('content') || '';
          $('script, style, nav, footer, header').remove();
          bodyText = $('article, main, body')
            .find('h1, h2, h3, p, li')
            .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
            .get()
            .filter(Boolean)
            .join('\n');
        } else {
          tgFetchFailed = true;
        }
      } catch {
        tgFetchFailed = true;
      }
    }

    // No real content → no Gemini call, no save, no credit deduction.
    // The user gets the same honest message the website shows.
    if (
      !hasRealLinkContent({
        kind: isYouTubeBotLink
          ? 'youtube'
          : isTikTokBotLink
            ? 'tiktok'
            : isLinkedInBotLink
              ? 'linkedin'
              : 'general',
        fetchFailed: tgFetchFailed,
        hasRealTitle: tgHasRealTitle,
        hasRealDescription: tgHasRealDescription,
        hasTranscript: false,
        bodyTextLength: bodyText.trim().length,
        title: rawTitle,
      })
    ) {
      await sendTelegramMessage(
        chatId,
        'تعذّر جلب محتوى هذا الرابط، فلم يتم إنشاء ملخص. جرّب رابطاً آخر، ولم يُخصم أي رصيد.',
        botToken
      );
      return NextResponse.json({ ok: true });
    }

    const aiKey = process.env.GEMINI_API_KEY?.trim();
    let finalTitle = (rawTitle || canonicalUrl.toString()).trim().slice(0, 200);
    let finalSummary = (rawDescription || 'Saved via Telegram Bot').trim().slice(0, 500);
    let finalCategory = 'General';
    let embedding: number[] | null = null;

    if (aiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey: aiKey });
        const aiResponse = await generateContentWithFallback(ai, {
          contents: `Summarize this link in Arabic in 2 concise sentences and classify it into ONLY one of: "Programming", "Learning", "Business", "General".\nTitle: ${finalTitle}\nDesc: ${rawDescription}\nContent: ${bodyText.slice(0, 14000)}\nURL: ${canonicalUrl.toString()}`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                summary: { type: Type.STRING },
                category: { type: Type.STRING },
              },
              required: ['title', 'summary', 'category'],
            },
          },
        });
        const parsed = JSON.parse(aiResponse.text || '{}');
        finalTitle = String(parsed.title || finalTitle).slice(0, 200);
        finalSummary = String(parsed.summary || finalSummary).slice(0, 500);
        if (['Programming', 'Learning', 'Business', 'General'].includes(parsed.category)) {
          finalCategory = parsed.category;
        }

        const embeddingResponse = await ai.models.embedContent({
          model: 'text-embedding-004',
          contents: `${finalTitle}. ${finalSummary}`,
        });
        embedding = embeddingResponse.embeddings?.[0]?.values || null;
      } catch (error) {
        console.error('Telegram link analysis failed:', error);
      }
    }

    const { error: insertError } = await admin.from('bookmarks').insert({
      user_id: linkData.user_id,
      url: canonicalUrl.toString(),
      title: finalTitle,
      summary: finalSummary,
      category: finalCategory,
      image_url: image,
      embedding,
    });

    if (insertError) {
      console.error('Failed to save Telegram bookmark:', insertError.message);
      await sendTelegramMessage(chatId, 'تعذر حفظ الرابط حالياً. حاول مرة أخرى لاحقاً.', botToken);
      return NextResponse.json({ error: 'Could not save bookmark' }, { status: 500 });
    }

    // Deduct one credit now that the bookmark is saved (no deduct on
    // duplicates — handled above — or on a failed save).
    if (!tgIsPro) {
      const newCredits = await deductCredit(admin, linkData.user_id, tgCredits);
      if (newCredits === null) {
        console.warn('Telegram bookmark saved but credit deduction failed for user:', linkData.user_id);
      }
    }

    await sendTelegramMessage(
      chatId,
      `✅ تم الحفظ في LinkMind!\n\n📌 ${finalTitle}\n🗂 التصنيف: ${finalCategory}\n📝 ${finalSummary}`,
      botToken
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook processing failed:', error);
    return NextResponse.json({ error: 'Telegram update could not be processed' }, { status: 500 });
  }
}
