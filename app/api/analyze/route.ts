import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { YoutubeTranscript } from 'youtube-transcript';
import { GoogleGenAI, Type } from '@google/genai';

// رفع المهلة القصوى للسيرفر في Vercel لتجنب خطأ 504 Timeout
export const maxDuration = 60;

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

// فك اختصار روابط تيك توك القصيرة بمهلة 3 ثوانٍ كحد أقصى
async function resolveShortUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      },
    });
    return res.url || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

// البدء بالنموذج الأسرع (gemini-3.8-flash-lite) لتجنب 503 و 504
async function generateFast(contentsPayload: any, config: any) {
  const models = ['gemini-3.8-flash-lite', 'gemini-3.8-flash'];
  let lastError: any;

  for (const modelName of models) {
    try {
      return await ai.models.generateContent({
        model: modelName,
        contents: contentsPayload,
        config,
      });
    } catch (err: any) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 600));
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

    let rawTitle = bookTitle || '';
    let rawDescription = '';
    let bodyContent = bookText ? String(bookText).slice(0, 14000) : '';
    let image = '';
    let finalUrl = url.trim();
    const isBookOrDoc = Boolean(bookText || bookBase64);

    if (isBookOrDoc) {
      finalUrl = `file://${bookType || 'pdf'}/${encodeURIComponent(bookTitle || 'Book')}`;
    } else {
      const lowerUrl = finalUrl.toLowerCase();
      const videoId = extractYouTubeId(finalUrl);

      if (videoId) {
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
            .slice(0, 14000);
        } catch {}
      } else if (lowerUrl.includes('tiktok.com')) {
        try {
          let targetTikTokUrl = finalUrl;
          if (lowerUrl.includes('vm.tiktok.com') || lowerUrl.includes('vt.tiktok.com')) {
            targetTikTokUrl = await resolveShortUrl(finalUrl);
          }
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
            rawTitle = 'TikTok Video';
            rawDescription = `TikTok Video URL: ${cleanTikTokUrl}`;
            bodyContent = rawDescription;
          }
        } catch {
          rawTitle = 'TikTok Video';
          rawDescription = `TikTok Video URL: ${finalUrl}`;
          bodyContent = rawDescription;
        }
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
          const res = await fetch(finalUrl, {
            signal: controller.signal,
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
              .slice(0, 14000);
          } else {
            rawTitle = finalUrl;
            rawDescription = `Saved link: ${finalUrl}`;
          }
        } catch {
          rawTitle = finalUrl;
          rawDescription = `Saved web resource: ${finalUrl}`;
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const langInstruction =
      lang === 'ar'
        ? 'Write the title, summary, and checklist steps in clear, eloquent Arabic.'
        : lang === 'tr'
        ? 'Write the title, summary, and checklist steps in clear, natural Turkish.'
        : 'Write the title, summary, and checklist steps in clear, natural English.';

    let finalTitle = rawTitle.trim() || finalUrl;
    let finalSummary = rawDescription.trim() || 'Saved resource';
    let finalCategory = isBookOrDoc ? 'Learning' : 'General';
    let finalChecklist: string[] = [];
    let embedding: number[] = [];

    if (process.env.GEMINI_API_KEY) {
      const promptText = isBookOrDoc
        ? `Summarize this book/document quickly and extract:
1. A clean book/document title.
2. A concise 3-sentence summary of the core thesis and main ideas.
3. Category: ONLY one of "Programming", "Learning", "Business", "General".
4. Actionable Checklist: 5 to 8 key principles and practical steps from the book.

${langInstruction}

Title: ${rawTitle}
${bodyContent ? `Content: ${bodyContent}` : ''}`
        : `Summarize this video/post/article and extract:
1. A clean, concise title.
2. A 2-sentence executive summary.
3. Category: ONLY one of "Programming", "Learning", "Business", "General".
4. Actionable Checklist: 4 to 7 practical step-by-step instructions or key takeaways.

${langInstruction}

Title: ${rawTitle}
Description: ${rawDescription}
Content/Transcript: ${bodyContent || rawDescription}
URL: ${finalUrl}`;

      const contentsPayload: any = bookBase64
        ? [
            {
              inlineData: {
                data: bookBase64,
                mimeType: bookMimeType || 'application/pdf',
              },
            },
            promptText,
          ]
        : promptText;

      const aiRes = await generateFast(contentsPayload, {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            summary: { type: Type.STRING },
            category: { type: Type.STRING },
            checklist: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['title', 'summary', 'category', 'checklist'],
        },
      });

      const parsed = JSON.parse(aiRes.text || '{}');
      finalTitle = parsed.title || finalTitle;
      finalSummary = parsed.summary || finalSummary;
      if (['Programming', 'Learning', 'Business', 'General'].includes(parsed.category)) {
        finalCategory = parsed.category;
      }
      if (Array.isArray(parsed.checklist)) {
        finalChecklist = parsed.checklist;
      }

      try {
        const embRes = await ai.models.embedContent({
          model: 'text-embedding-004',
          contents: `${finalTitle}. ${finalSummary}. ${finalChecklist.join(' ')}`,
        });
        embedding = embRes.embeddings?.[0]?.values || [];
      } catch {}
    }

    let updatedCredits = currentCredits;
    if (!isPro) {
      updatedCredits = Math.max(0, currentCredits - 1);
      await supabaseAdmin
        .from('user_profiles')
        .update({ credits: updatedCredits, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
    }

    return NextResponse.json({
      url: finalUrl,
      title: finalTitle,
      summary: finalSummary,
      category: finalCategory,
      image_url: image,
      checklist: finalChecklist,
      embedding,
      remainingCredits: updatedCredits,
      planType: profile?.plan_type || 'free',
    });
  } catch (err: any) {
    console.error('Analyze Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to analyze content' },
      { status: 500 }
    );
  }
}