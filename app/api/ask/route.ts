import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export async function POST(req: Request) {
  try {
    const { query, bookmarks, lang, mode } = await req.json();

    if (!query) {
      return NextResponse.json({ error: 'Missing query' }, { status: 400 });
    }

    // 1. وضع توليد البصمة الدلالية للبحث (Embedding)
    if (mode === 'embed') {
      if (!process.env.GEMINI_API_KEY) {
        return NextResponse.json({ embedding: [] });
      }
      try {
        const embRes = await ai.models.embedContent({
          model: 'text-embedding-004',
          contents: query,
        });
        return NextResponse.json({
          embedding: embRes.embeddings?.[0]?.values || [],
        });
      } catch {
        return NextResponse.json({ embedding: [] });
      }
    }

    // 2. وضع الدردشة مع المكتبة (RAG Q&A)
    const targetLanguage =
      lang === 'ar' ? 'Arabic' : lang === 'tr' ? 'Turkish' : 'English';

    const savedList = bookmarks || [];
    const contextText = savedList
      .slice(0, 15)
      .map(
        (b: { title: string; summary: string; url: string }, idx: number) =>
          `[${idx + 1}] Title: ${b.title}\nSummary: ${b.summary}\nURL: ${b.url}`
      )
      .join('\n\n');

    const prompt = `
      You are LinkMind AI, the user's personal knowledge assistant.
      Answer the user's question in ${targetLanguage} based ONLY on their saved bookmarks below.
      Mention the relevant bookmark titles clearly.

      Saved Bookmarks:
      ${contextText}

      User Question: ${query}
    `;

    // تجربة النماذج المتاحة بالترتيب
    if (process.env.GEMINI_API_KEY) {
      const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
      for (const modelName of modelsToTry) {
        try {
          const aiResponse = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
          });
          if (aiResponse.text) {
            return NextResponse.json({ answer: aiResponse.text });
          }
        } catch (err) {
          console.warn(`Ask model ${modelName} failed, trying next...`);
        }
      }
    }

    // 3. خطة احتياطية ذكية (تعمل محلياً حتى لو تعطل API أو انتهى الرصيد)
    const q = query.toLowerCase();
    const matches = savedList.filter(
      (b: { title: string; summary: string }) =>
        b.title.toLowerCase().includes(q) || b.summary.toLowerCase().includes(q)
    );

    if (matches.length > 0) {
      const titles = matches.map((m: { title: string }) => `• ${m.title}`).join('\n');
      const fallbackMsg =
        lang === 'ar'
          ? `وجدت في ذاكرتك ${matches.length} رابط يطابق بحثك عن "${query}":\n\n${titles}`
          : lang === 'tr'
          ? `Hafızanızda "${query}" ile eşleşen ${matches.length} kayıt buldum:\n\n${titles}`
          : `I found ${matches.length} saved item(s) matching "${query}":\n\n${titles}`;
      return NextResponse.json({ answer: fallbackMsg });
    }

    const notFoundMsg =
      lang === 'ar'
        ? `لم أجد روابط تطابق "${query}" في مكتبتك الحالية.`
        : lang === 'tr'
        ? `Mevcut kütüphanenizde "${query}" ile eşleşen bir bağlantı bulunamadı.`
        : `No saved links matching "${query}" were found in your library.`;

    return NextResponse.json({ answer: notFoundMsg });
  } catch (error) {
    console.error('Ask API Error:', error);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}