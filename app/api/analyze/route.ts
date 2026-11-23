import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import * as cheerio from 'cheerio';
import { YoutubeTranscript } from 'youtube-transcript';
import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

function extractYouTubeId(url: string): string | null {
  const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regExp);
  return match ? match[1] : null;
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

    const isBookOrDoc = Boolean(bookText || bookBase64);
    if (isBookOrDoc && !process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: 'Document summarization is not configured' }, { status: 503 });
    }

    const supabaseAdmin = createSupabaseAdminClient();

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

    // 2. تجهيز المحتوى
    let rawTitle = bookTitle || '';
    let rawDescription = '';
    let bodyContent = bookText ? String(bookText).slice(0, 100000) : '';
    let image = '';
    let finalUrl = url;

    if (isBookOrDoc) {
      finalUrl = `file://${bookType || 'pdf'}/${encodeURIComponent(bookTitle || 'Book')}`;
    } else {
      const videoId = extractYouTubeId(url);

      if (videoId) {
        try {
          const ytRes = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
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
      } else {
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
          });
          if (res.ok) {
            const html = await res.text();
            const $ = cheerio.load(html);
            rawTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || url;
            rawDescription = $('meta[property="og:description"]').attr('content') || '';
            image = $('meta[property="og:image"]').attr('content') || '';

            $('script, style, nav, footer, header').remove();
            bodyContent = $('article, main, body')
              .find('h1, h2, h3, p, li')
              .map((_, el) => $(el).text().trim())
              .get()
              .join(' ')
              .replace(/\s+/g, ' ')
              .slice(0, 18000);
          }
        } catch {
          rawTitle = url;
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

    // 3. التحليل عبر Gemini (يدعم ملفات PDF مباشرة حتى المصورة منها + النصوص + الروابط)
    if (process.env.GEMINI_API_KEY) {
      const promptText = isBookOrDoc
        ? `Analyze this book/document thoroughly and extract:
1. A clean, accurate book/document title.
2. A rich 3-sentence executive summary capturing the core thesis and main ideas of the book.
3. Category: choose ONLY one of "Programming", "Learning", "Business", "General".
4. Actionable Key Ideas & Checklist: extract 6 to 10 core principles, key takeaways, and practical actionable steps from the book so the reader can apply its wisdom immediately.

${langInstruction}

Title: ${rawTitle}
${bodyContent ? `Content: ${bodyContent}` : ''}`
        : `Analyze this tutorial/article and extract:
1. A clean, concise title.
2. A 2-sentence executive summary.
3. Category: choose ONLY one of "Programming", "Learning", "Business", "General".
4. Actionable Checklist: extract 4 to 8 clear, practical step-by-step instructions so a student or developer can apply what is taught without watching/reading the whole source.

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

      const aiRes = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: contentsPayload,
        config: {
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

    // 4. خصم 1 نقطة رصيد إذا لم يكن مشتركاً في باقة Pro
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