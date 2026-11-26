import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import { YoutubeTranscript } from 'youtube-transcript';
import { GoogleGenAI, Type } from '@google/genai';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { fetchPublicUrl } from '@/lib/safe-fetch';
import { fetchYouTubeApiMetadata, fetchYouTubeOEmbed } from '@/lib/youtube';
import { fetchTikTokOEmbed, fetchTikTokPageMetadata } from '@/lib/tiktok';
import { generateContentWithFallback } from '@/lib/gemini';
import { MAX_BOOK_TEXT_CHARS, summarizeBookFull } from '@/lib/book-summary';
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
    // FULL-BOOK SUMMARY (2026-11-26): the old 14,000-character cap meant
    // Gemini only ever saw the beginning of a book, so the summary could
    // only cover its most important ideas. The whole extracted text (up
    // to the frontend cap) now reaches the chapter splitter in
    // lib/book-summary.ts.
    let bodyContent = bookText ? String(bookText).slice(0, MAX_BOOK_TEXT_CHARS) : '';
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
    // REAL-CONTENT FIX (2026-11-26): a real description (YouTube Data API
    // description, or a TikTok page description) is real content too, even
    // with no transcript — the summary is then built from the metadata.
    // `metadataOnly` is true when the summary must come from metadata
    // alone, so the prompt can forbid inventing details (see below).
    let hasRealDescription = false;
    let metadataOnly = false;
    // FULL-ARTICLE SUMMARY: true for video/social links (YouTube,
    // TikTok), which keep the short single-call summary — a short clip
    // or post has no sections to split. Long article pages stay false
    // and take the comprehensive path below.
    let isVideoOrSocialLink = false;
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
        isVideoOrSocialLink = true;
        // REAL-CONTENT FIX (2026-11-26): fetch the three sources in
        // PARALLEL so the fetch stage stays at ~10s instead of ~23s
        // sequential (oEmbed 8s + transcript 15s). Each source fails
        // quietly; the merge below takes the best available result.
        // 1) YouTube Data API v3 — primary: real title, full description,
        //    channel, tags, duration. Skipped when YOUTUBE_API_KEY is
        //    absent (safe fallback to oEmbed + transcript).
        // 2) oEmbed — fallback for the title, and the only thumbnail source.
        // 3) Transcript — still attempted for videos that have captions.
        const apiKey = process.env.YOUTUBE_API_KEY?.trim() || undefined;
        const [apiResult, oembedResult, transcriptResult] =
          await Promise.allSettled([
            fetchYouTubeApiMetadata(videoId, apiKey),
            fetchYouTubeOEmbed(finalUrl),
            withTimeout(
              YoutubeTranscript.fetchTranscript(videoId),
              10_000,
              'Transcript timed out'
            ),
          ]);
        const apiMeta =
          apiResult.status === 'fulfilled' ? apiResult.value : null;
        const oembed =
          oembedResult.status === 'fulfilled' ? oembedResult.value : null;
        const transcriptItems =
          transcriptResult.status === 'fulfilled'
            ? transcriptResult.value
            : null;

        if (apiMeta) {
          hasRealTitle = true;
          if (apiMeta.description) hasRealDescription = true;
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
          hasRealTitle = true;
          rawTitle = oembed.title;
          rawDescription = `Channel: ${oembed.authorName || 'YouTube'}`;
        }
        if (oembed?.thumbnailUrl) image = oembed.thumbnailUrl;

        if (transcriptItems && transcriptItems.length > 0) {
          bodyContent = transcriptItems
            .map((item) => item.text)
            .join(' ')
            .slice(0, 14000);
          if (bodyContent) hasTranscript = true;
        }
        if (!apiMeta && !oembed && !hasTranscript) contentWarning = true;
        // No transcript: the summary comes from the metadata alone.
        metadataOnly = !hasTranscript;
      } else if (lowerUrl.includes('tiktok.com')) {
        isVideoOrSocialLink = true;
        let targetTikTokUrl = finalUrl;
        if (lowerUrl.includes('vm.tiktok.com') || lowerUrl.includes('vt.tiktok.com')) {
          targetTikTokUrl = await resolveShortUrl(finalUrl);
        }
        const cleanTikTokUrl = targetTikTokUrl.split('?')[0];

        // REAL-CONTENT FIX (2026-11-26): fetch both sources in PARALLEL.
        // 1) The video page itself — primary: real description, author,
        //    music, hashtags and statistics from the embedded JSON block.
        // 2) oEmbed — fallback only: it answers 200 with no title and no
        //    author by design, so it can only confirm the link exists.
        const [pageResult, ttOembedResult] = await Promise.allSettled([
          fetchTikTokPageMetadata(cleanTikTokUrl),
          fetchTikTokOEmbed(cleanTikTokUrl),
        ]);
        const pageMeta =
          pageResult.status === 'fulfilled' ? pageResult.value : null;
        const ttOembed =
          ttOembedResult.status === 'fulfilled' ? ttOembedResult.value : null;

        if (pageMeta) {
          hasRealTitle = true;
          hasRealDescription = true;
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
          bodyContent = rawDescription;
          // TikTok never has a transcript: the summary comes from the
          // metadata alone.
          metadataOnly = true;
        } else if (ttOembed) {
          hasRealTitle = true;
          rawTitle = ttOembed.title;
          rawDescription = `TikTok Video by ${ttOembed.authorName || ''} (@${ttOembed.authorUniqueId || ''}): ${ttOembed.title}`;
          image = ttOembed.thumbnailUrl || '';
          bodyContent = rawDescription;
        } else {
          contentWarning = true;
          rawTitle = 'TikTok Video';
          rawDescription = `TikTok Video URL: ${cleanTikTokUrl}`;
          bodyContent = rawDescription;
        }
        // The page metadata has no thumbnail; keep oEmbed's when present.
        if (pageMeta && ttOembed?.thumbnailUrl) image = ttOembed.thumbnailUrl;
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
            // FULL-ARTICLE SUMMARY: keep one line per element (headings
            // stay on their own lines) so the section splitter in
            // lib/book-summary.ts can find the article's own headings,
            // and keep up to the full-text cap instead of 14,000 chars —
            // the short single-call path below slices its own copy.
            bodyContent = $('article, main, body')
              .find('h1, h2, h3, p, li')
              .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
              .get()
              .filter(Boolean)
              .join('\n')
              .slice(0, MAX_BOOK_TEXT_CHARS);
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

      // NO-CONTENT FIX (2026-11-25) + REAL-CONTENT FIX (2026-11-26): when
      // the fetch stage brought back no real content, do NOT send a
      // near-empty prompt to Gemini — the model invents a title, summary
      // and category that have nothing to do with the source, and that
      // invented result used to be saved and charged for. Fail fast
      // instead: 503 CONTENT_UNAVAILABLE, no Gemini call, no save, no
      // credit deduction. "Real content" now means a transcript OR a real
      // title and/or a real description: a YouTube video with an API
      // title + description (no captions) or a TikTok clip with a real
      // page description now proceeds to a metadata-based summary instead
      // of failing. Only when ALL sources fail does the 503 path trigger.
      const isYouTubeLink = Boolean(videoId);
      const isTikTokLink = !videoId && lowerUrl.includes('tiktok.com');
      const hasNoRealContent =
        (isYouTubeLink && !hasTranscript && !hasRealTitle && !hasRealDescription) ||
        (isTikTokLink && !hasRealTitle && !hasRealDescription);
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

    // NO-CONTENT FIX for books (2026-11-26): a book with a title but
    // almost no extracted text must not reach Gemini — the model would
    // invent a summary of a book it cannot read, exactly the invented
    // summaries PR #6 stopped for links. Fail fast with the same 503,
    // no Gemini call, no save, no credit deduction.
    if (isBookOrDoc && !bookBase64 && bodyContent.trim().length < 80) {
      return NextResponse.json(
        {
          error: 'CONTENT_UNAVAILABLE',
          message:
            'تعذّر استخراج نص هذا الكتاب، فلم يتم إنشاء ملخص. جرّب ملفاً آخر، ولم يُخصم أي رصيد.',
          contentWarning: true,
        },
        { status: 503 }
      );
    }

    const langInstruction =
      lang === 'ar'
        ? 'Write the title, summary, and checklist steps in clear, eloquent Arabic.'
        : lang === 'tr'
        ? 'Write the title, summary, and checklist steps in clear, natural Turkish.'
        : 'Write the title, summary, and checklist steps in clear, natural English.';

    // REAL-CONTENT FIX (2026-11-26): when there is no transcript, the
    // summary comes from the metadata alone. Say so explicitly — otherwise
    // the model fills the gaps with invented details, quotes or steps.
    const metadataOnlyNote = metadataOnly
      ? '\nIMPORTANT: No transcript or full text is available for this video. Summarize ONLY from the title, description, channel/author, tags and statistics provided below. Do NOT invent details, quotes, timestamps or steps that are not in the provided metadata. If the metadata is thin, keep the summary short and factual.'
      : '';

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

    // FULL-BOOK SUMMARY (2026-11-26) + FULL-ARTICLE SUMMARY: a book
    // sent as extracted text is summarised chapter by chapter in
    // lib/book-summary.ts (parallel per-chapter Gemini calls, combined
    // into one organised summary). A long article page (a blog such as
    // Blogger, or any article link with substantial text) takes the
    // same path section by section. Scanned PDFs (bookBase64, where
    // Gemini reads the file itself), videos and short posts keep the
    // single-call path below.
    let fullBookResult: { summary: string; checklist: string[] } | null = null;
    let aiRes;
    // A video/social link never takes the article path; a generic page
    // only does when it brought back substantial real text (>= 1000
    // chars) — a thin page still gets the short metadata summary.
    const isFullArticle =
      !isBookOrDoc && !isVideoOrSocialLink && bodyContent.trim().length >= 1000;
    if ((isBookOrDoc || isFullArticle) && bodyContent) {
      try {
        fullBookResult = await summarizeBookFull(ai, {
          text: bodyContent,
          lang,
          requestStartedAt,
          kind: isBookOrDoc ? 'book' : 'article',
        });
      } catch (error) {
        console.error('Gemini full book summary failed:', error);
        return NextResponse.json(
          { error: 'AI_UNAVAILABLE', contentWarning },
          { status: 503 }
        );
      }
    } else {
      const promptText = isBookOrDoc
        ? `Summarize this whole book/document comprehensively, chapter by chapter, and extract:
1. A clean book/document title.
2. A FULL summary covering ALL main ideas of the whole document, organised chapter by chapter: for each chapter give its title and every main idea. Do not leave out any main idea — this is a comprehensive summary, not just the top ideas.
3. Category: ONLY one of "Programming", "Learning", "Business", "General".
4. Actionable Checklist: the key principles and practical steps from the whole book (up to 10 items).

${langInstruction}

Title: ${rawTitle}
${bodyContent ? `Content: ${bodyContent}` : ''}`
        : `Summarize this video/post/article and extract:
1. A clean, concise title.
2. A 2-sentence executive summary.
3. Category: ONLY one of "Programming", "Learning", "Business", "General".
4. Actionable Checklist: 4 to 7 practical step-by-step instructions or key takeaways.
${metadataOnlyNote}

${langInstruction}

Title: ${rawTitle}
Description: ${rawDescription}
Content/Transcript: ${(bodyContent || rawDescription).slice(0, 14000)}
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
    }

    if (fullBookResult) {
      // Chapter-by-chapter (or section-by-section) summary: the title
      // stays the real fetched title (hasRealTitle), the summary is the
      // combined per-section text. Books are Learning; articles keep
      // the default category set above (General).
      finalSummary = fullBookResult.summary;
      finalChecklist = fullBookResult.checklist;
      if (isBookOrDoc) finalCategory = 'Learning';
    } else {
      try {
        const parsed = JSON.parse(aiRes?.text || '{}');
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
