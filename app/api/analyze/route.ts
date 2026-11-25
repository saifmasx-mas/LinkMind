import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import { YoutubeTranscript } from 'youtube-transcript';
import { GoogleGenAI, Type } from '@google/genai';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { fetchPublicUrl } from '@/lib/safe-fetch';
import { generateContentWithFallback } from '@/lib/gemini';
import { getAuthenticatedUserId } from '@/lib/auth';
import { deductCredit } from '@/lib/credits';
import { checkRateLimit, pruneRateLimitBuckets } from '@/lib/rate-limit';

// رفع المهلة القصوى للسيرفر في Vercel لتجنب خطأ 504 Timeout
export const maxDuration = 60;

// A book sent as base64 must stay small: the browser already limits it to
// 1.8 MB, but the server must enforce its own limit (the client can be bypassed).
const MAX_BOOK_BASE64_BYTES = 5 * 1024 * 1024;

// TIMEOUT FIX (2026-11-25): the optional embedding call has no deadline of
// its own — a hung embedContent could push the request past Vercel's 60s
// limit and surface as a 504. Race it against a short timer; on timeout the
// embedding is simply skipped, exactly like an embedding error today.
const EMBEDDING_TIMEOUT_MS = 8_000;

// FOLLOW-UP FIX (2026-11-25): even an 8s embedding race is too much when
// the request is already old — a slow fetch plus a slow Gemini stage can
// leave the request at ~45s, and 8 more seconds would push it past the
// frontend's 55s abort. Skip the optional embedding entirely once the
// request is past this age; the analysis still succeeds with [].
const EMBEDDING_DEADLINE_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function extractYouTubeId(url: string): string | null {
  const regExp =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regExp);
  return match ? match[1] : null;
}

// فك اختصار روابط تيك توك القصيرة بمهلة 3 ثوانٍ كحد أقصى.
// يقتصر على نطاقي vm.tiktok.com و vt.tiktok.com، ويُقبل الرابط النهائي فقط
// إذا كان ما يزال على نطاق tiktok.com — حتى لا يتحول فك الاختصار إلى SSRF.
//
// SECURITY (2026-11-24 audit): the old version used fetch() with
// redirect: 'follow' and only checked the destination AFTER the request
// had already been made. Redirects are now followed MANUALLY, one hop at
// a time: each Location is validated (must stay on *.tiktok.com) BEFORE
// the next request is made, at most 3 hops, and the response body is never
// read — only the final URL is returned. The actual page fetch afterwards
// still goes through fetchPublicUrl.
async function resolveShortUrl(url: string): Promise<string> {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  if (host !== 'vm.tiktok.com' && host !== 'vt.tiktok.com') return url;
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    let res: Response;
    try {
      res = await fetch(current, {
        method: 'GET',
        // Manual redirects: validate each hop before following it.
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        },
      });
    } catch {
      return url;
    }
    const location = res.headers.get('location');
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    if (!isRedirect || !location) {
      // Not a redirect: `current` is the final URL. Discard the body.
      try {
        await res.body?.cancel();
      } catch {
        // Body already consumed or unavailable; nothing to do.
      }
      return current;
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return url;
    }
    const nextHost = next.hostname.toLowerCase();
    if (nextHost !== 'tiktok.com' && !nextHost.endsWith('.tiktok.com')) {
      return url;
    }
    current = next.toString();
  }
  return current;
}

export async function POST(req: Request) {
  try {
    // Wall-clock start of the request, used by the deadline-aware
    // embedding skip below (see EMBEDDING_DEADLINE_MS).
    const requestStartedAt = Date.now();

    // C1: never trust a userId from the request body. The caller must prove
    // who they are with their Supabase session token.
    const userId = await getAuthenticatedUserId(req);
    if (!userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // SECURITY (2026-11-24 audit): 10 analyses per minute per user, so one
    // account cannot burn the Gemini quota. See lib/rate-limit.ts for the
    // in-memory limitation note (needs Upstash/Redis for a global limit).
    pruneRateLimitBuckets();
    const analyzeLimit = checkRateLimit(`analyze:${userId}`, 10, 60_000);
    if (!analyzeLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil((analyzeLimit.resetAt - Date.now()) / 1000)) },
        }
      );
    }

    const body = await req.json();
    const {
      url = '',
      lang = 'ar',
      bookTitle,
      bookText,
      bookBase64,
      bookMimeType,
      bookType,
    } = body;

    if (!url && !bookText && !bookBase64) {
      return NextResponse.json(
        { error: 'URL or book content is required' },
        { status: 400 }
      );
    }

    if (typeof bookBase64 === 'string') {
      const approxBytes = Math.floor((bookBase64.length * 3) / 4);
      if (approxBytes > MAX_BOOK_BASE64_BYTES) {
        return NextResponse.json(
          { error: 'Book file is too large (max 5 MB)' },
          { status: 413 }
        );
      }
    }

    // C2: the admin client is created inside the handler (via the helper that
    // validates the environment variables), never at module load time.
    let admin;
    try {
      admin = createSupabaseAdminClient();
    } catch {
      return NextResponse.json(
        { error: 'Supabase is not configured' },
        { status: 503 }
      );
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
      // I8: a failed profile insert used to be ignored silently and then
      // reported as a misleading OUT_OF_CREDITS. Fail loudly instead.
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

    let rawTitle = bookTitle || '';
    let rawDescription = '';
    let bodyContent = bookText ? String(bookText).slice(0, 14000) : '';
    let image = '';
    let finalUrl = String(url || '').trim();
    const isBookOrDoc = Boolean(bookText || bookBase64);
    // NO-CONTENT FIX (2026-11-25): track whether the fetch stage actually
    // brought back real content. `hasRealTitle` is true only for a genuine
    // title fetched from the source (oEmbed / og:title / book title) — never
    // for a placeholder such as 'YouTube Tutorial' or 'TikTok Video'.
    // `hasTranscript` is true only when a real YouTube transcript was fetched.
    // Both are used below to refuse invented summaries (see the gate after
    // the fetch stage) and to stop Gemini overwriting a real title.
    let hasRealTitle = Boolean(bookTitle);
    let hasTranscript = false;
    // I7: set when the page/transcript could not be fetched, so the summary
    // is based on the title alone and the user is told about it.
    let contentWarning = false;

    if (isBookOrDoc) {
      finalUrl = `file://${bookType || 'pdf'}/${encodeURIComponent(bookTitle || 'Book')}`;
    } else {
      // I5: refuse to analyse a link the user already saved.
      const { data: existing } = await admin
        .from('bookmarks')
        .select('id')
        .eq('user_id', userId)
        .eq('url', finalUrl)
        .maybeSingle();
      if (existing) {
        return NextResponse.json(
          { error: 'DUPLICATE_LINK', remainingCredits: currentCredits },
          { status: 409 }
        );
      }

      const lowerUrl = finalUrl.toLowerCase();
      const videoId = extractYouTubeId(finalUrl);

      if (videoId) {
        try {
          const ytRes = await fetchPublicUrl(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(finalUrl)}&format=json`
          );
          if (ytRes.status >= 200 && ytRes.status < 300) {
            const ytData = JSON.parse(ytRes.body.toString('utf8'));
            if (ytData.title) hasRealTitle = true;
            rawTitle = ytData.title || 'YouTube Tutorial';
            rawDescription = `Channel: ${ytData.author_name || 'YouTube'}`;
            image = ytData.thumbnail_url || '';
          } else {
            contentWarning = true;
          }
        } catch {
          contentWarning = true;
        }

        try {
          // NO-CONTENT FIX: the transcript fetch had no deadline — a hung
          // request could eat the whole 60s Vercel budget. 15s is enough
          // for a real transcript and leaves room for the Gemini stage.
          const transcriptItems = await withTimeout(
            YoutubeTranscript.fetchTranscript(videoId),
            15_000,
            'Transcript timed out'
          );
          bodyContent = transcriptItems
            .map((item) => item.text)
            .join(' ')
            .slice(0, 14000);
          if (bodyContent) {
            hasTranscript = true;
          } else {
            contentWarning = true;
          }
        } catch {
          contentWarning = true;
        }
      } else if (lowerUrl.includes('tiktok.com')) {
        try {
          let targetTikTokUrl = finalUrl;
          if (lowerUrl.includes('vm.tiktok.com') || lowerUrl.includes('vt.tiktok.com')) {
            targetTikTokUrl = await resolveShortUrl(finalUrl);
          }
          const cleanTikTokUrl = targetTikTokUrl.split('?')[0];

          const ttRes = await fetchPublicUrl(
            `https://www.tiktok.com/oembed?url=${encodeURIComponent(cleanTikTokUrl)}`
          );

          if (ttRes.status >= 200 && ttRes.status < 300) {
            const ttData = JSON.parse(ttRes.body.toString('utf8'));
            // NO-CONTENT FIX: TikTok oEmbed answers 200 with NO title and
            // NO author_name — that is an empty success by design, not real
            // content. Only a real title counts.
            if (ttData.title) hasRealTitle = true;
            rawTitle = ttData.title || `TikTok by ${ttData.author_name || 'Creator'}`;
            rawDescription = `TikTok Video by ${ttData.author_name || ''} (@${ttData.author_unique_id || ''}): ${ttData.title || ''}`;
            image = ttData.thumbnail_url || '';
            bodyContent = rawDescription;
          } else {
            contentWarning = true;
            rawTitle = 'TikTok Video';
            rawDescription = `TikTok Video URL: ${cleanTikTokUrl}`;
            bodyContent = rawDescription;
          }
        } catch {
          contentWarning = true;
          rawTitle = 'TikTok Video';
          rawDescription = `TikTok Video URL: ${finalUrl}`;
          bodyContent = rawDescription;
        }
      } else {
        // C4: all public page fetches go through fetchPublicUrl, which blocks
        // private/loopback/cloud-metadata addresses, pins DNS, limits the
        // response to 1 MB and times out after 8 seconds.
        try {
          const res = await fetchPublicUrl(finalUrl);
          const contentType = res.headers['content-type'] || '';
          if (res.status >= 200 && res.status < 300 && contentType.includes('text/html')) {
            const html = res.body.toString('utf8');
            const $ = cheerio.load(html);
            const pageTitle =
              $('meta[property="og:title"]').attr('content') || $('title').text() || '';
            // NO-CONTENT FIX: only a real fetched page title counts — the
            // bare URL is not a title, so Gemini may replace it.
            if (pageTitle) hasRealTitle = true;
            rawTitle = pageTitle || finalUrl;
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
            if (!bodyContent) contentWarning = true;
          } else {
            contentWarning = true;
            rawTitle = finalUrl;
            rawDescription = `Saved link: ${finalUrl}`;
          }
        } catch {
          contentWarning = true;
          rawTitle = finalUrl;
          rawDescription = `Saved web resource: ${finalUrl}`;
        }
      }

      // NO-CONTENT FIX (2026-11-25): when the fetch stage brought back no
      // real content, do NOT send a near-empty prompt to Gemini — the model
      // invents a title, summary and category that have nothing to do with
      // the source, and that invented result used to be saved and charged
      // for (e.g. a nasheed saved as a Python GPT tutorial, a comedy clip
      // saved as a digital-growth guide). Fail fast instead: 503
      // CONTENT_UNAVAILABLE, no Gemini call, no save, no credit deduction.
      // YouTube has no real content when BOTH the transcript and the oEmbed
      // title are missing; a title alone (or a transcript alone) still
      // proceeds as before. TikTok has no real content when oEmbed gave no
      // title — even its 200 responses can be empty by design.
      const isYouTubeLink = Boolean(videoId);
      const isTikTokLink = !videoId && lowerUrl.includes('tiktok.com');
      const hasNoRealContent =
        (isYouTubeLink && !hasTranscript && !hasRealTitle) || (isTikTokLink && !hasRealTitle);
      if (hasNoRealContent) {
        return NextResponse.json(
          {
            error: 'CONTENT_UNAVAILABLE',
            message:
              'تعذّر جلب محتوى هذا الرابط، فلم يتم إنشاء ملخص. جرّب رابطاً آخر، ولم يُخصم أي رصيد.',
            contentWarning: true,
          },
          { status: 503 }
        );
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

    // C7: without a working Gemini call there is no summary to charge for.
    // Return 503 and deduct nothing instead of charging for a raw title.
    const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
    if (!geminiApiKey) {
      return NextResponse.json(
        { error: 'AI_UNAVAILABLE', contentWarning },
        { status: 503 }
      );
    }

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
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

    // I1: one shared Gemini fallback helper (lib/gemini.ts) instead of the
    // local generateFast, which retried even auth errors and started with
    // the undocumented gemini-3.8-flash-lite model.
    let aiRes;
    try {
      aiRes = await generateContentWithFallback(ai, {
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
    } catch (error) {
      console.error('Gemini analysis failed:', error);
      return NextResponse.json(
        { error: 'AI_UNAVAILABLE', contentWarning },
        { status: 503 }
      );
    }

    try {
      const parsed = JSON.parse(aiRes.text || '{}');
      // NO-CONTENT FIX: never let the model overwrite a real fetched title
      // (e.g. the oEmbed title) with an invented one. The model's title is
      // only accepted when the original title was missing in the first place.
      if (!hasRealTitle && parsed.title) {
        finalTitle = parsed.title;
      }
      finalSummary = parsed.summary || finalSummary;
      if (['Programming', 'Learning', 'Business', 'General'].includes(parsed.category)) {
        finalCategory = parsed.category;
      }
      if (Array.isArray(parsed.checklist)) {
        finalChecklist = parsed.checklist;
      }
    } catch {
      // Keep the fetched title/description when the model returns bad JSON.
      contentWarning = true;
    }

    // Deadline-aware: if the request is already past ~45s (slow fetch +
    // slow Gemini), skip the optional embedding entirely — spending up to
    // 8 more seconds on it could push the request past the frontend's 55s
    // abort. The analysis still succeeds with embedding = [].
    if (Date.now() - requestStartedAt <= EMBEDDING_DEADLINE_MS) {
      try {
        const embRes = await withTimeout(
          ai.models.embedContent({
            model: 'text-embedding-004',
            contents: `${finalTitle}. ${finalSummary}. ${finalChecklist.join(' ')}`,
          }),
          EMBEDDING_TIMEOUT_MS,
          'Embedding timed out'
        );
        embedding = embRes.embeddings?.[0]?.values || [];
      } catch {
        // An embedding is optional; a failed or timed-out embedding must not fail the analysis.
      }
    }

    // Deduct only after a successful AI analysis (see C7 above).
    let updatedCredits = currentCredits;
    if (!isPro) {
      const newCredits = await deductCredit(admin, userId, currentCredits);
      if (newCredits === null) {
        return NextResponse.json(
          { error: 'OUT_OF_CREDITS', remainingCredits: 0 },
          { status: 402 }
        );
      }
      updatedCredits = newCredits;
    }

    return NextResponse.json({
      url: finalUrl,
      title: finalTitle,
      summary: finalSummary,
      category: finalCategory,
      image_url: image,
      checklist: finalChecklist,
      embedding,
      contentWarning,
      remainingCredits: updatedCredits,
      planType: profile?.plan_type || 'free',
    });
  } catch (err: any) {
    // SECURITY (2026-11-24 audit): never return the raw error message to
    // the visitor — it can leak SQL text, table/column names, file paths
    // or stack traces. Details stay in the server log only.
    console.error('Analyze Error:', err);
    return NextResponse.json({ error: 'Failed to analyze content' }, { status: 500 });
  }
}
