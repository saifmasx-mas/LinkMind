import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import { YoutubeTranscript } from 'youtube-transcript';
import { GoogleGenAI, Type } from '@google/genai';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';
import { fetchPublicUrl } from '@/lib/safe-fetch';
import { checkLinkBeforeSave } from '@/lib/link-probe';
import { preferHttpsUrl } from '@/lib/link-check';
import { unwrapRedirectUrl } from '@/lib/redirect-unwrap';
import { resolveShortUrl } from '@/lib/short-url';
import { hasRealLinkContent } from '@/lib/content-gate';
import { extractArticleText } from '@/lib/article-extract';
import { fetchYouTubeApiMetadata, fetchYouTubeOEmbed } from '@/lib/youtube';
import { fetchTikTokOEmbed, fetchTikTokPageMetadata } from '@/lib/tiktok';
import { generateContentWithFallback } from '@/lib/gemini';
import {
  MAX_BOOK_TEXT_CHARS,
  isTruncatedBookText,
  shouldUseFullSummary,
  summarizeBookFull,
  summarizeScannedBook,
} from '@/lib/book-summary';
import { appendBookChapters } from '@/lib/book-reader';
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
      bookTextLength,
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
      // NEW-ACCOUNT CREDITS (2026-11-27): 10 free credits for the DEMO
      // phase, so a committee member can try the site properly.
      // Revert to 5 at the official launch (own domain + payment
      // gateway). Existing balances are untouched — this only sets
      // the starting balance of a brand-new account.
      const { data: newProfile, error: insertError } = await admin
        .from('user_profiles')
        .insert({ user_id: userId, credits: 10, plan_type: 'free' })
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
    // CONTENT GATE (2026-11-26): set when the generic page fetch failed
    // outright (network error, non-2xx status, non-HTML), so the shared
    // gate below can refuse it instead of sending the bare URL to Gemini.
    let genericFetchFailed = false;

    if (isBookOrDoc) {
      finalUrl = `file://${bookType || 'pdf'}/${encodeURIComponent(bookTitle || 'Book')}`;
    } else {
      // REDIRECT WRAPPERS (2026-11-27): a link pasted from
      // Facebook/Meta arrives wrapped (l.meta.ai/?u=...), and the
      // stored card then points at Meta's redirect shim instead of
      // the article — clicking it stays about:blank. Unwrap it
      // BEFORE the short-link resolve, the duplicate check and the
      // fetch, so the saved row, the summary fetch and the dedup all
      // use the direct URL. The wrapper's `h` parameter is Meta's
      // hash, not a destination — a mangled hash (as on one live
      // Blogger card) is ignored by the unwrapper.
      finalUrl = unwrapRedirectUrl(finalUrl);

      // HTTP→HTTPS UPGRADE (2026-11-27): many sites (Blogger included)
      // 301-redirect plain http to https, and live the http paste of
      // the Android 17 article failed with CONTENT_UNAVAILABLE while
      // the SAME link as https saved immediately. Upgrade the scheme
      // before the resolve / dedup / probe / fetch below, so the saved
      // row carries the canonical https URL. The original http URL is
      // kept as a fallback for the probe: if the https probe fails,
      // the http URL is tried too, so genuinely http-only sites still
      // work (and the post-analysis duplicate guard still catches a
      // row saved under the http URL).
      let httpFallbackUrl: string | null = null;
      const upgradedUrl = preferHttpsUrl(finalUrl);
      if (upgradedUrl !== finalUrl) {
        httpFallbackUrl = finalUrl;
        finalUrl = upgradedUrl;
      }

      // LINKEDIN SHORT LINKS (2026-11-26): LinkedIn shares from the app
      // come as lnkd.in links. Resolve them to the canonical linkedin.com
      // URL BEFORE the duplicate check, so the same post pasted as a short
      // link twice (or once short, once full) is recognised as the same
      // link, and the saved row carries a URL the library classifies as
      // LinkedIn. On any failure the pasted URL is kept as-is.
      if (finalUrl.toLowerCase().includes('lnkd.in')) {
        finalUrl = await resolveShortUrl(
          finalUrl,
          ['lnkd.in'],
          (h) => h === 'linkedin.com' || h.endsWith('.linkedin.com')
        );
      }

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

      // FAST LINK CHECK (2026-11-27): probe reachability BEFORE the
      // heavy fetch stage. A dead link used to wait out the full
      // fetch (up to ~16s with the browser-UA retry) before the
      // generic CONTENT_UNAVAILABLE error. A DNS failure, a refused
      // connection, a timeout or a 404/410 now fails fast with an
      // honest message — no Gemini call, no save, no credit
      // deduction. Any other status (403, 429, 500, redirect…)
      // proceeds: the fetch stage and the content gate below still
      // decide those, so a bot-blocked host is never wrongly refused
      // here.
      const linkCheck = await checkLinkBeforeSave(finalUrl);
      // HTTP→HTTPS FALLBACK (2026-11-27): the upgraded https probe
      // failed — the site may be http-only after all. Try the pasted
      // http URL before refusing; if it answers, the save proceeds
      // with it (the duplicate guard below still applies).
      let effectiveLinkCheck = linkCheck;
      if (!linkCheck.ok && httpFallbackUrl) {
        const fallbackCheck = await checkLinkBeforeSave(httpFallbackUrl);
        if (fallbackCheck.ok) {
          finalUrl = httpFallbackUrl;
          effectiveLinkCheck = fallbackCheck;
        }
      }
      if (!effectiveLinkCheck.ok) {
        console.error('Link pre-check failed:', finalUrl, effectiveLinkCheck.error);
        return NextResponse.json(
          { error: effectiveLinkCheck.error, message: effectiveLinkCheck.message },
          { status: effectiveLinkCheck.status }
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
          targetTikTokUrl = await resolveShortUrl(
            finalUrl,
            ['vm.tiktok.com', 'vt.tiktok.com'],
            (h) => h === 'tiktok.com' || h.endsWith('.tiktok.com')
          );
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
        // BLOGGER FETCH FIX (2026-11-26): the first fetch attempt uses the
        // default LinkMindBot UA. Some hosts (Blogger included) serve bot
        // checks or thin pages to unknown bots, so a failed first attempt
        // is retried once with an ordinary browser UA before giving up.
        // Every failure is logged with the URL and reason — the old code
        // swallowed the error silently, so a live fetch failure (like the
        // Blogger article on 2026-11-26) could only be guessed at.
        try {
          let res;
          try {
            res = await fetchPublicUrl(finalUrl);
          } catch (firstError) {
            console.error(
              'Page fetch failed with LinkMindBot UA, retrying with browser UA:',
              finalUrl,
              firstError instanceof Error ? firstError.message : String(firstError)
            );
            res = await fetchPublicUrl(finalUrl, 0, {
              userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            });
          }
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

            // FULL-ARTICLE SUMMARY: extractArticleText keeps one line per
            // element (headings stay on their own lines) so the section
            // splitter in lib/book-summary.ts can find the article's own
            // headings, and falls back to the article container text and
            // JSON-LD articleBody when a template (many Blogger themes)
            // puts the body in <div>s instead of <p> tags. Keep up to the
            // full-text cap instead of 14,000 chars — the short
            // single-call path below slices its own copy.
            bodyContent = extractArticleText(html).slice(0, MAX_BOOK_TEXT_CHARS);
            if (!bodyContent) contentWarning = true;
          } else {
            console.error(
              'Page fetch returned unusable response:',
              finalUrl,
              'status',
              res.status,
              'content-type',
              contentType
            );
            contentWarning = true;
            genericFetchFailed = true;
            rawTitle = finalUrl;
            rawDescription = `Saved link: ${finalUrl}`;
          }
        } catch (error) {
          console.error(
            'Page fetch failed:',
            finalUrl,
            error instanceof Error ? error.message : String(error)
          );
          contentWarning = true;
          genericFetchFailed = true;
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
      // General pages are refused when the fetch failed or the page
      // brought back no real title, no real description and no body text.
      const isYouTubeLink = Boolean(videoId);
      const isTikTokLink = !videoId && lowerUrl.includes('tiktok.com');
      // LINKEDIN (2026-11-26): LinkedIn requires login, so its pages come
      // back as a 999/login wall with no post content. A real post page —
      // a specific og:title plus real body text — still proceeds.
      const isLinkedInLink =
        !videoId &&
        !isTikTokLink &&
        (lowerUrl.includes('linkedin.com') || lowerUrl.includes('lnkd.in'));
      // CONTENT GATE (2026-11-26): one shared decision for every link
      // kind (lib/content-gate.ts) — it also covers general article/blog
      // pages now: a failed fetch, or a page with no real title, no real
      // description and no body text, is refused with 503 instead of
      // reaching Gemini as a bare URL and coming back invented.
      const hasNoRealContent = !hasRealLinkContent({
        kind: isYouTubeLink
          ? 'youtube'
          : isTikTokLink
            ? 'tiktok'
            : isLinkedInLink
              ? 'linkedin'
              : 'general',
        fetchFailed: genericFetchFailed,
        hasRealTitle,
        hasRealDescription,
        hasTranscript,
        bodyTextLength: bodyContent.trim().length,
        title: rawTitle,
      });
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

    // LENGTH-INTEGRITY GUARD (2026-11-27, live incident): the browser
    // sends the length of the text it actually put in the request
    // (`bookTextLength`). If the server receives materially less, the
    // text was cut somewhere between the browser and the server — and
    // summarising the fragment would silently produce a short "full"
    // summary of the beginning of the book only (exactly what happened
    // live to «اللغة الشاعرة»: one generic section, 8 ideas, 2
    // checklist items, from a 135,000-character book). Refuse loudly
    // with a dedicated error instead of saving a misleading summary;
    // no credit is deducted. The frontend shows the matching notice.
    //
    // C1 (audit #2): the claimed length is capped at
    // MAX_BOOK_TEXT_CHARS before comparing — the text is sliced to
    // that cap before sending, so a 250,000-char book legitimately
    // arrives as 200,000 chars. Comparing the received 200,000
    // against the uncapped 250,000 rejected every long book, always.
    // (The browser also sends the post-slice length now; the cap
    // here also protects older cached frontends that send the full
    // length.)
    if (isBookOrDoc && bookText && typeof bookTextLength === 'number') {
      const receivedChars = bodyContent.length;
      const claimedChars = Math.min(bookTextLength, MAX_BOOK_TEXT_CHARS);
      if (isTruncatedBookText(receivedChars, claimedChars)) {
        console.error(
          `[analyze] book text truncated in transit: claimed=${claimedChars} received=${receivedChars}`
        );
        return NextResponse.json(
          {
            error: 'BOOK_TEXT_TRUNCATED',
            message:
              'تعذّر إرسال نص الكتاب كاملاً إلى الخادم، فلم يتم إنشاء ملخص. حاول رفع الكتاب مرة أخرى، ولم يُخصم أي رصيد.',
            contentWarning,
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
    let fullBookResult: Awaited<ReturnType<typeof summarizeBookFull>> | null = null;
    let aiRes;
    // A video/social link never takes the article path; a generic page
    // only does when it brought back substantial real text (>= 1000
    // chars) — a thin page still gets the short metadata summary.
    // EVERY book (PDF or Word, extracted text or scanned file) takes
    // the full path whenever it brought back text — see
    // shouldUseFullSummary in lib/book-summary.ts.
    const isFullArticle =
      !isBookOrDoc && !isVideoOrSocialLink && bodyContent.trim().length >= 1000;
    const useFullSummary = shouldUseFullSummary({
      isBookOrDoc,
      isFullArticle,
      bodyContentLength: bodyContent.length,
    });
    if (useFullSummary) {
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

    // SCANNED BOOK (2026-11-27): an image PDF has no text layer, so
    // the chapter splitter cannot run on it. Ask Gemini to read the
    // PDF itself and return a structured chapter-by-chapter summary —
    // the same reader view and PDF download as a text book. Only
    // attempted while the request is still young (the frontend waits
    // 55s and the short-path fallback below needs time too); on any
    // failure the book falls through to the short summary, so a
    // scanned book is never worse off than before.
    if (!fullBookResult && isBookOrDoc && bookBase64) {
      if (Date.now() - requestStartedAt < 20_000) {
        try {
          fullBookResult = await summarizeScannedBook(ai, {
            base64: bookBase64,
            mimeType: bookMimeType || 'application/pdf',
            lang,
          });
        } catch (error) {
          console.warn(
            'Scanned book structured summary failed, falling back to short summary:',
            error
          );
          fullBookResult = null;
        }
      } else {
        console.warn(
          '[analyze] scanned book structured summary skipped: request already old'
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
      // Diagnostics for the live incident (2026-11-27): a book that
      // arrives intact must split into several chapters. If a future
      // upload ever logs chapters=1 for a long text, the text was cut
      // upstream — the length guard above should have caught it.
      console.log(
        `[analyze] full summary: kind=${isBookOrDoc ? 'book' : 'article'} receivedChars=${bodyContent.length} claimedChars=${typeof bookTextLength === 'number' ? bookTextLength : 'n/a'} chapters=${fullBookResult.chapters.length} checklist=${fullBookResult.checklist.length}`
      );
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

    // BOOK READER (2026-11-27): store the structured chapters with
    // the plain summary so the reader view and the PDF download can
    // open every chapter and every idea. The embedding above was built
    // from the plain text on purpose — the JSON envelope must not
    // pollute it. The envelope is stripped everywhere the summary is
    // shown (see lib/book-reader.ts).
    if (fullBookResult && isBookOrDoc) {
      finalSummary = appendBookChapters(finalSummary, fullBookResult.chapters);
    }

    // H4 (audit #2): the bookmark row is inserted HERE, server-side,
    // BEFORE the credit is deducted. The browser used to insert it
    // after the response arrived, so a failed browser insert (network
    // / permissions) lost the credit with no card saved. Insert first,
    // deduct second: if the deduct then fails (the balance hit 0 in a
    // race), the row is removed again, so no card exists without
    // payment and no credit is spent without a card.
    let bookmarkId: string | null = null;
    if (!isBookOrDoc) {
      // Double-submit guard: a second request for the same link that
      // arrives while the first is still being analysed must not save
      // (or charge) twice. The pre-analysis check above cannot catch
      // it — the first request had not inserted anything yet.
      const { data: justSaved } = await admin
        .from('bookmarks')
        .select('id')
        .eq('user_id', userId)
        .eq('url', finalUrl)
        .maybeSingle();
      if (justSaved) {
        return NextResponse.json(
          { error: 'DUPLICATE_LINK', remainingCredits: currentCredits },
          { status: 409 }
        );
      }
    }
    const { data: insertedBookmark, error: insertError } = await admin
      .from('bookmarks')
      .insert({
        user_id: userId,
        url: finalUrl,
        title: finalTitle,
        summary: finalSummary,
        category: finalCategory,
        image_url: image,
        checklist: finalChecklist,
        embedding: embedding.length > 0 ? embedding : null,
      })
      .select('id')
      .single();
    if (insertError || !insertedBookmark) {
      console.error('Failed to save bookmark:', insertError?.message);
      return NextResponse.json({ error: 'Could not save bookmark' }, { status: 500 });
    }
    bookmarkId = insertedBookmark.id;

    // Deduct only after a successful AI analysis (see C7 above) AND a
    // saved bookmark row — no credit is spent without a card.
    let updatedCredits = currentCredits;
    if (!isPro) {
      const newCredits = await deductCredit(admin, userId, currentCredits);
      if (newCredits === null) {
        // The balance hit 0 between the check and the deduct: remove
        // the row again so the user keeps no card for a request that
        // could not be paid for.
        await admin.from('bookmarks').delete().eq('id', bookmarkId);
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
      bookmarkId,
    });
  } catch (err: any) {
    // SECURITY (2026-11-24 audit): never return the raw error message to
    // the visitor — it can leak SQL text, table/column names, file paths
    // or stack traces. Details stay in the server log only.
    console.error('Analyze Error:', err);
    return NextResponse.json({ error: 'Failed to analyze content' }, { status: 500 });
  }
}
