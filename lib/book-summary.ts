import { GoogleGenAI, Type } from '@google/genai';
import { generateContentWithFallback } from './gemini';
import type { BookChapterData, BookIdea } from './book-reader';

// Route decision, extracted so the smoke test can prove it (see
// scripts/smoke-book-summary.mjs): EVERY book upload (PDF or Word,
// extracted text or scanned file read by Gemini) and every long
// article takes the full chapter-by-chapter path. Videos, short
// social posts and thin pages keep the single-call short summary.
// `bodyContentLength` is the length of the real text the fetch /
// extraction stage brought back; 0 means "no text at all" (e.g. a
// scanned PDF sent as base64, which Gemini reads itself).
export function shouldUseFullSummary(opts: {
  isBookOrDoc: boolean;
  isFullArticle: boolean;
  bodyContentLength: number;
}): boolean {
  return (opts.isBookOrDoc || opts.isFullArticle) && opts.bodyContentLength > 0;
}

// Length-integrity guard (live-incident fix, 2026-11-27): the
// frontend sends the length of the text it actually put in the
// request (`bookTextLength`). If the server receives materially less,
// the text was cut somewhere between the browser and the server —
// summarising the fragment would silently produce a short "full"
// summary of the beginning of the book only (exactly what happened
// live to «اللغة الشاعرة»: one generic section, 8 ideas, 2 checklist
// items, from a 135,000-character book). Refuse loudly instead of
// saving a misleading summary; the route turns this into 503 with no
// credit deducted. JSON preserves string length exactly, so a 5%
// tolerance is generous.
export function isTruncatedBookText(receivedChars: number, claimedChars: number): boolean {
  if (claimedChars <= 0) return false;
  return receivedChars < claimedChars * 0.95;
}

// FULL-BOOK SUMMARY (2026-11-26): when a book/article is uploaded, the
// site used to send only the first ~14,000 characters to Gemini with a
// "3-sentence summary of the core thesis" prompt, so the result covered
// only the most important ideas of the beginning of the book. The feature
// requested is a COMPREHENSIVE summary of the WHOLE text — every main
// idea, organised chapter by chapter (or section by section for
// articles), so a student can study from it without reading the whole
// thing. Long articles pasted as links (a blog such as Blogger, or any
// other article page) use this same path with kind: 'article'; videos
// and short social posts keep the single-call short summary.
//
// How it works:
// 1. splitBookIntoChapters() finds the book's own chapter headings
//    (الفصل/الباب/المبحث/المقدمة/الخاتمة, numbered headings, "Chapter N",
//    or short standalone lines followed by a long paragraph). When the
//    text has no usable headings it falls back to inline "الفصل X"
//    markers, then to even size-based sections.
// 2. summarizeBookFull() summarises every chapter with Gemini IN
//    PARALLEL (one call per chapter, each with the usual model fallback
//    chain from lib/gemini.ts), then joins the per-chapter results into
//    a single plain-text summary with one block per chapter. Every idea
//    also carries a "detail" paragraph (2-4 sentences from the chapter
//    text), and the structured chapters are returned alongside the
//    plain text so the reader view and the PDF download can open every
//    chapter and every idea.
// 3. The route saves that combined text as the bookmark summary, with
//    the structured chapters appended in the storage envelope (see
//    lib/book-reader.ts), and the per-chapter key ideas (up to 2 per
//    chapter) become the checklist the card already shows in a
//    scrollable list.
//
// Time budget (same rules as PR #5 / PR #6): the chapter calls run in
// parallel, so the wall clock is the slowest call, not the sum. The
// Vercel function allows 60s and the frontend aborts at 55s; a failed
// chapter is retried once only while the request is still young
// (< 25s). If any chapter still fails, the whole analysis fails fast
// with AI_UNAVAILABLE and NO credit is deducted — a partial "full"
// summary would be worse than an honest error, because the student
// would trust it to be complete.

export interface BookChapter {
  title: string;
  text: string;
}

// A book is at most this long after the frontend cap (200,000 chars);
// 10 chapters x 30,000 chars covers a whole typical book. Longer books
// are covered up to this total — see the known limits in the PR.
export const MAX_BOOK_TEXT_CHARS = 200_000;
export const MAX_CHAPTERS = 10;
export const MAX_CHAPTER_CHARS = 30_000;
const MIN_CHAPTER_CHARS = 1_000;
const MAX_IDEAS_PER_CHAPTER = 8;
const MAX_CHECKLIST_ITEMS = 12;
const RETRY_DEADLINE_MS = 25_000;

const ARABIC_ORDINALS =
  'الأول|الثاني|الثالث|الرابع|الخامس|السادس|السابع|الثامن|التاسع|العاشر|' +
  'الحادي عشر|الثاني عشر|الأولى|الثانية|الثالثة|الرابعة|الخامسة|السادسة|' +
  'السابعة|الثامنة|التاسعة|العاشرة';

const CHAPTER_WORDS = 'الفصل|الباب|المبحث|المطلب|المقدمة|الخاتمة|التمهيد|الفاتحة|القسم|الجزء';

// A heading that repeats identically this many times (or more) is the
// book's RUNNING HEADER, not a chapter start: in the OCR text of
// «اللغة الشاعرة» the book title «اللغة الشاعرة» is printed at the top
// of (nearly) every page, so it looks like a heading dozens of times.
// Dropping those lines keeps the split from exploding into dozens of
// one-page "chapters" and crowding out the real chapters. The content
// is NOT lost — it stays inside the surrounding chapter; only the
// chapter title is imperfect for that stretch of the book.
const RUNNING_HEADER_MAX_OCCURRENCES = 5;

// Normalise Arabic for title comparison: OCR variants of the same title
// (e.g. «الشعر العربي» vs «الشعر العريى») must compare equal.
function normalizeHeading(title: string): string {
  return title
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

function genericSectionTitle(index: number, lang: string): string {
  return lang === 'ar' ? `القسم ${index + 1}` : `Section ${index + 1}`;
}

function looksLikeHeading(line: string, nextLine: string | undefined): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 70) return false;
  // Explicit chapter/part words: الفصل الأول، الباب الثاني، المقدمة، الخاتمة...
  if (new RegExp(`^(${CHAPTER_WORDS})\\b`).test(t)) return true;
  if (/^(Chapter|Part|Section)\s+\d+/i.test(t)) return true;
  // Numbered heading: "1. المقدمة" / "(2) لغة التعبير" / "3- الشعر"
  if (/^[\(]?\d{1,2}[\)\].:—-]\s+\S/.test(t)) return true;
  // Short standalone line with no sentence-ending punctuation, followed
  // by a long paragraph — the shape of a real book heading (e.g. the
  // chapter titles of «اللغة الشاعرة»: "لغة التعبير"، "الشعر ديوان العرب").
  // The "long next line" guard keeps short verse lines in poetry books
  // from being mistaken for headings. (Tried measuring the next 3 lines
  // combined instead — it promoted verse lines and subsection headings
  // to chapters in the Word file and crowded out real chapters, so the
  // single-line guard stays. Narrow-layout PDFs therefore split into
  // generic size sections with full coverage instead of real titles —
  // see the smoke test section 18 note.)
  if (
    t.length <= 45 &&
    !/[.!؟:؛]$/.test(t) &&
    nextLine !== undefined &&
    nextLine.trim().length > 200
  ) {
    return true;
  }
  return false;
}

function truncateChapter(text: string): string {
  const t = text.trim();
  if (t.length <= MAX_CHAPTER_CHARS) return t;
  const cut = t.slice(0, MAX_CHAPTER_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MAX_CHAPTER_CHARS * 0.8 ? cut.slice(0, lastSpace) : cut).trim();
}

function mergeTinyChapters(chapters: BookChapter[]): BookChapter[] {
  const merged: BookChapter[] = [];
  for (const chapter of chapters) {
    const last = merged[merged.length - 1];
    if (last && last.text.length < MIN_CHAPTER_CHARS) {
      // The previous chapter is tiny (e.g. front matter before the
      // first real heading): it joins the NEXT chapter and the next
      // chapter's title wins. The old code did the opposite — it
      // appended the next chapter's text to the tiny one, so a 44-char
      // generic "القسم 1" front-matter piece swallowed an entire
      // 140,000-char PDF book, and the summary covered only its
      // beginning (the chapter was then truncated to 30,000 chars).
      merged[merged.length - 1] = {
        title: chapter.title,
        text: `${last.text}\n${chapter.text}`.trim(),
      };
    } else if (chapter.text.length < MIN_CHAPTER_CHARS && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.text = `${prev.text}\n${chapter.text}`.trim();
    } else {
      merged.push({ ...chapter });
    }
  }
  return merged;
}

function mergeDownToMax(chapters: BookChapter[]): BookChapter[] {
  const list = [...chapters];
  while (list.length > MAX_CHAPTERS) {
    // Merge the smallest chapter into its smaller neighbour.
    let smallest = 0;
    for (let i = 1; i < list.length; i++) {
      if (list[i].text.length < list[smallest].text.length) smallest = i;
    }
    if (smallest === 0) {
      list[1].text = `${list[0].text}\n${list[1].text}`.trim();
      list.splice(0, 1);
    } else {
      const into = list[smallest - 1].text.length <= (list[smallest + 1]?.text.length ?? Infinity)
        ? smallest - 1
        : smallest + 1;
      if (into < smallest) {
        list[into].text = `${list[into].text}\n${list[smallest].text}`.trim();
      } else {
        list[into].text = `${list[smallest].text}\n${list[into].text}`.trim();
      }
      list.splice(smallest, 1);
    }
  }
  return list;
}

// Merge chapters that share a title back-to-back: a chapter heading
// that also serves as the running header inside its own chapter (e.g.
// «الزمن في اللغة العربية» printed at the top of its pages) splits one
// real chapter into several same-titled pieces — join them again.
function mergeAdjacentSameTitle(chapters: BookChapter[]): BookChapter[] {
  const merged: BookChapter[] = [];
  for (const chapter of chapters) {
    const last = merged[merged.length - 1];
    if (last && normalizeHeading(last.title) === normalizeHeading(chapter.title)) {
      last.text = `${last.text}\n${chapter.text}`.trim();
    } else {
      merged.push({ ...chapter });
    }
  }
  return merged;
}

function finalizeChapters(chapters: BookChapter[]): BookChapter[] {
  return mergeDownToMax(mergeAdjacentSameTitle(mergeTinyChapters(chapters))).map(
    (c) => ({ title: c.title, text: truncateChapter(c.text) })
  );
}

// Split on explicit "الفصل X" / "الباب X" markers inside flat text (PDF
// text extraction joins a page into one line, so headings often survive
// only as inline markers). Returns null when fewer than 2 markers exist.
function splitOnInlineMarkers(text: string): BookChapter[] | null {
  const marker = new RegExp(
    `(${CHAPTER_WORDS})\\s+(${ARABIC_ORDINALS}|\\d{1,2})`,
    'g'
  );
  const matches = [...text.matchAll(marker)];
  if (matches.length < 2) return null;
  const chapters: BookChapter[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
    const body = text.slice(start, end).trim();
    // Title = the marker plus the next few words (the heading text).
    const after = body.slice(matches[i][0].length).trim();
    const titleWords = after.split(/\s+/).slice(0, 6).join(' ');
    const title = `${matches[i][0]} ${titleWords}`.replace(/[.!؟:؛]+$/, '').trim();
    chapters.push({ title: title || matches[i][0], text: body });
  }
  return chapters;
}

function splitIntoSizeSections(text: string, lang: string): BookChapter[] {
  const SECTION_CHARS = 8_000;
  const sections: BookChapter[] = [];
  let rest = text.trim();
  let index = 0;
  while (rest.length > 0) {
    if (rest.length <= SECTION_CHARS) {
      sections.push({ title: genericSectionTitle(index, lang), text: rest });
      break;
    }
    const cut = rest.slice(0, SECTION_CHARS);
    // Prefer a sentence boundary near the end of the chunk.
    const boundary = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('. '),
      cut.lastIndexOf('؟ '),
      cut.lastIndexOf('! ')
    );
    const splitAt = boundary > SECTION_CHARS * 0.6 ? boundary + 1 : cut.lastIndexOf(' ');
    const take = splitAt > 0 ? splitAt : SECTION_CHARS;
    sections.push({
      title: genericSectionTitle(index, lang),
      text: rest.slice(0, take).trim(),
    });
    rest = rest.slice(take).trim();
    index++;
  }
  return sections;
}

export function splitBookIntoChapters(text: string, lang: string): BookChapter[] {
  // NFKC first: Arabic PDFs often store their text in presentation
  // forms (shaped glyphs, e.g. ﺍﻟﻠﻐﺔ instead of اللغة), which the
  // heading regexes below cannot match — normalising turns them back
  // into standard letters, so a PDF book splits on its real headings
  // instead of falling back to generic size sections. It is a no-op
  // for Word text (mammoth already returns standard letters), and
  // the normalised text is also what Gemini receives (better input).
  const clean = text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim();
  if (!clean) return [];

  // 1) Line-based headings (Word files keep paragraph breaks).
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  // Running-header suppression: count how often each candidate heading
  // title repeats, and ignore titles that repeat past the running-header
  // threshold (see RUNNING_HEADER_MAX_OCCURRENCES).
  const titleCounts = new Map<string, number>();
  const isCandidate: boolean[] = lines.map((line, i) => {
    const candidate = looksLikeHeading(line, lines[i + 1]);
    if (candidate) {
      const key = normalizeHeading(line);
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    return candidate;
  });
  const chapters: BookChapter[] = [];
  let currentTitle: string | null = null;
  let currentText: string[] = [];
  const flush = () => {
    const body = currentText.join('\n').trim();
    if (body) {
      chapters.push({
        title: currentTitle ?? genericSectionTitle(chapters.length, lang),
        text: body,
      });
    }
    currentText = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isRealHeading =
      isCandidate[i] &&
      (titleCounts.get(normalizeHeading(line)) ?? 0) <= RUNNING_HEADER_MAX_OCCURRENCES;
    if (isRealHeading) {
      flush();
      currentTitle = line;
    } else {
      currentText.push(line);
    }
  }
  flush();
  // A split only counts if it still leaves at least 2 chapters after
  // merging: when the line-based pass finds a single real heading
  // (e.g. a PDF book whose pages join into one long line each, with
  // only the title page as a "heading"), merging collapses everything
  // into one giant chapter — and that chapter is then truncated to
  // 30,000 chars, so the summary covers only the beginning of the
  // book. Fall through to the size-section fallback instead, so the
  // whole book is covered.
  if (chapters.length >= 2) {
    const finalized = finalizeChapters(chapters);
    if (finalized.length >= 2) return finalized;
  }

  // 2) Inline "الفصل X" markers (flat PDF text).
  const inline = splitOnInlineMarkers(clean);
  if (inline && inline.length >= 2) {
    const finalized = finalizeChapters(inline);
    if (finalized.length >= 2) return finalized;
  }

  // 3) No headings at all: even sections, so the whole book is still
  // covered instead of only its beginning.
  return finalizeChapters(splitIntoSizeSections(clean, lang));
}

interface ChapterSummary {
  title: string;
  ideas: BookIdea[];
}

async function summarizeChapter(
  ai: GoogleGenAI,
  chapter: BookChapter,
  lang: string,
  kind: 'book' | 'article' = 'book'
): Promise<ChapterSummary> {
  const langInstruction =
    lang === 'ar'
      ? 'Write the chapter title and ideas in clear, eloquent Arabic.'
      : lang === 'tr'
        ? 'Write the chapter title and ideas in clear, natural Turkish.'
        : 'Write the chapter title and ideas in clear, natural English.';

  const response = await generateContentWithFallback(ai, {
    contents: `Summarize ONLY this ${kind === 'article' ? 'section of an article' : 'chapter/section of a book'}. Extract:
1. The ${kind === 'article' ? 'section' : 'chapter'} title (use the heading provided below; clean it up if needed).
2. ALL main ideas of this ${kind === 'article' ? 'section' : 'chapter'}: every key idea, argument, example and conclusion — ${MAX_IDEAS_PER_CHAPTER} ideas at most. For EACH idea give two fields:
   - "text": the idea itself in 1-2 sentences.
   - "detail": a detailed explanation of this idea in 2-4 sentences, drawn ONLY from the ${kind === 'article' ? 'section' : 'chapter'} text below (the author's examples, evidence and steps). This detail is what the reader sees when they open the idea, so it must stand on its own.
3. Do NOT invent ideas or details that are not in the text below. Do NOT add content from other ${kind === 'article' ? 'sections' : 'chapters'}.

${langInstruction}

${kind === 'article' ? 'Section' : 'Chapter'} heading: ${chapter.title}
${kind === 'article' ? 'Section' : 'Chapter'} text: ${chapter.text}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          ideas: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING },
                detail: { type: Type.STRING },
              },
              required: ['text', 'detail'],
            },
          },
        },
        required: ['title', 'ideas'],
      },
    },
  });

  const parsed = JSON.parse(response.text || '{}');
  const ideas = toBookIdeas(Array.isArray(parsed.ideas) ? parsed.ideas : []);
  if (ideas.length === 0) {
    throw new Error('Chapter summary came back empty');
  }
  return {
    title: String(parsed.title || chapter.title).trim(),
    ideas: ideas.slice(0, MAX_IDEAS_PER_CHAPTER),
  };
}

// Normalize the model's ideas into {text, detail} pairs. The model
// sometimes returns a plain string instead of an object for an idea;
// accept it and use the idea itself as its detail so the reader never
// opens an empty view. Shared by the per-chapter summariser and the
// scanned-book summariser below.
function toBookIdeas(rawIdeas: unknown[]): BookIdea[] {
  return rawIdeas
    .map((raw): BookIdea | null => {
      if (typeof raw === 'string') {
        const text = raw.trim();
        return text ? { text, detail: text } : null;
      }
      if (raw && typeof raw === 'object') {
        const text = String((raw as { text?: unknown }).text || '').trim();
        const detail = String(
          (raw as { detail?: unknown }).detail || ''
        ).trim();
        if (!text) return null;
        return { text, detail: detail || text };
      }
      return null;
    })
    .filter((idea): idea is BookIdea => idea !== null);
}

export async function summarizeBookFull(
  ai: GoogleGenAI,
  opts: { text: string; lang: string; requestStartedAt: number; kind?: 'book' | 'article' }
): Promise<{ summary: string; checklist: string[]; chapters: BookChapterData[] }> {
  const kind = opts.kind ?? 'book';
  const chapters = splitBookIntoChapters(opts.text, opts.lang);
  if (chapters.length === 0) {
    throw new Error('No book content to summarize');
  }

  // All chapters in parallel: the wall clock is the slowest call, not
  // the sum — one sequential pass over 8 chapters would blow the 55s
  // frontend abort. Each call carries its own model fallback chain.
  const results = await Promise.allSettled(
    chapters.map((chapter) => summarizeChapter(ai, chapter, opts.lang, kind))
  );
  let failed = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result.status === 'rejected');

  // One retry round for failed chapters, only while the request is still
  // young — retrying after ~25s would run into the frontend abort.
  if (failed.length > 0 && Date.now() - opts.requestStartedAt < RETRY_DEADLINE_MS) {
    const retries = await Promise.allSettled(
      failed.map(({ index }) => summarizeChapter(ai, chapters[index], opts.lang, kind))
    );
    retries.forEach((retry, i) => {
      if (retry.status === 'fulfilled') {
        results[failed[i].index] = retry;
      }
    });
    failed = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === 'rejected');
  }

  // Fail fast, like PR #5/#6: a "full" summary missing a chapter would
  // mislead the student into trusting it is complete. The route turns
  // this into 503 AI_UNAVAILABLE with no credit deducted.
  if (failed.length > 0) {
    throw new Error(
      `Could not summarize ${failed.length} of ${chapters.length} ${kind === 'article' ? 'sections' : 'chapters'}`
    );
  }

  const summaries = results.map((result) => {
    if (result.status !== 'fulfilled') throw new Error('Unexpected chapter failure');
    return result.value;
  });

  // Plain text with one block per chapter: the library card renders the
  // summary as plain text (whitespace-pre-line in the PDF export), so no
  // Markdown headings — chapter titles on their own lines, ideas as
  // bullet points underneath. The structured chapters (with each idea's
  // detail) travel with it in the storage envelope — see
  // lib/book-reader.ts — so the reader view and the PDF download can
  // open every chapter and every idea.
  const summary = summaries
    .map(
      (chapter) =>
        `${chapter.title}\n${chapter.ideas.map((idea) => `• ${idea.text}`).join('\n')}`
    )
    .join('\n\n');

  // The card shows the checklist in a scrollable list, so the key ideas
  // stay visible even though the card clamps the summary text.
  const checklist: string[] = [];
  for (const chapter of summaries) {
    for (const idea of chapter.ideas.slice(0, 2)) {
      if (checklist.length >= MAX_CHECKLIST_ITEMS) break;
      checklist.push(idea.text);
    }
    if (checklist.length >= MAX_CHECKLIST_ITEMS) break;
  }

  const chapterData: BookChapterData[] = summaries.map((chapter) => ({
    title: chapter.title,
    ideas: chapter.ideas,
  }));

  return { summary, checklist, chapters: chapterData };
}

// SCANNED BOOK (2026-11-27): a scanned / image PDF has no text layer,
// so the chapter splitter cannot run on it — the browser sends it to
// Gemini as base64 instead. Ask Gemini to read the PDF itself and
// return a structured chapter-by-chapter summary in ONE call, in the
// same shape as the text path (chapters with ideas + details), so a
// scanned book gets the same reader view and PDF download as a text
// book. The output is bounded (10 chapters, 4 ideas each) to stay
// inside the model's output limit.
//
// Returns null (never throws for a bad model answer) when the model
// answer cannot be used — the route falls back to the short summary
// for that book, so a scanned book is never worse off than before.
// An AI outage still throws, like everywhere else, and the route
// turns it into 503 with no credit deducted.
export async function summarizeScannedBook(
  ai: GoogleGenAI,
  opts: { base64: string; mimeType: string; lang: string }
): Promise<{ summary: string; checklist: string[]; chapters: BookChapterData[] } | null> {
  const langInstruction =
    opts.lang === 'ar'
      ? 'Write the chapter titles and ideas in clear, eloquent Arabic.'
      : opts.lang === 'tr'
        ? 'Write the chapter titles and ideas in clear, natural Turkish.'
        : 'Write the chapter titles and ideas in clear, natural English.';

  let response;
  try {
    response = await generateContentWithFallback(ai, {
      contents: [
        {
          text: `Read this scanned book (a PDF file, attached below) and summarise it chapter by chapter. Extract:
1. Up to 10 chapters, in the order they appear in the book, with their real titles.
2. For EACH chapter, up to 4 main ideas. For EACH idea give two fields:
   - "text": the idea itself in 1-2 sentences.
   - "detail": a detailed explanation of this idea in 2-3 sentences, drawn ONLY from the book (the author's examples, evidence and steps). This detail is what the reader sees when they open the idea, so it must stand on its own.
3. Do NOT invent chapters, ideas or details that are not in the book. If a chapter has fewer than 4 main ideas, return only the real ones.

${langInstruction}`,
        },
        { inlineData: { mimeType: opts.mimeType, data: opts.base64 } },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            chapters: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  ideas: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        text: { type: Type.STRING },
                        detail: { type: Type.STRING },
                      },
                      required: ['text', 'detail'],
                    },
                  },
                },
                required: ['title', 'ideas'],
              },
            },
          },
          required: ['chapters'],
        },
      },
    });
  } catch (error) {
    console.warn('Scanned book structured summary failed:', error);
    return null;
  }

  try {
    const parsed = JSON.parse(response.text || '{}');
    const rawChapters: unknown[] = Array.isArray(parsed.chapters) ? parsed.chapters : [];
    const chapters: BookChapterData[] = rawChapters
      .map((raw): BookChapterData | null => {
        if (!raw || typeof raw !== 'object') return null;
        const title = String((raw as { title?: unknown }).title || '').trim();
        const ideas = toBookIdeas(
          Array.isArray((raw as { ideas?: unknown }).ideas)
            ? ((raw as { ideas?: unknown }).ideas as unknown[])
            : []
        ).slice(0, MAX_IDEAS_PER_CHAPTER);
        if (!title || ideas.length === 0) return null;
        return { title, ideas };
      })
      .filter((chapter): chapter is BookChapterData => chapter !== null)
      .slice(0, 10);
    if (chapters.length === 0) {
      console.warn('Scanned book structured summary came back empty');
      return null;
    }

    const summary = chapters
      .map(
        (chapter) =>
          `${chapter.title}\n${chapter.ideas.map((idea) => `• ${idea.text}`).join('\n')}`
      )
      .join('\n\n');
    const checklist: string[] = [];
    for (const chapter of chapters) {
      for (const idea of chapter.ideas.slice(0, 2)) {
        if (checklist.length >= MAX_CHECKLIST_ITEMS) break;
        checklist.push(idea.text);
      }
      if (checklist.length >= MAX_CHECKLIST_ITEMS) break;
    }
    return { summary, checklist, chapters };
  } catch (error) {
    console.warn('Scanned book structured summary was not valid JSON:', error);
    return null;
  }
}
