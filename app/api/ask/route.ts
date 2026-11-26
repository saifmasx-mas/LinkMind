import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { generateContentWithFallback } from '@/lib/gemini';
import { getAuthenticatedUserId } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { deductCredit } from '@/lib/credits';
import { checkRateLimit, pruneRateLimitBuckets } from '@/lib/rate-limit';
import { stripBookChapters } from '@/lib/book-reader';

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    // C1: this route spends Gemini quota, so it must not be callable
    // anonymously. The caller proves who they are with their session token.
    const userId = await getAuthenticatedUserId(req);
    if (!userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { query, bookmarks, lang, mode } = await req.json();

    if (!query) {
      return NextResponse.json({ error: 'Missing query' }, { status: 400 });
    }

    pruneRateLimitBuckets();

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

    // 1. وضع توليد البصمة الدلالية للبحث (Embedding)
    // SECURITY (2026-11-24 audit): embedding is called on every keystroke
    // (debounced 500ms in app/page.tsx), so charging a credit per call
    // would drain a user's balance in one search and break the library
    // search. It is NOT charged. It is still authenticated and rate
    // limited (30/min per user), and the embedding model call is cheap.
    if (mode === 'embed') {
      const embedLimit = checkRateLimit(`ask-embed:${userId}`, 30, 60_000);
      if (!embedLimit.allowed) {
        return NextResponse.json(
          { error: 'Too many requests', embedding: [] },
          {
            status: 429,
            headers: { 'Retry-After': String(Math.ceil((embedLimit.resetAt - Date.now()) / 1000)) },
          }
        );
      }
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
    // SECURITY (2026-11-24 audit, high): this mode used to call Gemini
    // with no credit check at all, so any signed-in user could burn the
    // Gemini key for free. It now uses the same server-side credit
    // check/deduct as /api/analyze, and is rate limited to 10/min.
    const chatLimit = checkRateLimit(`ask-chat:${userId}`, 10, 60_000);
    if (!chatLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil((chatLimit.resetAt - Date.now()) / 1000)) },
        }
      );
    }

    let admin;
    try {
      admin = createSupabaseAdminClient();
    } catch {
      return NextResponse.json({ error: 'Service is not configured' }, { status: 503 });
    }

    let { data: profile, error: profileError } = await admin
      .from('user_profiles')
      .select('credits, plan_type')
      .eq('user_id', userId)
      .maybeSingle();

    if (profileError) {
      console.error('Failed to load user profile:', profileError.message);
      return NextResponse.json({ error: 'Could not load user profile' }, { status: 500 });
    }

    if (!profile) {
      const { data: newProfile, error: insertError } = await admin
        .from('user_profiles')
        .insert({ user_id: userId, credits: 5, plan_type: 'free' })
        .select('credits, plan_type')
        .single();
      if (insertError || !newProfile) {
        console.error('Failed to create user profile:', insertError?.message);
        return NextResponse.json({ error: 'Could not create user profile' }, { status: 500 });
      }
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

    const targetLanguage =
      lang === 'ar' ? 'Arabic' : lang === 'tr' ? 'Turkish' : 'English';

    const savedList = bookmarks || [];
    // BOOK READER (2026-11-27): a book summary carries the structured
    // chapters in a storage envelope — strip it before feeding the
    // summary to Gemini or searching it, so the JSON never pollutes
    // the answer context or a keyword match.
    const contextText = savedList
      .slice(0, 15)
      .map(
        (b: { title: string; summary: string; url: string }, idx: number) =>
          `[${idx + 1}] Title: ${b.title}\nSummary: ${stripBookChapters(b.summary)}\nURL: ${b.url}`
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

    // Use the current Gemini Flash models for library questions.
    // Deduct only after a successful AI answer (same rule as analyze):
    // the local keyword fallback below is free and deducts nothing.
    if (process.env.GEMINI_API_KEY) {
      try {
        const aiResponse = await generateContentWithFallback(ai, { contents: prompt });
        if (aiResponse.text) {
          let remainingCredits = currentCredits;
          if (!isPro) {
            const newCredits = await deductCredit(admin, userId, currentCredits);
            if (newCredits === null) {
              return NextResponse.json(
                { error: 'OUT_OF_CREDITS', remainingCredits: 0 },
                { status: 402 }
              );
            }
            remainingCredits = newCredits;
          }
          return NextResponse.json({
            answer: aiResponse.text,
            remainingCredits,
            planType: profile?.plan_type || 'free',
          });
        }
      } catch (error) {
        console.warn('All Gemini models failed for library question:', error);
      }
    }

    // 3. خطة احتياطية ذكية (تعمل محلياً حتى لو تعطل API أو انتهى الرصيد)
    const q = query.toLowerCase();
    const matches = savedList.filter(
      (b: { title: string; summary: string }) =>
        b.title.toLowerCase().includes(q) ||
        stripBookChapters(b.summary).toLowerCase().includes(q)
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
