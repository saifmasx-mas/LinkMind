import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import { GoogleGenAI, Type } from '@google/genai';
import { fetchPublicUrl } from '@/lib/safe-fetch';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export async function POST(req: Request) {
  try {
    const { url, lang } = await req.json();

    if (!url || !url.startsWith('http')) {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }

    let rawTitle = '';
    let rawDescription = '';
    let bodyText = '';
    let image = '';

    const parsedUrl = new URL(url);
    const isYouTube =
      parsedUrl.hostname === 'youtu.be' ||
      parsedUrl.hostname === 'youtube.com' ||
      parsedUrl.hostname.endsWith('.youtube.com');

    if (isYouTube) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const ytRes = await fetch(oembedUrl);
        if (ytRes.ok) {
          const ytData = await ytRes.json();
          rawTitle = ytData.title || 'YouTube Video';
          rawDescription = `قناة: ${ytData.author_name || 'YouTube'}`;
          image = ytData.thumbnail_url || '';
        }
      } catch {
        console.warn('YouTube oEmbed fallback');
      }
    }

    if (!rawTitle) {
      try {
        const response = await fetchPublicUrl(url);

        if (response.status >= 200 && response.status < 300) {
          const html = response.body.toString('utf8');
          const $ = cheerio.load(html);

          rawTitle =
            $('meta[property="og:title"]').attr('content') ||
            $('title').text() ||
            url;

          rawDescription =
            $('meta[property="og:description"]').attr('content') ||
            $('meta[name="description"]').attr('content') ||
            '';

          bodyText = $('p')
            .map((_, el) => $(el).text().trim())
            .get()
            .join(' ')
            .slice(0, 1500);

          image = $('meta[property="og:image"]').attr('content') || '';
        }
      } catch {
        rawTitle = new URL(url).hostname.replace('www.', '');
        rawDescription = url;
      }
    }

    let finalTitle = (rawTitle || url).trim();
    let finalSummary = (rawDescription || 'Saved link in LinkMind').trim().slice(0, 220);
    let finalCategory = 'General';
    let embedding: number[] = [];

    if (process.env.GEMINI_API_KEY) {
      const targetLanguage =
        lang === 'ar' ? 'Arabic' : lang === 'tr' ? 'Turkish' : 'English';

      const prompt = `
        Analyze this saved link and provide:
        1. A clean, engaging title in ${targetLanguage}.
        2. A helpful 3-sentence summary in ${targetLanguage} based on the title, description, and URL context.
        3. The best matching category from ONLY these exact words: "Programming", "Learning", "Business", "General".

        URL: ${url}
        Extracted Title: ${rawTitle}
        Description: ${rawDescription}
        Content Snippet: ${bodyText}
      `;

      const modelsToTry = ['gemini-2.0-flash', 'gemini-1.5-flash'];

      for (const modelName of modelsToTry) {
        try {
          const aiResponse = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
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

          const result = JSON.parse(aiResponse.text || '{}');
          finalTitle = result.title || finalTitle;
          finalSummary = result.summary || finalSummary;
          if (['Programming', 'Learning', 'Business', 'General'].includes(result.category)) {
            finalCategory = result.category;
          }
          break;
        } catch (aiErr) {
          console.warn(`Model ${modelName} failed, trying next...`, aiErr);
        }
      }

      // توليد البصمة الدلالية (Embedding) للبحث بالمعنى
      try {
        const embRes = await ai.models.embedContent({
          model: 'text-embedding-004',
          contents: `${finalTitle}. ${finalSummary}`,
        });
        embedding = embRes.embeddings?.[0]?.values || [];
      } catch (embErr) {
        console.warn('Embedding generation skipped:', embErr);
      }
    }

    return NextResponse.json({
      title: finalTitle,
      summary: finalSummary,
      category: finalCategory,
      image_url: image,
      embedding,
    });
  } catch (error) {
    console.error('Server Analyze Error:', error);
    return NextResponse.json(
      { error: 'حدث خطأ أثناء معالجة الرابط في الخادم' },
      { status: 500 }
    );
  }
}