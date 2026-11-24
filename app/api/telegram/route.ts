import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import { GoogleGenAI, Type } from '@google/genai';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { fetchPublicUrl } from '@/lib/safe-fetch';
import { generateContentWithFallback } from '@/lib/gemini';
import { deductCredit } from '@/lib/credits';
import { checkRateLimit, pruneRateLimitBuckets } from '@/lib/rate-limit';

export const runtime = 'nodejs';

// I3: the default Hobby limit is 10s; Gemini + embedding + page fetch need
// the same 60s budget the analyze route already uses.
export const maxDuration = 60;

interface TelegramMessage {
  chat?: { id?: number };
  text?: string;
}

async function sendTelegramMessage(chatId: number, text: string, botToken: string) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed with status ${response.status}`);
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
          'أهلاً بك في LinkMind! افتح الموقع واضغط على زر ربط Telegram لإنشاء رابط آمن.',
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

    const urlMatch = text.match(/https?:\/\/[^\s<>]+/i);
    const candidateUrl = urlMatch?.[0].replace(/[),.!?]+$/, '');
    const url = candidateUrl ? isValidHttpUrl(candidateUrl) : null;
    if (!url) {
      await sendTelegramMessage(chatId, '📎 أرسل رابطاً عاماً صحيحاً يبدأ بـ http أو https.', botToken);
      return NextResponse.json({ ok: true });
    }

    // I5: do not save the same link twice for the same user. Checked here,
    // BEFORE any Gemini call, so a duplicate never spends AI quota.
    const { data: existingBookmark } = await admin
      .from('bookmarks')
      .select('id')
      .eq('user_id', linkData.user_id)
      .eq('url', url.toString())
      .maybeSingle();
    if (existingBookmark) {
      await sendTelegramMessage(
        chatId,
        `📌 هذا الرابط محفوظ لديك مسبقاً:\n\n${url.toString()}`,
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

    let rawTitle = '';
    let rawDescription = '';
    let image = '';

    if (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com') || url.hostname === 'youtu.be') {
      const ytResponse = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url.toString())}&format=json`,
        { signal: AbortSignal.timeout(8_000) }
      );
      if (ytResponse.ok) {
        const ytData = await ytResponse.json();
        rawTitle = ytData.title || 'YouTube Video';
        rawDescription = `قناة: ${ytData.author_name || 'YouTube'}`;
        image = ytData.thumbnail_url || '';
      }
    }

    if (!rawTitle) {
      const pageResponse = await fetchPublicUrl(url);
      if (pageResponse.status >= 200 && pageResponse.status < 300) {
        const $ = cheerio.load(pageResponse.body.toString('utf8'));
        rawTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || url.toString();
        rawDescription = $('meta[property="og:description"]').attr('content') || '';
        image = $('meta[property="og:image"]').attr('content') || '';
      }
    }

    const aiKey = process.env.GEMINI_API_KEY?.trim();
    let finalTitle = (rawTitle || url.toString()).trim().slice(0, 200);
    let finalSummary = (rawDescription || 'Saved via Telegram Bot').trim().slice(0, 500);
    let finalCategory = 'General';
    let embedding: number[] | null = null;

    if (aiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey: aiKey });
        const aiResponse = await generateContentWithFallback(ai, {
          contents: `Summarize this link in Arabic in 2 concise sentences and classify it into ONLY one of: "Programming", "Learning", "Business", "General".\nTitle: ${finalTitle}\nDesc: ${rawDescription}\nURL: ${url.toString()}`,
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
      url: url.toString(),
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
