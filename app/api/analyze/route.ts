import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { YoutubeTranscript } from 'youtube-transcript';
import { GoogleGenAI, Type } from '@google/genai';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

function extractYouTubeId(url: string): string | null {
  const regExp =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regExp);
  return match ? match[1] : null;
}

// فك اختصار روابط المشاركة القصيرة (مثل vm.tiktok.com أو vt.tiktok.com)
async function resolveShortUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    return res.url || url;
  } catch {
    return url;
  }
}

// التبديل التلقائي وإعادة المحاولة لتجاوز ضغط السيرفر (503 UNAVAILABLE)
async function generateWithFallback(contentsPayload: any, config: any) {
  const models = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-3.8-flash-lite'];
  let lastError: any;

  for (const modelName of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await ai.models.generateContent({
          model: modelName,
          contents: contentsPayload,
          config,
        });
      } catch (err: any) {
        lastError = err;
        const msg = String(err?.message || '');
        if (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('429')) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        throw err;
      }
    }
  }
  throw lastError;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      url = '',
      lang = 'ar',
      userId,
      bookTitle,
      bookText,
      bookBase64,
      bookMimeType,
      bookType,
    } = body;

    if ((!url && !bookText && !bookBase64) || !userId) {
      return NextResponse.json(
        { error: 'URL or book content and userId are required' },
        { status: 400 }
      );
    }

    // 1. التحقق من رصيد المستخدم في Supabase
    let { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('credits, plan_type')
      .eq('user_id', userId)
      .single();

    if (!profile) {
      const { data: newProfile } = await supabaseAdmin
        .from('user_profiles')
        .insert({ user_id: userId, credits: 5, plan_type: 'free' })
        .select('credits, plan_type')
        .single();
      profile = newProfile;
    }

    const isPro = profile?.plan_type === 'pro';
    const currentCredits = profile?.credits ?? 0;

    if (!isPro && currentCredits <= 0) {
      return NextResponse.json(
        { error: 'OUT_OF_CREDITS', remainingCredits: 0 },
        { status: 402 }
      );
    }

    // 2. تجهيز المحتوى حسب نوع المصدر (كتاب / يوتيوب / تيك توك / موقع ويب)
    let rawTitle = bookTitle || '';
    let rawDescription = '';
    let bodyContent = bookText ? String(bookText).slice(0, 30000) : '';
    let image = '';
    let finalUrl = url.trim();
    const isBookOrDoc = Boolean(bookText || bookBase64);

    if (isBookOrDoc) {
      finalUrl = `file://${bookType || 'pdf'}/${encodeURIComponent(bookTitle || 'Book')}`;
    } else {
      const lowerUrl = finalUrl.toLowerCase();
      const videoId = extractYouTubeId(finalUrl);

      if (videoId) {
        // معالجة روابط YouTube
        try {
          const ytRes = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(finalUrl)}&format=json`
          );
          if (ytRes.ok) {
            const ytData = await ytRes.json();
            rawTitle = ytData.title || 'YouTube Tutorial';
            rawDescription = `Channel: ${ytData.author_name || 'YouTube'}`;
            image = ytData.thumbnail_url || '';
          }
        } catch {}

        try {
          const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
          bodyContent = transcriptItems
            .map((item) => item.text)
            .join(' ')
            .slice(0, 18000);
        } catch {}
      } else if (lowerUrl.includes('tiktok.com')) {
        // معالجة روابط TikTok (الكاملة والقصيرة vm.tiktok / vt.tiktok)
        try {
          let targetTikTokUrl = finalUrl;
          if (lowerUrl.includes('vm.tiktok.com') || lowerUrl.includes('vt.tiktok.com')) {
            targetTikTokUrl = await resolveShortUrl(finalUrl);
          }
          // تنظيف معاملات التتبع الزائدة بعد علامة الاستفهام
          const cleanTikTokUrl = targetTikTokUrl.split('?')[0];

          const ttRes = await fetch(
            `https://www.tiktok.com/oembed?url=${encodeURIComponent(cleanTikTokUrl)}`
          );

          if (ttRes.ok) {
            const ttData = await ttRes.json();
            rawTitle = ttData.title || `TikTok by ${ttData.author_name || 'Creator'}`;
            rawDescription = `TikTok Video by ${ttData.author_name || ''} (@${ttData.author_unique_id || ''}): ${ttData.title || ''}`;
            image = ttData.thumbnail_url || '';
            bodyContent = rawDescription;
          } else {
            // محاولة احتياطية بالرابط الأصلي قبل التنظيف
            const fallbackRes = await fetch(
              `https://www.tiktok.com/oembed?url=${encodeURIComponent(finalUrl)}`
            );
            if (fallbackRes.ok) {
              const ttData = await fallbackRes.json();
              rawTitle = ttData.title || `TikTok by ${ttData.author_name || 'Creator'}`;
              rawDescription = `TikTok Video by ${ttData.author_name || ''}: ${ttData.title || ''}`;
              image = ttData.thumbnail_url || '';
              bodyContent = rawDescription;
            } else {
              rawTitle = 'TikTok Video';
              rawDescription = `Saved TikTok video link: ${finalUrl}`;
              bodyContent = rawDescription;
            }
          }
        } catch {
          rawTitle = 'TikTok Video';
          rawDescription = `Saved TikTok video link: ${finalUrl}`;
          bodyContent = rawDescription;
        }
      } else {
        // معالجة بقية المواقع والمنصات
        try {
          const res = await fetch(finalUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            },
          });
          if (res.ok) {
            const html = await res.text();
            const $ = cheerio.load(html);
            rawTitle =
              $('meta[property="og:title"]').attr('content') ||
              $('title').text() ||
              finalUrl;
            rawDescription =
              $('meta[property="og:description"]').attr('content') ||
              $('meta[name="description"]').attr('content') ||
              '';
            image = $('meta[property="og:image"]').attr('content') || '';

            $('script, style, nav, footer, header').remove();
            bodyContent = $('article, main, body')
              .find('h1, h2, h3, p, li')
              .map((_, el) => $(el).text().trim())
              .get()
              .join(' ')
              .replace(/\s+/g, ' ')
              .slice(0, 18000);
          } else {
            rawTitle = finalUrl;
            rawDescription = `Saved link from ${new URL(finalUrl).hostname}`;
          }
        } catch {
          rawTitle = finalUrl;
          rawDescription = `Saved web resource: ${finalUrl}`;
        }
      }